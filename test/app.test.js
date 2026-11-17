import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp, runReminderWorker } from '../src/app.js';

const secret = 'test-session-secret-that-is-longer-than-thirty-two-bytes';
async function fixture(t) {
  const store = openDatabase(':memory:', secret);
  const emails = [];
  const mailer = { send: async email => { emails.push(email); } };
  const server = createApp({ store, mailer, baseUrl: 'http://localhost:3000', adminToken: 'test-admin-token' }).listen(0);
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
  return { store, emails, api, start, base };
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
});
test('invalid private token is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/sessions/invalid')).status, 404);
  assert.equal((await f.api('/api/sessions/invalid/add-time', 'POST')).status, 404);
});
