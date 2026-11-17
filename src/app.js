import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const error = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const emailValid = value => typeof value === 'string' && value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const durationValid = value => Number.isInteger(value) && value >= 5 && value <= 240;
const safeEqual = (a, b) => {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createApp({ store, mailer, baseUrl, adminToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.use(express.static(publicDir, { index: false }));

  app.get('/', (req, res) => res.redirect('/machine/washer-1'));
  app.get('/machine/:slug', (req, res) => {
    if (!store.publicMachine(req.params.slug)) return error(res, 404, 'machine_not_found', 'Machine not found.');
    res.sendFile(join(publicDir, 'machine.html'));
  });
  app.get('/session/:token', (req, res) => {
    if (!store.getSession(req.params.token)) return error(res, 404, 'session_not_found', 'Private session not found.');
    res.sendFile(join(publicDir, 'session.html'));
  });

  app.get('/api/machines/:slug', (req, res) => {
    const machine = store.publicMachine(req.params.slug);
    if (!machine) return error(res, 404, 'machine_not_found', 'Machine not found.');
    res.json({ machine });
  });
  app.post('/api/machines/:slug/sessions', (req, res) => {
    if (!store.publicMachine(req.params.slug)) return error(res, 404, 'machine_not_found', 'Machine not found.');
    const email = req.body?.email?.trim?.().toLowerCase();
    const duration = req.body?.durationMinutes;
    if (!emailValid(email)) return error(res, 400, 'invalid_email', 'Enter a valid email address.');
    if (!durationValid(duration)) return error(res, 400, 'invalid_duration', 'Duration must be 5 to 240 minutes.');
    const result = store.createSession(req.params.slug, email, duration);
    if (result.error) return error(res, 409, result.error, 'This machine is already in use.');
    res.status(201).json({ session: result.session, privateUrl: `${baseUrl}/session/${result.token}` });
  });
  app.get('/api/sessions/:token', (req, res) => {
    const session = store.getSession(req.params.token);
    if (!session) return error(res, 404, 'session_not_found', 'Private session not found.');
    res.json({ session });
  });
  app.post('/api/sessions/:token/add-time', (req, res) => {
    const result = store.addTime(req.params.token);
    if (result.error) return error(res, result.error === 'session_not_found' ? 404 : 409, result.error,
      result.error === 'session_not_found' ? 'Private session not found.' :
        result.error === 'duration_limit' ? 'The timer cannot exceed 240 minutes.' : 'This session is closed.');
    res.json(result);
  });
  app.post('/api/sessions/:token/pickup', (req, res) => {
    const result = store.pickup(req.params.token);
    if (result.error) return error(res, result.error === 'session_not_found' ? 404 : 409, result.error,
      result.error === 'session_not_found' ? 'Private session not found.' : 'This session is closed.');
    res.json(result);
  });
  app.post('/api/machines/:slug/notify-owner', async (req, res, next) => {
    try {
      const result = store.notifyOwner(req.params.slug);
      if (result.error) {
        const status = result.error === 'machine_not_found' ? 404 : result.error === 'notify_rate_limited' ? 429 : 409;
        const message = result.error === 'notify_rate_limited' ? 'The owner was notified recently. Try again later.' :
          result.error === 'machine_available' ? 'This machine is available.' : 'Machine not found.';
        return error(res, status, result.error, message);
      }
      await mailer.send({ to: result.email, subject: `FreshOut: someone is waiting for ${result.machineName}`,
        text: `Someone is waiting for ${result.machineName}. Please move your laundry when you can.` });
      res.json({ message: 'Owner notified anonymously.' });
    } catch (err) { next(err); }
  });

  const requireAdmin = (req, res, next) => {
    const bearer = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!adminToken || !bearer || !safeEqual(bearer[1], adminToken))
      return error(res, 401, 'unauthorized', 'Valid admin token required.');
    next();
  };
  app.get('/api/admin/sessions', requireAdmin, (req, res) => res.json({ sessions: store.activeSessions() }));
  app.post('/api/admin/sessions/:id/reset', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return error(res, 400, 'invalid_id', 'Invalid session ID.');
    if (!store.reset(id)) return error(res, 404, 'session_not_found', 'Active session not found.');
    res.json({ message: 'Session reset.' });
  });
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) return error(res, 400, 'invalid_json', 'Invalid JSON body.');
    console.error(err);
    error(res, 500, 'internal_error', 'Something went wrong.');
  });
  return app;
}

export async function runReminderWorker({ store, mailer, baseUrl, logger = console }) {
  const due = store.claimDueReminders();
  for (const item of due) {
    try {
      await mailer.send({ to: item.email, subject: `FreshOut: ${item.machineName} should be finished`,
        text: `${item.machineName} should be finished. Please pick up your laundry when you can.\n\nManage your session: ${baseUrl}/session/${item.token}` });
    } catch (error) { logger.error(`FreshOut reminder delivery failed for session ${item.id}:`, error); }
  }
  return due.length;
}
