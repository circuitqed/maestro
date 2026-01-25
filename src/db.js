const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/maestro.db'));

// Project color palette
const PROJECT_COLORS = [
  '#7c3aed', // Purple
  '#2563eb', // Blue
  '#0891b2', // Cyan
  '#059669', // Green
  '#ca8a04', // Yellow
  '#ea580c', // Orange
  '#dc2626', // Red
  '#db2777', // Pink
  '#7c2d12', // Brown
  '#4b5563', // Gray
  '#0f766e', // Teal
  '#4f46e5', // Indigo
];

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT,
    description TEXT,
    color TEXT DEFAULT '#7c3aed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT NOT NULL,
    screen_session TEXT,
    status TEXT DEFAULT 'stopped',
    config JSON DEFAULT '{}',
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    project_id INTEGER,
    agent_id INTEGER,
    message TEXT
  );
`);

// Add color column if it doesn't exist (migration)
try {
  db.exec('ALTER TABLE projects ADD COLUMN color TEXT DEFAULT \'#7c3aed\'');
} catch (e) {
  // Column already exists
}

// Add config and last_seen_at columns if they don't exist (migration)
try {
  db.exec('ALTER TABLE agents ADD COLUMN config JSON DEFAULT \'{}\'');
} catch (e) {}
try {
  db.exec('ALTER TABLE agents ADD COLUMN last_seen_at DATETIME');
} catch (e) {}

module.exports = {
  PROJECT_COLORS,

  getProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  },

  getProject(id) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  },

  createProject(name, projectPath, description, color) {
    // Auto-assign color if not provided
    if (!color) {
      const count = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
      color = PROJECT_COLORS[count % PROJECT_COLORS.length];
    }
    const stmt = db.prepare('INSERT INTO projects (name, path, description, color) VALUES (?, ?, ?, ?)');
    const result = stmt.run(name, projectPath, description, color);
    return { id: result.lastInsertRowid, name, path: projectPath, description, color };
  },

  updateProject(id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.path !== undefined) { fields.push('path = ?'); values.push(updates.path); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
    if (fields.length === 0) return this.getProject(id);
    values.push(id);
    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getProject(id);
  },

  deleteProject(id) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },

  getAgents() {
    return db.prepare(`
      SELECT a.*, p.name as project_name, p.color as project_color
      FROM agents a
      LEFT JOIN projects p ON a.project_id = p.id
      ORDER BY a.created_at DESC
    `).all();
  },

  getAgent(id) {
    return db.prepare(`
      SELECT a.*, p.name as project_name, p.color as project_color
      FROM agents a
      LEFT JOIN projects p ON a.project_id = p.id
      WHERE a.id = ?
    `).get(id);
  },

  getAgentsByProject(projectId) {
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  },

  createAgent(projectId, name, screenSession, status = 'stopped', config = {}) {
    const stmt = db.prepare('INSERT INTO agents (project_id, name, screen_session, status, config) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(projectId, name, screenSession, status, JSON.stringify(config));
    return { id: result.lastInsertRowid, project_id: projectId, name, screen_session: screenSession, status, config };
  },

  updateAgentStatus(id, status) {
    const now = new Date().toISOString();
    db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?').run(status, now, id);
    return this.getAgent(id);
  },

  updateAgentLastSeen(id) {
    const now = new Date().toISOString();
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, id);
  },

  deleteAgent(id) {
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  },

  // Settings
  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },

  // Activity log
  logActivity(eventType, projectId, agentId, message) {
    db.prepare('INSERT INTO activity_log (event_type, project_id, agent_id, message) VALUES (?, ?, ?, ?)')
      .run(eventType, projectId, agentId, message);
  },

  getRecentActivity(limit = 50) {
    return db.prepare(`
      SELECT al.*, p.name as project_name, a.name as agent_name
      FROM activity_log al
      LEFT JOIN projects p ON al.project_id = p.id
      LEFT JOIN agents a ON al.agent_id = a.id
      ORDER BY al.timestamp DESC
      LIMIT ?
    `).all(limit);
  }
};
