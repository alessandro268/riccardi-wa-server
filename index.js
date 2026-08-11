const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rmnxrepcsohhwnnlwnwn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtbnhyZXBjc29oaHdubmx3bnduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMDk0MTIsImV4cCI6MjA5NjU4NTQxMn0.O5-kQmpMDfsU79LMP_LyUbLVfY880jAtuUG278PGCvw';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const NOTIFY_PHONE = process.env.NOTIFY_PHONE || ''; // your personal number e.g. 393331234567

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// TWO CLIENT SETUP
// ============================================================
const clients = {
  business: { sock: null, qr: null, status: 'initializing', label: 'Business (Lead)' },
  personal: { sock: null, qr: null, status: 'initializing', label: 'Personale (Agente)' }
};

// Pending approvals: phone -> { message, leadId, leadName, timer }
const pendingApprovals = {};

async function connectClient(key, authDir) {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, authDir));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Riccardi CRM ' + key, 'Chrome', '120.0.0'],
  });

  clients[key].sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      clients[key].status = 'qr_ready';
      try { clients[key].qr = await QRCode.toDataURL(qr); } catch(e) {}
      console.log(`[${key}] QR ready`);
    }
    if (connection === 'close') {
      clients[key].status = 'disconnected';
      clients[key].qr = null;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(() => connectClient(key, authDir), 5000);
    } else if (connection === 'open') {
      clients[key].status = 'ready';
      clients[key].qr = null;
      console.log(`[${key}] Connected!`);
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      let jid = msg.key.remoteJid;
      if (!jid || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) continue;

      // WhatsApp sta migrando alcuni contatti a un identificativo "LID" (@lid) al posto del
      // numero di telefono, per privacy. Quando succede, Baileys fornisce quasi sempre anche
      // l'identificativo "alternativo" basato sul vero numero (remoteJidAlt) — lo usiamo se c'è,
      // altrimenti il numero non è ricavabile e il messaggio resta senza lead abbinato (ma non
      // viene comunque perso: si vede lo stesso nell'Inbox "Non nel CRM").
      if (jid.includes('@lid') && msg.key.remoteJidAlt) {
        jid = msg.key.remoteJidAlt;
      }

      const phone = jid.includes('@lid') ? jid.replace('@lid', '').replace(/\D/g, '') : jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      // Se il numero non è stato risolto (jid è ancora un LID), il valore sopra NON è un vero
      // numero di telefono, ma un identificativo interno — lo teniamo comunque come "segnaposto"
      // così i messaggi dello stesso contatto restano raggruppati insieme nell'Inbox invece di
      // mischiarsi con quelli di altri contatti non risolti. isRealPhone lo dice al resto del codice.
      const isRealPhone = !jid.includes('@lid');
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '[Media]';
      const senderName = msg.pushName || (isRealPhone ? phone : jid);

      if (key === 'business') {
        await handleLeadMessage(phone, body, senderName, jid, isRealPhone);
      } else if (key === 'personal') {
        await handleAgentReply(phone, body, jid);
      }
    }
  });
}

// ============================================================
// HANDLE INCOMING LEAD MESSAGE (business number)
// ============================================================
async function handleLeadMessage(phone, body, senderName, jid, isRealPhone) {
  console.log(`[LEAD] ${senderName} (${isRealPhone ? phone : 'LID non risolto: ' + phone}): ${body.slice(0, 50)}`);

  try {
    // Cerchiamo un lead SOLO se questo è davvero un numero di telefono (non un segnaposto LID)
    // e abbiamo almeno 9 cifre valide da confrontare. Senza questi controlli, un numero troppo
    // corto/vuoto produrrebbe una ricerca "%%%" che in SQL corrisponde A QUALSIASI lead nel
    // database, abbinando il messaggio al primo che capita — il bug corretto in precedenza.
    const last9 = (phone || '').slice(-9);
    let lead = null;
    if (isRealPhone && last9.length === 9) {
      const { data: leads } = await supabase
        .from('leads')
        .select('*')
        .or(`phone.ilike.%${last9}%`)
        .limit(1);
      lead = leads && leads[0] ? leads[0] : null;
    }

    const timestamp = new Date().toISOString();

    // Save message to DB
    await supabase.from('wa_messages').insert({
      phone: phone || null, sender_name: senderName, body,
      lead_id: lead ? lead.id : null,
      direction: 'inbound', timestamp, read: false, is_ai: false
    });

    // Notifica push SOLO se il mittente è un lead già presente nel CRM — mai per numeri
    // sconosciuti, e mai per Stati/gruppi (già esclusi più sopra, prima di arrivare qui).
    if (lead) {
      fetch('https://lucent-longma-318cfc.netlify.app/.netlify/functions/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '💬 ' + lead.name,
          body: body.slice(0, 120),
          url: '/',
          tag: 'lead-' + lead.id,
        }),
      }).catch((e) => console.error('[push] Errore invio notifica:', e.message));
    }

    // Update lead conversation
    if (lead) {
      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] ${senderName}: ${body}`;
      await supabase.from('leads').update({
        conversation: (lead.conversation || '') + newEntry
      }).eq('id', lead.id);
    }

    // Check autopilot
    if (lead && lead.meta) {
      try {
        const meta = JSON.parse(lead.meta);
        if (meta.waMode === 'autopilot') {
          await handleAutopilot(lead, body, jid);
          return;
        }
      } catch(e) {}
    }

    // COPILOT: notify personal number
    if (NOTIFY_PHONE && clients.personal.status === 'ready') {
      await notifyAgent(lead, body, senderName, phone, jid);
    }

  } catch(e) {
    console.error('handleLeadMessage error:', e.message);
  }
}

// ============================================================
// NOTIFY AGENT (send to personal number)
// ============================================================
async function notifyAgent(lead, incomingMsg, senderName, phone, leadJid) {
  try {
    const aiSuggestion = await generateAIResponse(lead, incomingMsg);

    // Build lead summary
    let summary = '';
    if (lead) {
      const funnel = [];
      if (lead.msg1_sent) funnel.push('MSG-01 inviato');
      if (lead.msg1_replied) funnel.push('ha risposto');
      if (lead.discovery_call) funnel.push('call fatta');
      if (lead.videocall_booked) funnel.push('videocall fissata');
      const history = lead.conversation ? lead.conversation.split('\n').filter(l => l.trim()).slice(-3).join(' | ') : 'Nessuno storico';
      summary = `👤 *${lead.name}* | ${lead.service} | ${(lead.funnel_type||'guida_ads').replace('_',' ')} | ${lead.temp === 'hot' ? '🔴' : lead.temp === 'warm' ? '🟡' : '⚪'}
📋 *Storia:* ${funnel.length ? funnel.join(' → ') : 'Nuovo lead'}
💬 *Storico recente:* ${history}`;
    } else {
      summary = `👤 *${senderName}* (${phone}) — lead non trovata nel CRM`;
    }

    const notifyMsg = `${summary}

📨 *Messaggio ricevuto:*
"${incomingMsg}"

💡 *Risposta suggerita:*
"${aiSuggestion}"

_Rispondi *SI* per inviare, *NO* per saltare, o scrivi il tuo messaggio alternativo._`;

    const notifyJid = NOTIFY_PHONE + '@s.whatsapp.net';
    await clients.personal.sock.sendMessage(notifyJid, { text: notifyMsg });

    // Store pending approval
    pendingApprovals[NOTIFY_PHONE] = {
      leadJid,
      leadId: lead ? lead.id : null,
      leadName: lead ? lead.name : senderName,
      suggestedMsg: aiSuggestion,
      phone,
      timestamp: Date.now(),
    };

    // Auto-send after 1 hour if no response
    setTimeout(async () => {
      if (pendingApprovals[NOTIFY_PHONE] && pendingApprovals[NOTIFY_PHONE].leadJid === leadJid) {
        console.log(`[AUTOPILOT FALLBACK] No response after 1h, sending AI message to ${leadJid}`);
        await sendToLead(leadJid, aiSuggestion, lead, true);
        delete pendingApprovals[NOTIFY_PHONE];
        // Notify that auto-sent
        if (clients.personal.status === 'ready') {
          await clients.personal.sock.sendMessage(notifyJid, {
            text: `⏰ *Auto-inviato dopo 1h* a ${lead ? lead.name : phone}:\n"${aiSuggestion}"`
          });
        }
      }
    }, 60 * 60 * 1000); // 1 hour

  } catch(e) {
    console.error('notifyAgent error:', e.message);
  }
}

// ============================================================
// HANDLE AGENT REPLY (personal number responds)
// ============================================================
async function handleAgentReply(phone, body, jid) {
  // Only process if from notify phone
  if (phone !== NOTIFY_PHONE.replace(/\D/g, '')) return;

  const pending = pendingApprovals[NOTIFY_PHONE];
  if (!pending) {
    console.log('[AGENT] No pending approval');
    return;
  }

  const upper = body.trim().toUpperCase();
  let msgToSend = null;
  let action = '';

  if (upper === 'SI' || upper === 'SÌ' || upper === 'S') {
    msgToSend = pending.suggestedMsg;
    action = 'approvato';
  } else if (upper === 'NO' || upper === 'N') {
    delete pendingApprovals[NOTIFY_PHONE];
    await clients.personal.sock.sendMessage(jid, { text: `✅ Messaggio saltato per ${pending.leadName}` });
    return;
  } else {
    // Custom message
    msgToSend = body.trim();
    action = 'personalizzato';
  }

  if (msgToSend) {
    await sendToLead(pending.leadJid, msgToSend, { id: pending.leadId, name: pending.leadName }, false);
    delete pendingApprovals[NOTIFY_PHONE];

    // Confirm to agent
    await clients.personal.sock.sendMessage(jid, {
      text: `✅ Messaggio ${action} inviato a *${pending.leadName}*:\n"${msgToSend}"`
    });

    // Save to knowledge if custom
    if (action === 'personalizzato' && pending.leadId) {
      await supabase.from('knowledge').insert({
        service: 'ProfitCare',
        situazione: pending.originalMsg || '',
        risposta_ai: pending.suggestedMsg,
        risposta_tua: msgToSend,
        contesto: 'Approvato manualmente da Alessandro',
        efficace: true
      });
    }
  }
}

// ============================================================
// SEND MESSAGE TO LEAD
// ============================================================
async function sendToLead(jid, message, lead, isAI) {
  if (!clients.business.sock || clients.business.status !== 'ready') {
    console.error('Business client not ready');
    return;
  }
  try {
    await clients.business.sock.sendMessage(jid, { text: message });
    const phone = jid.replace('@s.whatsapp.net', '');
    await supabase.from('wa_messages').insert({
      phone, sender_name: isAI ? 'Alessandro (AI)' : 'Alessandro',
      body: message, lead_id: lead ? lead.id : null,
      direction: 'outbound', timestamp: new Date().toISOString(),
      read: true, is_ai: isAI
    });
    if (lead && lead.id) {
      const { data: ld } = await supabase.from('leads').select('conversation').eq('id', lead.id).single();
      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] Alessandro${isAI?' (AI)':''}: ${message}`;
      await supabase.from('leads').update({ conversation: (ld?.conversation||'') + newEntry }).eq('id', lead.id);
    }
  } catch(e) { console.error('sendToLead error:', e.message); }
}

// ============================================================
// AI RESPONSE GENERATION
// ============================================================
async function generateAIResponse(lead, incomingMsg) {
  try {
    const { data: kb } = await supabase.from('knowledge').select('*')
      .eq('service', lead ? lead.service : 'ProfitCare')
      .eq('efficace', true).order('created_at', { ascending: false }).limit(3);

    const kbCtx = kb && kb.length
      ? ' Risposte efficaci: ' + kb.map(k => k.risposta_tua.slice(0, 80)).join(' | ')
      : '';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 250,
        system: `Sei Alessandro di Riccardi Properties. Scrivi SOLO il messaggio WhatsApp. Obiettivo: fissare call o videocall. MAI mandare link prima della call. MAI rispondere a obiezioni di prezzo per iscritto. Tono caldo e professionale.${kbCtx}`,
        messages: [{
          role: 'user',
          content: `Lead: ${lead ? lead.name : 'Sconosciuto'} | Servizio: ${lead ? lead.service : ''} | Flusso: ${lead ? (lead.funnel_type || 'guida_ads') : ''}\nMessaggio ricevuto: ${incomingMsg}\nStorico: ${lead && lead.conversation ? lead.conversation.slice(-300) : 'Nessuno'}\nRispondi.`
        }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || 'Grazie per il messaggio! Ti ricontatto a breve.';
  } catch(e) {
    return 'Grazie per il messaggio! Ti ricontatto a breve.';
  }
}

// ============================================================
// AUTOPILOT
// ============================================================
async function handleAutopilot(lead, incomingMsg, jid) {
  const response = await generateAIResponse(lead, incomingMsg);
  if (response) await sendToLead(jid, response, lead, true);
}

// ============================================================
// API ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Riccardi WA Server</title>
  <style>body{font-family:sans-serif;background:#1A1A2E;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:#3B0051;border-radius:12px;padding:24px;margin:10px;text-align:center;min-width:280px;}
  .status{font-size:13px;margin-top:8px;color:rgba(255,255,255,0.7);}
  .btn{display:inline-block;margin-top:12px;padding:8px 20px;border-radius:20px;background:#FF004F;color:#fff;text-decoration:none;font-weight:600;font-size:13px;}
  h1{margin-bottom:20px;font-size:22px;}</style></head>
  <body><h1>🟣 Riccardi WA Server</h1>
  <div style="display:flex;flex-wrap:wrap;justify-content:center;">
  <div class="card"><div style="font-size:20px">📱 Numero Business</div>
  <div class="status">Stato: <strong>${clients.business.status}</strong></div>
  <a href="/qr-page/business" class="btn">Mostra QR Business</a></div>
  <div class="card"><div style="font-size:20px">👤 Numero Personale (Agente)</div>
  <div class="status">Stato: <strong>${clients.personal.status}</strong></div>
  <a href="/qr-page/personal" class="btn">Mostra QR Personale</a></div>
  </div></body></html>`);
});

app.get('/qr-page/:type', async (req, res) => {
  const type = req.params.type === 'personal' ? 'personal' : 'business';
  const qrEndpoint = type === 'personal' ? '/qr2' : '/qr';
  const label = type === 'personal' ? 'Numero Personale (Agente)' : 'Numero Business (Lead)';
  const client = clients[type];
  
  let qrHtml = '';
  if (client.status === 'ready') {
    qrHtml = '<div style="background:#01C38D;padding:16px;border-radius:10px;font-size:16px;font-weight:700;">✅ Già connesso!</div>';
  } else if (client.qr) {
    qrHtml = `<img src="${client.qr}" style="width:250px;height:250px;border-radius:10px;background:#fff;padding:8px;">
    <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:10px;">Apri WhatsApp → Menu → Dispositivi collegati → Collega dispositivo</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:6px;">Questa pagina si aggiorna automaticamente ogni 5 secondi</div>`;
  } else {
    qrHtml = '<div style="color:rgba(255,255,255,0.7)">⏳ QR in generazione... ricarica tra qualche secondo</div>';
  }
  
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <title>QR - ${label}</title>
  <style>body{font-family:sans-serif;background:#1A1A2E;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;}
  h2{margin-bottom:20px;}</style></head>
  <body><h2>📱 ${label}</h2>${qrHtml}
  <a href="/" style="margin-top:20px;color:rgba(255,255,255,0.5);font-size:12px;">← Torna alla home</a>
  </body></html>`);
});
app.get('/status', (req, res) => res.json({ status: clients.business.status, ready: clients.business.status === 'ready', personal: clients.personal.status }));

app.get('/qr', (req, res) => {
  if (clients.business.qr) return res.json({ qr: clients.business.qr });
  if (clients.business.status === 'ready') return res.json({ status: 'already_connected' });
  return res.json({ status: clients.business.status });
});

app.get('/qr2', (req, res) => {
  if (clients.personal.qr) return res.json({ qr: clients.personal.qr });
  if (clients.personal.status === 'ready') return res.json({ status: 'already_connected' });
  return res.json({ status: clients.personal.status });
});

app.post('/send', async (req, res) => {
  if (clients.business.status !== 'ready') return res.status(503).json({ error: 'Business WhatsApp not ready' });
  const { phone, message, leadId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    const lead = leadId ? { id: leadId } : null;
    await sendToLead(jid, message, lead, false);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/messages/:leadId', async (req, res) => {
  try {
    const { data } = await supabase.from('wa_messages').select('*')
      .eq('lead_id', req.params.leadId).order('timestamp', { ascending: true });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/messages/:leadId/read', async (req, res) => {
  await supabase.from('wa_messages').update({ read: true }).eq('lead_id', req.params.leadId);
  res.json({ success: true });
});

app.get('/pending', (req, res) => res.json(pendingApprovals));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Keep alive
setInterval(async () => {
  try {
    await fetch(`http://localhost:${PORT}/status`);
    console.log(`[Keep-alive] business:${clients.business.status} personal:${clients.personal.status}`);
  } catch(e) {}
}, 4 * 60 * 1000);

// Start both clients
connectClient('business', 'auth_business');
connectClient('personal', 'auth_personal');
