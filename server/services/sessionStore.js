import Database from 'better-sqlite3';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../data/sessions.db');

/**
 * SQLite session store for express-session
 */
class SQLiteStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.db = new Database(dbPath);
    this.ttl = options.ttl || 86400000; // 24 hours default

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);

    // Create index for cleanup
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)
    `);

    // Prepare statements
    this.getStmt = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?');
    this.setStmt = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)');
    this.destroyStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?');
    this.cleanupStmt = this.db.prepare('DELETE FROM sessions WHERE expired <= ?');

    // Cleanup expired sessions periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      if (row) {
        callback(null, JSON.parse(row.sess));
      } else {
        callback(null, null);
      }
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const expired = Date.now() + this.ttl;
      this.setStmt.run(sid, JSON.stringify(sess), expired);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const expired = Date.now() + this.ttl;
      this.touchStmt.run(expired, sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  cleanup() {
    try {
      this.cleanupStmt.run(Date.now());
    } catch (err) {
      console.error('Session cleanup error:', err);
    }
  }

  close() {
    clearInterval(this.cleanupInterval);
    this.db.close();
  }
}

export default SQLiteStore;
