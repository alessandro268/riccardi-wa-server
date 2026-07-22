const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rmnxrepcsohhwnnlwnwn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtbnhyZXBjc29oaHdubmx3bnduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMDk0MTIsImV4cCI6MjA5NjU4NTQxMn0.O5-kQmpMDfsU79LMP_LyUbLVfY880jAtuUG278PGCvw';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let qrCodeData = null;
let clientStatus = 'initializing';

const AUTH_DIR = path.join(__dirname, 'auth_info');

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Riccardi Properties CRM', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR received');
      clientStatus = 'qr_ready';
      try {
        qrCodeData = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error('QR error:', e);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log('Connection closed, reconnecting:', shouldReconnect);
      clientStatus = 'disconnected';
      qrCodeData = null;

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connected!');
      clientStatus = 'ready';
      qrCodeData = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.includes('@g.us')) continue; // skip groups

      const phone = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      const body = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || '[Media]';
      const senderName = msg.pushName || phone;
      const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();

      console.log(`Message from ${senderName} (${phone}): ${body.slice(0, 50)}`);

      try {
        // Find lead by phone
        const { data: leads } = await supabase
          .from('leads')
          .select('*')
          .or(`phone.ilike.%${phone.slice(-9)}%`)
          .limit(1);

        let leadId = null;
        if (leads && leads.length > 0) {
          leadId = leads[0].id;
          const existingConv = leads[0].conversation || '';
          const newEntry = `\n[${new Date().toLocaleString('it-IT')}] ${senderName}: ${body}`;
          await supabase.from('leads').update({
            conversation: existingConv + newEntry
          }).eq('id', leadId);
        }

        // Save message
        await supabase.from('wa_messages').insert({
          phone,
          sender_name: senderName,
          body,
          lead_id: leadId,
          direction: 'inbound',
          timestamp,
          read: false,
          is_ai: false
        });

        // Check autopilot
        if (leads && leads.length > 0 && leads[0].meta) {
          try {
            const meta = JSON.parse(leads[0].meta);
            if (meta.waMode === 'autopilot') {
              await handleAutopilot(leads[0], body, jid);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error('Message handling error:', e);
      }
    }
  });
}

async function handleAutopilot(lead, incomingMsg, jid) {
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return;

    const { data: kb } = await supabase
      .from('knowledge')
      .select('*')
      .eq('service', lead.service)
      .eq('efficace', true)
      .order('created_at', { ascending: false })
      .limit(5);

    const kbContext = kb && kb.length
      ? '\n\nRisposte efficaci precedenti:\n' + kb.map(k => `Situazione: ${k.situazione}\nRisposta: ${k.risposta_tua}`).join('\n---\n')
      : '';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system: `Sei Alessandro di Riccardi Properties. Obiettivo: fissare una call conoscitiva. MAI mandare link prima della call. MAI rispondere a obiezioni di prezzo per iscritto. Scrivi SOLO il messaggio da inviare.${kbContext}`,
        messages: [{
          role: 'user',
          content: `Lead: ${lead.name} | Servizio: ${lead.service}\nMessaggio ricevuto: ${incomingMsg}\nRispondi.`
        }]
      })
    });

    const data = await response.json();
    const aiResponse = data.content?.[0]?.text;

    if (aiResponse && sock) {
      await sock.sendMessage(jid, { text: aiResponse });

      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] Alessandro (AI): ${aiResponse}`;
      await supabase.from('leads').update({
        conversation: (lead.conversation || '') + newEntry
      }).eq('id', lead.id);

      await supabase.from('wa_messages').insert({
        phone: lead.phone?.replace(/\D/g, ''),
        sender_name: 'Alessandro (AI)',
        body: aiResponse,
        lead_id: lead.id,
        direction: 'outbound',
        timestamp: new Date().toISOString(),
        read: true,
        is_ai: true
      });
    }
  } catch (e) {
    console.error('Autopilot error:', e);
  }
}

// ROUTES
app.get('/', (req, res) => res.json({
  service: 'Riccardi Properties WA Server',
  status: clientStatus,
  ready: clientStatus === 'ready'
}));

app.get('/status', (req, res) => res.json({
  status: clientStatus,
  ready: clientStatus === 'ready'
}));

app.get('/qr', (req, res) => {
  if (qrCodeData) return res.json({ qr: qrCodeData });
  if (clientStatus === 'ready') return res.json({ status: 'already_connected' });
  return res.json({ status: clientStatus });
});

app.post('/send', async (req, res) => {
  if (clientStatus !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
  const { phone, message, leadId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });

    await supabase.from('wa_messages').insert({
      phone: phone.replace(/\D/g, ''),
      sender_name: 'Alessandro',
      body: message,
      lead_id: leadId || null,
      direction: 'outbound',
      timestamp: new Date().toISOString(),
      read: true,
      is_ai: false
    });

    if (leadId) {
      const { data: lead } = await supabase.from('leads').select('conversation').eq('id', leadId).single();
      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] Alessandro: ${message}`;
      await supabase.from('leads').update({
        conversation: (lead?.conversation || '') + newEntry
      }).eq('id', leadId);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/messages/:leadId', async (req, res) => {
  try {
    const { data } = await supabase
      .from('wa_messages')
      .select('*')
      .eq('lead_id', req.params.leadId)
      .order('timestamp', { ascending: true });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/messages/:leadId/read', async (req, res) => {
  await supabase.from('wa_messages').update({ read: true }).eq('lead_id', req.params.leadId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

connectToWhatsApp();
