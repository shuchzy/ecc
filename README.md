# WhatsApp Campaign System

Local web system for importing customers, preparing campaigns, and sending WhatsApp messages.

Supported modes:

- Free manual mode through WhatsApp Web.
- Automatic sending through Twilio WhatsApp.
- Automatic sending through Meta Cloud API, kept as an advanced option.

## Run

```powershell
npm install
npm run build
npm start
```

Open:

```text
http://localhost:4177
```

## Customer File

Upload `CSV`, `TSV`, or `TXT`.

Recommended CSV format:

```csv
phone,name,optin
0501234567,Dan,yes
+972521234567,Noa,yes
0540000000,No consent,no
```

Only contacts with positive `optin` are sent. If the `optin` column is missing, the system assumes you already have permission.

## Free Manual Mode

This mode does not require Meta, Twilio, API keys, or payment.

1. Upload customers.
2. Write the message.
3. Click `Open WhatsApp message`.
4. WhatsApp Web opens with the customer and text ready.
5. Send manually in WhatsApp.

Important: WhatsApp Web links can prefill text only. They cannot attach an image automatically.

## Twilio WhatsApp Mode

Start the server with Twilio credentials:

```powershell
$env:WHATSAPP_PROVIDER="twilio"
$env:TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:TWILIO_AUTH_TOKEN="your_auth_token"
$env:TWILIO_WHATSAPP_FROM="whatsapp:+14155238886"
$env:PUBLIC_BASE_URL="https://your-public-domain.example"
npm start
```

`TWILIO_WHATSAPP_FROM` must be an approved Twilio WhatsApp sender, or the Twilio Sandbox sender while testing.

For media sending, `PUBLIC_BASE_URL` must point to a public URL that reaches this server, because Twilio must download the image/PDF/video from the internet.

### Twilio Session Messages

Use `Session` mode when the customer is inside the active WhatsApp 24-hour conversation window.

The system sends:

- `From=whatsapp:+...`
- `To=whatsapp:+...`
- `Body`
- optional `MediaUrl`

### Twilio Template Messages

For business-initiated marketing messages, WhatsApp requires approved templates.

In the system:

1. Choose `Template` mode.
2. Put the Twilio `ContentSid` in the template field. It starts with `HX`.
3. Put template variables in the variables field, comma separated.

The system sends Twilio:

- `ContentSid`
- `ContentVariables`

## Meta Cloud API Mode

If you later use Meta directly:

```powershell
$env:WHATSAPP_PROVIDER="meta"
$env:WHATSAPP_PHONE_NUMBER_ID="..."
$env:WHATSAPP_ACCESS_TOKEN="..."
$env:WHATSAPP_GRAPH_VERSION="v25.0"
$env:PUBLIC_BASE_URL="https://your-public-domain.example"
npm start
```

## Notes

- Automatic WhatsApp sending requires an official WhatsApp Business API route, such as Twilio or Meta.
- Business-initiated advertising messages usually require approved templates.
- Keep customer opt-in records. Sending unsolicited messages can get the sender restricted.
