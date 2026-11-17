import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createMailer } from './mailer.js';
import { createApp, runReminderWorker } from './app.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1 to 65535');
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const publicUrl = new URL(baseUrl);
if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.origin !== baseUrl)
  throw new Error('BASE_URL must be an http(s) origin without a path or query');
if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:')
  throw new Error('BASE_URL must use HTTPS in production');
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(process.env.ADMIN_TOKEN || '') < 32)
  throw new Error('ADMIN_TOKEN must be at least 32 bytes in production');
const filename = resolve(process.env.DATABASE_PATH || 'data/freshout.sqlite');
mkdirSync(dirname(filename), { recursive: true });
const store = openDatabase(filename, process.env.SESSION_SECRET);
const mailer = createMailer();
const app = createApp({ store, mailer, baseUrl, adminToken: process.env.ADMIN_TOKEN });
const server = app.listen(port, () => console.log(`FreshOut running at ${baseUrl} (${mailer.mode} email mode)`));
let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try { await runReminderWorker({ store, mailer, baseUrl }); }
  catch (error) { console.error(`FreshOut reminder worker failed (${String(error?.code || 'database_error').replace(/[^A-Za-z0-9_]/g, '')}).`); }
  finally { working = false; }
}, 30_000);
timer.unref();
function shutdown() { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
