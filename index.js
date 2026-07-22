const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rmnxrepcsohhwnnlwnwn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJtbnhyZXBjc29oaHdubmx3bnduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMDk0MTIsImV4cCI6MjA5NjU4NTQxMn0.O5-kQmpMDfsU79LMP_LyUbLVfY880jAtuUG278PGCvw';
const CRM_URL = process.env.CRM_URL || 'https://lucent-longma-318cfc.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let qrCodeData = null;
let clientReady = false;
let clientStatus = 'initializing';

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async (qr) => {
  console.log('QR received');
  clientStatus = 'qr_ready';
  try {
    qrCodeData = await QRCode.toDataURL(qr);
  } catch (e) {
    console.error('QR error:', e);
  }
});

client.on('ready', () => {
  console.log('WhatsApp client ready!');
  clientReady = true;
  clientStatus = 'ready';
  qrCodeData = null;
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
  clientReady = false;
  clientStatus = 'disconnected';
});

// Receive messages - save to Supabase and check for matching lead
client.on('message', async (msg) => {
  if (msg.fromMe) return;
  
  try {
    const contact = await msg.getContact();
    const phone = msg.from.replace('@c.us', '').replace(/\D/g, '');
    const senderName = contact.pushname || contact.name || phone;
    const body = msg.body;
    const timestamp = new Date().toISOString();

    console.log(`Message from ${senderName} (${phone}): ${body.slice(0, 50)}`);

    // Find lead by phone in Supabase
    const { data: leads } = await supabase
      .from('leads')
      .select('*')
      .or(`phone.ilike.%${phone}%,phone.ilike.%${phone.slice(-9)}%`)
      .limit(1);

    let leadId = null;
    if (leads && leads.length > 0) {
      leadId = leads[0].id;
      // Append message to conversation
      const existingConv = leads[0].conversation || '';
      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] ${senderName}: ${body}`;
      await supabase
        .from('leads')
        .update({ conversation: existingConv + newEntry })
        .eq('id', leadId);
    }

    // Save message to wa_messages table
    await supabase.from('wa_messages').insert({
      phone,
      sender_name: senderName,
      body,
      lead_id: leadId,
      direction: 'inbound',
      timestamp,
      read: false
    });

    console.log('Message saved to Supabase');

    // Check if lead is in autopilot mode
    if (leads && leads.length > 0 && leads[0].meta) {
      try {
        const meta = JSON.parse(leads[0].meta);
        if (meta.waMode === 'autopilot') {
          console.log('Autopilot mode - AI will respond');
          await handleAutopilot(leads[0], body, msg.from);
        }
      } catch (e) {}
    }

  } catch (e) {
    console.error('Message handling error:', e);
  }
});

// Autopilot: AI responds automatically
async function handleAutopilot(lead, incomingMsg, chatId) {
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return;

    // Load knowledge for this service
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
        system: `Sei Alessandro di Riccardi Properties. Rispondi in modo professionale e caldo. Obiettivo: fissare una call conoscitiva. MAI mandare link prima della call. MAI rispondere a obiezioni di prezzo per iscritto. Scrivi SOLO il messaggio da inviare, senza spiegazioni.${kbContext}`,
        messages: [{
          role: 'user',
          content: `Lead: ${lead.name} | Servizio: ${lead.service} | Temperatura: ${lead.temp}\nNote: ${lead.notes || ''}\nUltima conversazione: ${lead.conversation ? lead.conversation.slice(-500) : ''}\nNuovo messaggio ricevuto: ${incomingMsg}\n\nRispondi.`
        }]
      })
    });

    const data = await response.json();
    const aiResponse = data.content && data.content[0] ? data.content[0].text : null;
    
    if (aiResponse) {
      // Send the message
      await client.sendMessage(chatId, aiResponse);
      console.log('Autopilot sent:', aiResponse.slice(0, 50));

      // Save to conversation
      const newEntry = `\n[${new Date().toLocaleString('it-IT')}] Alessandro (AI): ${aiResponse}`;
      await supabase.from('leads').update({ 
        conversation: (lead.conversation || '') + newEntry 
      }).eq('id', lead.id);

      // Save to messages
      await supabase.from('wa_messages').insert({
        phone: lead.phone,
        sender_name: 'Alessandro (AI)',
        body: aiResponse,
        lead_id: lead.id,
        direction: 'outbound',
        timestamp: new Date().toISOString(),
        read: true,
        is_ai: true
      });

      // Save to knowledge
      await supabase.from('knowledge').insert({
        service: lead.service,
        situazione: incomingMsg.slice(0, 200),
        risposta_ai: aiResponse,
        risposta_tua: aiResponse,
        contesto: `Lead: ${lead.name} | Autopilot`,
        efficace: true
      });
    }
  } catch (e) {
    console.error('Autopilot error:', e);
  }
}

// ===== API ROUTES =====

// Status + QR
app.get('/status', (req, res) => {
  res.json({ status: clientStatus, ready: clientReady });
});

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else if (clientReady) {
    res.json({ status: 'already_connected' });
  } else {
    res.json({ status: 'loading' });
  }
});

// Send message
app.post('/send', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  const { phone, message, leadId } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  
  try {
    const chatId = phone.replace(/\D/g, '') + '@c.us';
    await client.sendMessage(chatId, message);

    // Save to messages
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

    // Update lead conversation
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

// Get messages for a lead
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

// Mark messages as read
app.post('/messages/:leadId/read', async (req, res) => {
  await supabase.from('wa_messages').update({ read: true }).eq('lead_id', req.params.leadId);
  res.json({ success: true });
});

// Health check
app.get('/', (req, res) => res.json({ 
  service: 'Riccardi Properties WA Server', 
  status: clientStatus,
  ready: clientReady 
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Start WhatsApp client
client.initialize();
