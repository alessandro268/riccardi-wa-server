# Riccardi Properties — WhatsApp Server

## Deploy su Railway

1. Vai su railway.app
2. Clicca "New Project" → "Deploy from GitHub repo"
3. Carica questi file su un repo GitHub pubblico
4. Aggiungi le variabili d'ambiente:
   - ANTHROPIC_API_KEY = la tua chiave
   - SUPABASE_URL = https://rmnxrepcsohhwnnlwnwn.supabase.co
   - SUPABASE_KEY = (la chiave anon)
   - PORT = 3000

## Endpoints
- GET /status — stato connessione
- GET /qr — QR code per connettere WhatsApp
- POST /send — invia messaggio
- GET /messages/:leadId — messaggi di un lead
