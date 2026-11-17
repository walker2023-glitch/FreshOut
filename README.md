# FreshOut

FreshOut is a mobile-first laundry reminder app for a shared room with exactly two pilot machines: Washer 1 and Dryer 1. Residents scan a QR code, set an estimated cycle timer, receive an email when the cycle should be finished, and can anonymously nudge an occupied machine's owner.

The timer is an estimate; FreshOut does not detect machine activity. There are no accounts, payments, SMS, or hardware integrations.

## Technology

Node.js 24+, Express 5, Node's built-in SQLite module, Nodemailer, and plain HTML/CSS/JavaScript. SQLite data persists in `data/freshout.sqlite` by default. The database and machine records are created on first launch. The `data/` directory and `.env` are ignored by Git.

## Local setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and replace `SESSION_SECRET` with at least 32 random characters and `ADMIN_TOKEN` with a separate long random value. One way to generate each value is `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

```powershell
npm start
```

Open [Washer 1](http://localhost:3000/machine/washer-1) or [Dryer 1](http://localhost:3000/machine/dryer-1). Enter an email and select 30, 35, 45, 60, or a custom 5–240 minute duration. Save the private URL after starting. Use a second browser or private window to try **Notify owner**. The owner can add 10 minutes or mark the load picked up from the private page.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `BASE_URL` | Public origin used in email links; use HTTPS in deployment |
| `ADMIN_TOKEN` | Bearer token for admin API; admin routes are disabled when unset |
| `SESSION_SECRET` | Required, at least 32 bytes; hashes and encrypts private session tokens |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port, default `587`; port `465` uses TLS on connect |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `EMAIL_FROM` | Sender address/name, defaults to SMTP username |
| `DATABASE_PATH` | Optional SQLite path, default `data/freshout.sqlite` |

If SMTP host, user, or password are missing, FreshOut logs each email's recipient, subject, and body to the server console. This is useful for local testing. When all three are present, Nodemailer sends actual email. Set `EMAIL_FROM` to an address accepted by your provider.

The reminder worker checks every 30 seconds. It reserves each due reminder before sending, which prevents duplicate completion emails on repeated runs. A crash or SMTP failure after reservation can cause a missed email; a production deployment should use a durable queue with provider idempotency. Anonymous owner notifications are limited to one per machine every 10 minutes.

## API

All API responses are JSON. Errors use `{ "error": { "code": "...", "message": "..." } }`.

| Route | Purpose |
| --- | --- |
| `GET /api/machines/:slug` | Public machine status |
| `POST /api/machines/:slug/sessions` | Start a session with `{ "email": "...", "durationMinutes": 30 }` |
| `GET /api/sessions/:token` | Private session details |
| `POST /api/sessions/:token/add-time` | Add 10 minutes |
| `POST /api/sessions/:token/pickup` | Mark picked up |
| `POST /api/machines/:slug/notify-owner` | Email owner anonymously |
| `GET /api/admin/sessions` | List occupied sessions; Bearer admin token required |
| `POST /api/admin/sessions/:id/reset` | Cancel an occupied session; Bearer admin token required |

For example, to view active sessions: `curl.exe -H "Authorization: Bearer YOUR_ADMIN_TOKEN" http://localhost:3000/api/admin/sessions`. Admin responses omit owner emails and private tokens.

## QR codes

Print QR codes targeting the full deployed URLs `https://YOUR_DOMAIN/machine/washer-1` and `https://YOUR_DOMAIN/machine/dryer-1`. During local testing, use the same paths with a LAN-reachable host and matching `BASE_URL`; `localhost` on a phone refers to the phone, not your computer. Any trusted QR generator or `qrencode -o washer-1.png 'https://YOUR_DOMAIN/machine/washer-1'` can make the images.

## Checks

```powershell
npm run check
npm test
```

There is no build step. `npm run check` checks JavaScript syntax; `npm test` runs API and worker tests with an in-memory SQLite database and stub email delivery.

## Deployment later

Run one persistent Node process behind HTTPS, set `BASE_URL` to the public origin, configure SMTP and strong secrets, and mount persistent storage for the SQLite file. Back up the database. Keep `SESSION_SECRET` stable: changing it invalidates existing private links. A larger deployment should move email delivery to a durable queue and add operational monitoring.

## Known limitations

The app supports only the two seeded machines, uses an estimated timer with no hardware signal, and has a token-protected API instead of an admin UI. Private session URLs are bearer credentials; anyone with a copied link can manage that session. Email delivery is at most once for completion reminders.
