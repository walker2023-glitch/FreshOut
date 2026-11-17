import { DatabaseSync } from 'node:sqlite';
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const occupied = "('active', 'awaiting_pickup')";
const now = () => new Date().toISOString();

export function openDatabase(filename, secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET must be at least 32 bytes');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, machine_type TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS laundry_sessions (
      id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES machines(id),
      owner_email TEXT NOT NULL, owner_token_hash TEXT NOT NULL UNIQUE,
      owner_link_ciphertext TEXT NOT NULL,
      owner_token_expires_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','awaiting_pickup','picked_up','expired','cancelled')),
      duration_minutes INTEGER NOT NULL, started_at TEXT NOT NULL,
      estimated_completion_at TEXT NOT NULL, completed_at TEXT,
      reminder_sent_at TEXT, notify_sent_at TEXT,
      reminder_claim_token TEXT, reminder_claimed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_occupied_session_per_machine
      ON laundry_sessions(machine_id) WHERE status IN ${occupied};
    CREATE TABLE IF NOT EXISTS machine_notifications (
      machine_id INTEGER PRIMARY KEY REFERENCES machines(id), last_sent_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_claims (
      machine_id INTEGER PRIMARY KEY REFERENCES machines(id),
      claim_token TEXT NOT NULL, claimed_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(laundry_sessions)').all().map(column => column.name));
  for (const [name, type] of [['owner_token_expires_at', 'TEXT'], ['reminder_claim_token', 'TEXT'], ['reminder_claimed_at', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE laundry_sessions ADD COLUMN ${name} ${type}`);
  }
  // Existing pilot data predates link expiry. Preserve its original start time.
  const missingExpiry = db.prepare('SELECT id, started_at FROM laundry_sessions WHERE owner_token_expires_at IS NULL').all();
  const setExpiry = db.prepare('UPDATE laundry_sessions SET owner_token_expires_at = ? WHERE id = ?');
  for (const row of missingExpiry) setExpiry.run(new Date(Date.parse(row.started_at) + 24 * 60 * 60_000).toISOString(), row.id);
  const seed = db.prepare('INSERT OR IGNORE INTO machines (slug, display_name, machine_type) VALUES (?, ?, ?)');
  seed.run('washer-1', 'Washer 1', 'washer');
  seed.run('dryer-1', 'Dryer 1', 'dryer');

  const tokenHash = token => createHmac('sha256', secret).update(token).digest('hex');
  const linkKey = createHash('sha256').update(secret).digest();
  const encryptToken = token => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', linkKey, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  };
  const decryptToken = value => {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', linkKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return decipher.update(bytes.subarray(28), undefined, 'utf8') + decipher.final('utf8');
  };
  const machine = slug => db.prepare('SELECT * FROM machines WHERE slug = ? AND is_active = 1').get(slug);
  const expireStaleSessions = () => {
    const timestamp = now();
    db.prepare(`UPDATE laundry_sessions SET status = 'expired', completed_at = ?, updated_at = ?
      WHERE status IN ${occupied} AND owner_token_expires_at <= ?`).run(timestamp, timestamp, timestamp);
  };
  const sessionByToken = token => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    expireStaleSessions();
    const session = db.prepare(`SELECT s.*, m.display_name, m.slug FROM laundry_sessions s
      JOIN machines m ON m.id = s.machine_id WHERE s.owner_token_hash = ?`).get(tokenHash(token));
    if (session && session.owner_token_expires_at <= now()) return { error: 'expired_link' };
    return session;
  };
  const publicMachine = slug => {
    expireStaleSessions();
    const m = machine(slug);
    if (!m) return undefined;
    const s = db.prepare(`SELECT status, estimated_completion_at FROM laundry_sessions
      WHERE machine_id = ? AND status IN ${occupied}`).get(m.id);
    return { slug: m.slug, displayName: m.display_name, machineType: m.machine_type,
      status: s?.status ?? 'available', estimatedCompletionAt: s?.estimated_completion_at ?? null };
  };
  const privateSession = s => ({ id: s.id, machineName: s.display_name, machineSlug: s.slug,
    status: s.status, durationMinutes: s.duration_minutes, startedAt: s.started_at,
    estimatedCompletionAt: s.estimated_completion_at, completedAt: s.completed_at });

  return {
    close: () => db.close(),
    publicMachine,
    getSession: token => { const s = sessionByToken(token); return s?.error ? s : s && privateSession(s); },
    createSession(slug, email, duration) {
      const m = machine(slug);
      if (!m) return { error: 'machine_not_found' };
      const token = randomBytes(32).toString('base64url');
      const timestamp = now();
      const estimated = new Date(Date.parse(timestamp) + duration * 60_000).toISOString();
      const expires = new Date(Date.parse(timestamp) + 24 * 60 * 60_000).toISOString();
      try {
        const result = db.prepare(`INSERT INTO laundry_sessions
          (machine_id, owner_email, owner_token_hash, owner_link_ciphertext, owner_token_expires_at,
           status, duration_minutes, started_at,
           estimated_completion_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
          .run(m.id, email, tokenHash(token), encryptToken(token), expires, duration, timestamp, estimated, timestamp, timestamp);
        return { token, session: privateSession({ id: Number(result.lastInsertRowid), display_name: m.display_name,
          slug: m.slug, status: 'active', duration_minutes: duration, started_at: timestamp,
          estimated_completion_at: estimated, completed_at: null }) };
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) return { error: 'machine_occupied' };
        throw error;
      }
    },
    addTime(token) {
      const s = sessionByToken(token);
      if (!s) return { error: 'session_not_found' };
      if (s.error) return s;
      if (!['active', 'awaiting_pickup'].includes(s.status)) return { error: 'session_closed' };
      if (s.duration_minutes + 10 > 240) return { error: 'duration_limit' };
      const estimated = new Date(Date.parse(s.estimated_completion_at) + 10 * 60_000).toISOString();
      db.prepare(`UPDATE laundry_sessions SET estimated_completion_at = ?, duration_minutes = duration_minutes + 10,
        status = 'active', reminder_sent_at = NULL, reminder_claim_token = NULL,
        reminder_claimed_at = NULL, updated_at = ? WHERE id = ?`).run(estimated, now(), s.id);
      return { session: privateSession({ ...s, status: 'active', duration_minutes: s.duration_minutes + 10,
        estimated_completion_at: estimated }) };
    },
    pickup(token) {
      const s = sessionByToken(token);
      if (!s) return { error: 'session_not_found' };
      if (s.error) return s;
      if (!['active', 'awaiting_pickup'].includes(s.status)) return { error: 'session_closed' };
      const timestamp = now();
      db.prepare("UPDATE laundry_sessions SET status = 'picked_up', completed_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, s.id);
      return { session: privateSession({ ...s, status: 'picked_up', completed_at: timestamp }) };
    },
    beginNotify(slug) {
      const m = machine(slug);
      if (!m) return { error: 'machine_not_found' };
      expireStaleSessions();
      db.exec('BEGIN IMMEDIATE');
      try {
        const s = db.prepare(`SELECT * FROM laundry_sessions WHERE machine_id = ? AND status IN ${occupied}`).get(m.id);
        if (!s) { db.exec('ROLLBACK'); return { error: 'machine_available' }; }
        const last = db.prepare('SELECT last_sent_at FROM machine_notifications WHERE machine_id = ?').get(m.id);
        const timestamp = now();
        if (last && Date.parse(timestamp) - Date.parse(last.last_sent_at) < 600_000) {
          db.exec('ROLLBACK'); return { error: 'notify_rate_limited' };
        }
        const pending = db.prepare('SELECT claimed_at FROM notification_claims WHERE machine_id = ?').get(m.id);
        if (pending && Date.parse(timestamp) - Date.parse(pending.claimed_at) < 600_000) {
          db.exec('ROLLBACK'); return { error: 'notify_in_progress' };
        }
        const claim = randomBytes(16).toString('hex');
        db.prepare(`INSERT INTO notification_claims (machine_id, claim_token, claimed_at) VALUES (?, ?, ?)
          ON CONFLICT(machine_id) DO UPDATE SET claim_token = excluded.claim_token,
          claimed_at = excluded.claimed_at`).run(m.id, claim, timestamp);
        db.exec('COMMIT');
        return { email: s.owner_email, machineName: m.display_name, machineId: m.id, sessionId: s.id, claim };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    completeNotify({ machineId, sessionId, claim }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const pending = db.prepare('SELECT claim_token FROM notification_claims WHERE machine_id = ?').get(machineId);
        if (!pending || pending.claim_token !== claim) { db.exec('ROLLBACK'); return false; }
        const timestamp = now();
        db.prepare(`INSERT INTO machine_notifications (machine_id, last_sent_at) VALUES (?, ?)
          ON CONFLICT(machine_id) DO UPDATE SET last_sent_at = excluded.last_sent_at`).run(machineId, timestamp);
        db.prepare(`UPDATE laundry_sessions SET status = CASE WHEN status IN ${occupied} THEN 'awaiting_pickup' ELSE status END,
          notify_sent_at = ?, updated_at = ? WHERE id = ?`).run(timestamp, timestamp, sessionId);
        db.prepare('DELETE FROM notification_claims WHERE machine_id = ? AND claim_token = ?').run(machineId, claim);
        db.exec('COMMIT');
        return true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    releaseNotify({ machineId, claim }) {
      db.prepare('DELETE FROM notification_claims WHERE machine_id = ? AND claim_token = ?').run(machineId, claim);
    },
    claimDueReminders() {
      expireStaleSessions();
      db.exec('BEGIN IMMEDIATE');
      try {
        const timestamp = now();
        const staleClaim = new Date(Date.parse(timestamp) - 600_000).toISOString();
        const due = db.prepare(`SELECT s.id, s.owner_email, s.owner_link_ciphertext, m.display_name
          FROM laundry_sessions s JOIN machines m ON m.id = s.machine_id
          WHERE s.status IN ${occupied} AND s.reminder_sent_at IS NULL
          AND s.estimated_completion_at <= ?
          AND (s.reminder_claimed_at IS NULL OR s.reminder_claimed_at <= ?)`)
          .all(timestamp, staleClaim);
        const claim = db.prepare('UPDATE laundry_sessions SET reminder_claim_token = ?, reminder_claimed_at = ? WHERE id = ?');
        const claimed = due.map(s => {
          const claimToken = randomBytes(16).toString('hex');
          claim.run(claimToken, timestamp, s.id);
          return { id: s.id, email: s.owner_email, token: decryptToken(s.owner_link_ciphertext),
            machineName: s.display_name, claim: claimToken };
        });
        db.exec('COMMIT');
        return claimed;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    completeReminder({ id, claim }) {
      const timestamp = now();
      return db.prepare(`UPDATE laundry_sessions SET reminder_sent_at = ?, reminder_claim_token = NULL,
        reminder_claimed_at = NULL,
        status = CASE WHEN status IN ${occupied} THEN 'awaiting_pickup' ELSE status END,
        updated_at = ? WHERE id = ? AND reminder_claim_token = ? AND reminder_sent_at IS NULL`)
        .run(timestamp, timestamp, id, claim).changes > 0;
    },
    releaseReminder({ id, claim }) {
      db.prepare('UPDATE laundry_sessions SET reminder_claim_token = NULL, reminder_claimed_at = NULL WHERE id = ? AND reminder_claim_token = ?')
        .run(id, claim);
    },
    activeSessions() {
      expireStaleSessions();
      return db.prepare(`SELECT s.id, m.display_name AS machineName, m.slug AS machineSlug,
        s.status, s.started_at AS startedAt, s.estimated_completion_at AS estimatedCompletionAt,
        s.notify_sent_at AS notifySentAt, s.reminder_sent_at AS reminderSentAt
        FROM laundry_sessions s JOIN machines m ON m.id = s.machine_id
        WHERE s.status IN ${occupied} ORDER BY s.started_at DESC`).all();
    },
    reset(id) {
      const timestamp = now();
      const result = db.prepare(`UPDATE laundry_sessions SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ${occupied}`).run(timestamp, timestamp, id);
      return result.changes > 0;
    },
    purgeOldSessions() {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      return db.prepare("DELETE FROM laundry_sessions WHERE status IN ('picked_up', 'expired', 'cancelled') AND completed_at < ?")
        .run(cutoff).changes;
    },
    raw: db
  };
}
