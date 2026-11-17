import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { createApp, runReminderWorker } from '../src/app.js';
import { createMailer } from '../src/mailer.js';

const secret = 'test-session-secret-that-is-longer-than-thirty-two-bytes';
async function fixture(t, options = {}) {
  const store = openDatabase(':memory:', secret);
  const emails = [];
  const logs = [];
  const logger = { error: line => logs.push(line) };
  const mailer = options.mailer || { send: async email => { emails.push(email); } };
  const server = createApp({ store, mailer, baseUrl: 'http://localhost:3000', adminToken: 'test-admin-token', logger }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, method = 'GET', body, token) => {
    const response = await fetch(base + path, { method, headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const start = (slug = 'washer-1', email = 'resident@example.com', durationMinutes = 30) =>
    api(`/api/machines/${slug}/sessions`, 'POST', { email, durationMinutes });
  return { store, emails, logs, api, start, base };
}

test('machine availability and seeded machines', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'available');
  assert.equal((await f.api('/api/machines/dryer-1')).body.machine.displayName, 'Dryer 1');
});
test('machine and private session pages load', async t => {
  const f = await fixture(t);
  const machinePage = await fetch(`${f.base}/machine/dryer-1`);
  assert.equal(machinePage.status, 200);
  assert.match(await machinePage.text(), /Fresh<span>Out<\/span>/);
  const token = (await f.start()).body.privateUrl.split('/').pop();
  const sessionPage = await fetch(`${f.base}/session/${token}`);
  assert.equal(sessionPage.status, 200);
  assert.match(await sessionPage.text(), /Manage your session/);
  assert.equal(sessionPage.headers.get('referrer-policy'), 'no-referrer');
});
test('valid session starts and public machine hides owner details', async t => {
  const f = await fixture(t);
  const result = await f.start();
  assert.equal(result.status, 201);
  assert.match(result.body.privateUrl, /\/session\/[A-Za-z0-9_-]{43}$/);
  const publicResult = await f.api('/api/machines/washer-1');
  assert.equal(publicResult.body.machine.status, 'active');
  assert.doesNotMatch(JSON.stringify(publicResult.body), /resident@example.com|\/session\//);
});
test('invalid email is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.start('washer-1', 'bad-email')).body.error.code, 'invalid_email');
});
test('invalid duration is rejected', async t => {
  const f = await fixture(t);
  for (const duration of [4, 241, 30.5, '30'])
    assert.equal((await f.start('washer-1', 'resident@example.com', duration)).body.error.code, 'invalid_duration');
});
test('duplicate active session is rejected', async t => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.start()).body.error.code, 'machine_occupied');
});
test('private session lookup works', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const token = started.body.privateUrl.split('/').pop();
  const result = await f.api(`/api/sessions/${token}`);
  assert.equal(result.body.session.machineName, 'Washer 1');
  assert.equal(result.body.session.durationMinutes, 30);
  assert.doesNotMatch(JSON.stringify(result.body), /resident@example.com/);
});
test('add ten minutes updates completion', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const token = started.body.privateUrl.split('/').pop();
  const result = await f.api(`/api/sessions/${token}/add-time`, 'POST');
  assert.equal(result.body.session.durationMinutes, 40);
  assert.equal(Date.parse(result.body.session.estimatedCompletionAt) - Date.parse(started.body.session.estimatedCompletionAt), 600_000);
});
test('adding time after a reminder schedules the new finish time', async t => {
  const f = await fixture(t);
  const token = (await f.start()).body.privateUrl.split('/').pop();
  f.store.raw.prepare('UPDATE laundry_sessions SET estimated_completion_at = ?').run(new Date(Date.now() - 1000).toISOString());
  const options = { store: f.store, mailer: { send: async mail => f.emails.push(mail) }, baseUrl: 'http://localhost:3000' };
  assert.equal(await runReminderWorker(options), 1);
  assert.equal((await f.api(`/api/sessions/${token}/add-time`, 'POST')).status, 200);
  assert.equal(f.store.raw.prepare('SELECT reminder_sent_at FROM laundry_sessions').get().reminder_sent_at, null);
  assert.equal(await runReminderWorker(options), 0);
  f.store.raw.prepare('UPDATE laundry_sessions SET estimated_completion_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(await runReminderWorker(options), 1);
  assert.equal(f.emails.length, 2);
});
test('add time respects the 240 minute limit', async t => {
  const f = await fixture(t);
  const token = (await f.start('washer-1', 'resident@example.com', 240)).body.privateUrl.split('/').pop();
  assert.equal((await f.api(`/api/sessions/${token}/add-time`, 'POST')).body.error.code, 'duration_limit');
});
test('pickup releases machine', async t => {
  const f = await fixture(t);
  const token = (await f.start()).body.privateUrl.split('/').pop();
  assert.equal((await f.api(`/api/sessions/${token}/pickup`, 'POST')).body.session.status, 'picked_up');
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'available');
});
test('anonymous notify emails owner and changes status', async t => {
  const f = await fixture(t);
  await f.start();
  const result = await f.api('/api/machines/washer-1/notify-owner', 'POST');
  assert.equal(result.status, 200);
  assert.equal(f.emails[0].to, 'resident@example.com');
  assert.match(f.emails[0].text, /Someone is waiting for Washer 1/);
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'awaiting_pickup');
  assert.doesNotMatch(JSON.stringify(result.body), /resident@example.com/);
});
test('notify is limited to once per machine per ten minutes', async t => {
  const f = await fixture(t);
  await f.start();
  await f.api('/api/machines/washer-1/notify-owner', 'POST');
  const second = await f.api('/api/machines/washer-1/notify-owner', 'POST');
  assert.equal(second.status, 429);
  assert.equal(f.emails.length, 1);
});
test('admin routes require token', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/admin/sessions')).status, 401);
  assert.equal((await f.api('/api/admin/sessions', 'GET', undefined, 'wrong')).status, 401);
  assert.equal((await f.api('/api/admin/sessions', 'GET', undefined, 'test-admin-token')).status, 200);
});
test('admin reset cancels a stuck session', async t => {
  const f = await fixture(t);
  await f.start();
  const sessions = (await f.api('/api/admin/sessions', 'GET', undefined, 'test-admin-token')).body.sessions;
  const reset = await f.api(`/api/admin/sessions/${sessions[0].id}/reset`, 'POST', undefined, 'test-admin-token');
  assert.equal(reset.status, 200);
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'available');
});
test('completion reminder is idempotent and includes private link', async t => {
  const f = await fixture(t);
  await f.start();
  f.store.raw.prepare("UPDATE laundry_sessions SET estimated_completion_at = ?").run(new Date(Date.now() - 1000).toISOString());
  const options = { store: f.store, mailer: { send: async mail => f.emails.push(mail) }, baseUrl: 'http://localhost:3000' };
  assert.equal(await runReminderWorker(options), 1);
  assert.equal(await runReminderWorker(options), 0);
  assert.equal(f.emails.length, 1);
  assert.match(f.emails[0].text, /Washer 1 should be finished/);
  assert.match(f.emails[0].text, /http:\/\/localhost:3000\/session\/[A-Za-z0-9_-]{43}/);
  assert.ok(f.store.raw.prepare('SELECT reminder_sent_at FROM laundry_sessions').get().reminder_sent_at);
});
test('failed reminder stays unsent and succeeds on retry without a duplicate', async t => {
  const f = await fixture(t);
  const token = (await f.start()).body.privateUrl.split('/').pop();
  f.store.raw.prepare('UPDATE laundry_sessions SET estimated_completion_at = ?').run(new Date(Date.now() - 1000).toISOString());
  let attempts = 0;
  const logger = { error: line => f.logs.push(line) };
  const mailer = { send: async mail => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error(`private ${token} resident@example.com`), { code: 'EAUTH' });
    f.emails.push(mail);
  } };
  const options = { store: f.store, mailer, baseUrl: 'http://localhost:3000', logger };
  assert.equal(await runReminderWorker(options), 1);
  assert.equal(f.store.raw.prepare('SELECT reminder_sent_at FROM laundry_sessions').get().reminder_sent_at, null);
  assert.equal(await runReminderWorker(options), 1);
  assert.equal(await runReminderWorker(options), 0);
  assert.equal(attempts, 2);
  assert.equal(f.emails.length, 1);
  assert.match(f.logs[0], /EAUTH.*Retry pending/);
  assert.doesNotMatch(f.logs.join(' '), /resident@example.com|\/session\//);
});
test('concurrent reminder checks cannot claim the same email twice', async t => {
  const f = await fixture(t);
  await f.start();
  f.store.raw.prepare('UPDATE laundry_sessions SET estimated_completion_at = ?').run(new Date(Date.now() - 1000).toISOString());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const options = { store: f.store, mailer: { send: async mail => { await gate; sent.push(mail); } }, baseUrl: 'http://localhost:3000' };
  const first = runReminderWorker(options);
  assert.equal(await runReminderWorker(options), 0);
  release();
  assert.equal(await first, 1);
  assert.equal(await runReminderWorker(options), 0);
  assert.equal(sent.length, 1);
});
test('one reminder failure does not stop another machine reminder', async t => {
  const f = await fixture(t);
  await f.start('washer-1');
  await f.start('dryer-1', 'dryer@example.com');
  f.store.raw.prepare('UPDATE laundry_sessions SET estimated_completion_at = ?').run(new Date(Date.now() - 1000).toISOString());
  const sent = [];
  let failed = false;
  const mailer = { send: async mail => {
    if (!failed) { failed = true; throw new Error('temporary failure'); }
    sent.push(mail);
  } };
  const options = { store: f.store, mailer, baseUrl: 'http://localhost:3000', logger: { error: () => {} } };
  assert.equal(await runReminderWorker(options), 2);
  assert.equal(sent.length, 1);
  assert.equal(await runReminderWorker(options), 1);
  assert.equal(sent.length, 2);
});
test('failed owner notification can retry and rate limit starts after success', async t => {
  let attempts = 0;
  const delivered = [];
  const f = await fixture(t, { mailer: { send: async mail => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('SMTP rejected'), { code: 'EAUTH' });
    delivered.push(mail);
  } } });
  await f.start();
  const path = '/api/machines/washer-1/notify-owner';
  const failed = await f.api(path, 'POST');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'email_delivery_failed');
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'active');
  assert.equal(f.store.raw.prepare('SELECT notify_sent_at FROM laundry_sessions').get().notify_sent_at, null);
  assert.equal((await f.api(path, 'POST')).status, 200);
  assert.equal((await f.api(path, 'POST')).status, 429);
  assert.equal(delivered.length, 1);
  assert.equal(attempts, 2);
  assert.match(f.logs[0], /EAUTH/);
  assert.doesNotMatch(f.logs.join(' '), /resident@example.com/);
});
test('concurrent owner notifications send only one email', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { entered = resolve; });
  const sent = [];
  const f = await fixture(t, { mailer: { send: async mail => { entered(); await gate; sent.push(mail); } } });
  await f.start();
  const path = '/api/machines/washer-1/notify-owner';
  const first = f.api(path, 'POST');
  await sending;
  const second = await f.api(path, 'POST');
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'notify_in_progress');
  release();
  assert.equal((await first).status, 200);
  assert.equal(sent.length, 1);
});
test('private links are random, tamper resistant, and expire safely', async t => {
  const f = await fixture(t);
  const first = (await f.start('washer-1')).body.privateUrl.split('/').pop();
  const second = (await f.start('dryer-1', 'dryer@example.com')).body.privateUrl.split('/').pop();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  const changed = `${first[0] === 'A' ? 'B' : 'A'}${first.slice(1)}`;
  assert.equal((await f.api(`/api/sessions/${changed}`)).status, 404);
  assert.equal((await f.api('/api/sessions/123')).body.error.code, 'session_not_found');
  f.store.raw.prepare('UPDATE laundry_sessions SET owner_token_expires_at = ? WHERE id = 1')
    .run(new Date(Date.now() - 1000).toISOString());
  const expired = await f.api(`/api/sessions/${first}`);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, 'expired_link');
  assert.equal((await f.api(`/api/sessions/${first}/add-time`, 'POST')).status, 410);
  assert.equal((await fetch(`${f.base}/session/${first}`)).status, 410);
  assert.equal((await f.api('/api/machines/washer-1')).body.machine.status, 'available');
});
test('production requires a secret and configured SMTP', () => {
  assert.throws(() => openDatabase(':memory:', ''), /SESSION_SECRET/);
  assert.throws(() => createMailer({ NODE_ENV: 'production' }), /SMTP_HOST/);
  assert.equal(createMailer({}, { log: () => {} }).mode, 'demo');
});
test('older SQLite schema is migrated without losing an active session', () => {
  const folder = mkdtempSync(join(tmpdir(), 'freshout-migration-'));
  const filename = join(folder, 'old.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE machines (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    machine_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE laundry_sessions (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, owner_email TEXT NOT NULL,
    owner_token_hash TEXT NOT NULL UNIQUE, owner_link_ciphertext TEXT NOT NULL, status TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL, started_at TEXT NOT NULL, estimated_completion_at TEXT NOT NULL,
    completed_at TEXT, reminder_sent_at TEXT, notify_sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO machines (id, slug, display_name, machine_type) VALUES (1, 'washer-1', 'Washer 1', 'washer');`);
  const started = new Date().toISOString();
  const estimated = new Date(Date.now() + 30 * 60_000).toISOString();
  old.prepare(`INSERT INTO laundry_sessions (machine_id, owner_email, owner_token_hash, owner_link_ciphertext,
    status, duration_minutes, started_at, estimated_completion_at, created_at, updated_at)
    VALUES (1, 'existing@example.com', 'oldhash', 'oldcipher', 'active', 30, ?, ?, ?, ?)`)
    .run(started, estimated, started, started);
  old.close();
  const migrated = openDatabase(filename, secret);
  assert.equal(migrated.publicMachine('washer-1').status, 'active');
  assert.equal(migrated.raw.prepare('SELECT owner_email FROM laundry_sessions').get().owner_email, 'existing@example.com');
  assert.ok(migrated.raw.prepare('SELECT owner_token_expires_at FROM laundry_sessions').get().owner_token_expires_at);
  migrated.close();
  unlinkSync(filename);
  rmdirSync(folder);
});
test('invalid private token is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/sessions/invalid')).status, 404);
  assert.equal((await f.api('/api/sessions/invalid/add-time', 'POST')).status, 404);
});
