# FreshOut

FreshOut is a mobile-first laundry reminder app for a shared room with exactly two pilot machines: Washer 1 and Dryer 1. Residents scan a QR code, set an estimated cycle timer, receive an email when the cycle should be finished, and can anonymously nudge an occupied machine's owner.

The timer is an estimate; FreshOut does not detect machine activity. There are no accounts, payments, SMS, or hardware integrations.

## Technology

Node.js 24+, Express 5, Node's built-in SQLite module, Nodemailer, and plain HTML/CSS/JavaScript. SQLite data persists in `data/freshout.sqlite` by default. The database and machine records are created on first launch. The `data/` directory and `.env` are ignored by Git.

## Windows PowerShell setup

```powershell
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
notepad .env
```

Paste the first generated value into `SESSION_SECRET` and the second into `ADMIN_TOKEN` in `.env`. Each command generates 32 random bytes, encoded as 64 hex characters. Keep these values private. `SESSION_SECRET` is required in every mode; there is no insecure development fallback. The empty SMTP fields enable demo email mode for local development.

```powershell
npm.cmd start
```

Open [Washer 1](http://localhost:3000/machine/washer-1) or [Dryer 1](http://localhost:3000/machine/dryer-1). The app redirects to a private page with a timer-started confirmation and estimated finish time. Keep the private URL. It expires 24 hours after the timer starts; stale sessions then become available. An admin can reset a stuck session sooner.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `BASE_URL` | Public origin used in email and QR links, with no trailing path; use HTTPS in deployment |
| `ADMIN_TOKEN` | Bearer token for admin API; admin routes are disabled when unset |
| `SESSION_SECRET` | Required, at least 32 bytes; hashes and encrypts private session tokens |
| `SMTP_HOST` | SMTP server host |
| `SMTP_PORT` | SMTP port, default `587`; port `465` uses TLS on connect |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `EMAIL_FROM` | Sender address/name, defaults to SMTP username |
| `DATABASE_PATH` | Optional SQLite path, default `data/freshout.sqlite` |
| `NODE_ENV` | Set to `production` when deployed; requires SMTP configuration |

For this computer, use `BASE_URL=http://localhost:3000`. For a phone on the same Wi-Fi, use your computer's reachable LAN address, such as `BASE_URL=http://192.168.1.50:3000`, and allow that port through the firewall. For deployment, use `BASE_URL=https://your-domain.example` behind an HTTPS proxy. Restart the server after changing `.env`, then regenerate QR codes. The URL in each printed code must be reachable from residents' phones.

If SMTP host, user, or password are missing in development, FreshOut logs each email's recipient, subject, and body (including private session links in completion reminders) to the server console. This is demo mode; restrict console access. When all three are present, Nodemailer sends actual email. Set `EMAIL_FROM` to an address your provider accepts. In `NODE_ENV=production`, FreshOut refuses to start without SMTP. Real SMTP credentials are not included in this repository.

The reminder worker checks every 30 seconds. It claims due reminders, records success only after delivery, and releases failed claims for retry on the next check. One failed email does not stop the others. Anonymous owner notifications follow the same rule and are limited to one successful send per machine every 10 minutes. A crash in the short interval after SMTP accepts an email but before SQLite records success can still cause a duplicate after the claim expires. Exactly-once email requires a provider with idempotency support or a durable queue with delivery reconciliation. Existing rows marked sent by the earlier MVP cannot be automatically identified as delivered or failed.

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

For example, in PowerShell:

```powershell
$adminToken = 'PASTE_YOUR_ADMIN_TOKEN'
$headers = @{ Authorization = "Bearer $adminToken" }
Invoke-RestMethod -Uri 'http://localhost:3000/api/admin/sessions' -Headers $headers
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/admin/sessions/1/reset' -Headers $headers
```

Replace `1` with the session ID from the listing. Admin responses omit owner emails and private tokens. Do not share the admin token with residents.

## QR codes

Set `BASE_URL` in `.env` to the address residents will use, then run:

```powershell
npm.cmd run qr:urls
npm.cmd run qr:generate
```

The first command prints the full Washer 1 and Dryer 1 URLs. The second generates printable `qr/washer-1.svg` and `qr/dryer-1.svg` (ignored by Git). Print each code with its machine name and place it beside the matching machine, away from hot or wet surfaces. Scan **both** printed codes with a phone before the pilot and confirm the names match. Do not print localhost QR codes for residents: a phone's `localhost` is the phone itself. Regenerate and replace codes whenever `BASE_URL` changes.

## Checks

```powershell
npm.cmd run check
npm.cmd test
```

There is no app build step. The checks cover syntax, API behavior, reminder retry behavior, private link handling, and admin controls with an in-memory SQLite database and stub email delivery.

To test both machines manually, start a timer on Washer 1 and note the private page. In a second browser window, verify Washer 1 shows **In use**, a duplicate timer is rejected, and **Notify owner** sends an anonymous email (printed in the server console in demo mode). Return to the private page, add 10 minutes, then mark the load picked up. Washer 1 should show **Available**. Repeat the start and pickup flow for Dryer 1. Use the admin listing and reset route above to clear a stuck pilot session.

## Deployment later

Run one persistent Node process behind HTTPS, set `NODE_ENV=production` and `BASE_URL` to the HTTPS public origin, configure SMTP, a 32-byte `SESSION_SECRET`, and a separate `ADMIN_TOKEN` of at least 32 bytes. Mount persistent storage for the SQLite file and back it up. Keep `SESSION_SECRET` stable: changing it invalidates existing private links. Existing MVP databases gain the new claim and expiry columns on first start. Closed sessions are deleted after seven days by the reminder worker.

## CI/CD

GitHub Actions runs `npm ci`, syntax checks, tests, and a Docker build on pull requests and pushes to `main`. After those checks pass on `main`, it publishes `ghcr.io/walker2023-glitch/freshout:latest` and a tag named after the commit SHA. The workflow uses GitHub's repository token with package-write permission only for the publishing job; no SMTP or app secrets are placed in CI.

Publishing an image is the delivery step. It does not restart a server or migrate a live deployment. To run the image on a host, create a private `.env.production` file with `NODE_ENV=production`, `BASE_URL=https://your-domain.example`, strong `SESSION_SECRET` and `ADMIN_TOKEN`, and working SMTP settings. Then run:

```powershell
docker run -d --name freshout -p 3000:3000 --env-file .env.production -v freshout-data:/app/data ghcr.io/walker2023-glitch/freshout:latest
```

Put an HTTPS reverse proxy in front of port 3000 and back up the `freshout-data` volume. The image runs as a non-root user; any bind-mounted data directory must be writable by that user. When you choose a host, add a deployment job that pulls the new image and restarts this single persistent process. Do not run multiple independent instances against separate SQLite files.

## Pilot privacy

FreshOut stores an owner's email only to send laundry reminders. Public machine pages and the anonymous notify response never reveal that email or the private link. The private link is a bearer credential: anyone who receives it can manage the timer, so residents should not share it. Links expire after 24 hours. Closed session records are deleted after seven days. Demo mode prints email contents to the server console, so keep that console private; use SMTP and HTTPS for a resident-facing pilot.

## Known limitations

The app supports only the two seeded machines, uses an estimated timer with no hardware signal, and has a token-protected API instead of an admin UI. It cannot prove that a machine is physically free. Email delivery is retried after failures but cannot guarantee exactly-once delivery across a process crash after SMTP acceptance.
