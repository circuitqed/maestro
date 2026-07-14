import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../data/maestro.db');

let db;

// Project color palette
export const PROJECT_COLORS = [
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

export async function initDb() {
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_contributors (
      project_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contributor',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      ssh_target TEXT,
      path_prefix TEXT,
      status TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_host_paths (
      project_id INTEGER NOT NULL,
      host_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, host_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
    );
  `);

  // Migrations
  try {
    db.exec("ALTER TABLE projects ADD COLUMN color TEXT DEFAULT '#7c3aed'");
  } catch (e) { /* Column already exists */ }

  try {
    db.exec("ALTER TABLE agents ADD COLUMN config JSON DEFAULT '{}'");
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE agents ADD COLUMN last_seen_at DATETIME');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN created_by INTEGER');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE activity_log ADD COLUMN user_id INTEGER');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE agents ADD COLUMN host_id INTEGER');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE agents ADD COLUMN claude_session_id TEXT');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE hosts ADD COLUMN default_root TEXT');
  } catch (e) { /* Column already exists */ }

  try {
    db.exec('ALTER TABLE agents ADD COLUMN last_user_at DATETIME');
  } catch (e) { /* Column already exists */ }

  // Seed the local host row (ssh_target NULL => local) on first run
  const hostCount = db.prepare('SELECT COUNT(*) as count FROM hosts').get().count;
  if (hostCount === 0) {
    db.prepare('INSERT INTO hosts (name, ssh_target) VALUES (?, NULL)').run('oracle');
  }

  // Migrate from single-password to multi-user
  migrateToMultiUser();

  return db;
}

function migrateToMultiUser() {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount > 0) return;

  const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get();
  if (!row) return;

  const result = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')"
  ).run('dave', row.value);
  const userId = result.lastInsertRowid;

  const projects = db.prepare('SELECT id FROM projects').all();
  const insertContrib = db.prepare(
    "INSERT INTO project_contributors (project_id, user_id, role) VALUES (?, ?, 'owner')"
  );
  for (const project of projects) {
    insertContrib.run(project.id, userId);
  }

  db.prepare('UPDATE projects SET created_by = ? WHERE created_by IS NULL').run(userId);
  db.prepare("DELETE FROM settings WHERE key = 'password_hash'").run();
}

// Projects
export function getProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function createProject(name, projectPath, description, color, userId = null) {
  if (!color) {
    const count = db.prepare('SELECT COUNT(*) as count FROM projects').get().count;
    color = PROJECT_COLORS[count % PROJECT_COLORS.length];
  }
  const stmt = db.prepare('INSERT INTO projects (name, path, description, color, created_by) VALUES (?, ?, ?, ?, ?)');
  const result = stmt.run(name, projectPath, description, color, userId);
  const projectId = result.lastInsertRowid;

  if (userId) {
    db.prepare("INSERT INTO project_contributors (project_id, user_id, role) VALUES (?, ?, 'owner')")
      .run(projectId, userId);
  }

  return { id: projectId, name, path: projectPath, description, color, created_by: userId };
}

export function updateProject(id, updates) {
  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.path !== undefined) { fields.push('path = ?'); values.push(updates.path); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.color !== undefined) { fields.push('color = ?'); values.push(updates.color); }
  if (fields.length === 0) return getProject(id);
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id);
}

export function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// Hosts
export function getHosts() {
  return db.prepare('SELECT * FROM hosts ORDER BY created_at').all();
}

export function getHost(id) {
  return db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
}

export function createHost(name, sshTarget, pathPrefix = null, defaultRoot = null) {
  const result = db.prepare('INSERT INTO hosts (name, ssh_target, path_prefix, default_root) VALUES (?, ?, ?, ?)')
    .run(name, sshTarget, pathPrefix, defaultRoot);
  return getHost(result.lastInsertRowid);
}

export function updateHost(id, { name, pathPrefix, defaultRoot } = {}) {
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (pathPrefix !== undefined) { fields.push('path_prefix = ?'); values.push(pathPrefix || null); }
  if (defaultRoot !== undefined) { fields.push('default_root = ?'); values.push(defaultRoot || null); }
  if (fields.length === 0) return getHost(id);
  values.push(id);
  db.prepare(`UPDATE hosts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getHost(id);
}

export function updateHostStatus(id, status) {
  db.prepare('UPDATE hosts SET status = ? WHERE id = ?').run(status, id);
  return getHost(id);
}

export function deleteHost(id) {
  db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
}

export function countAgentsOnHost(hostId) {
  return db.prepare('SELECT COUNT(*) as count FROM agents WHERE host_id = ?').get(hostId).count;
}

// Per-host project paths (projects.path is the LOCAL host path; remote hosts
// keep their own path here keyed by (project_id, host_id))
export function getProjectHostPath(projectId, hostId) {
  return db.prepare(
    'SELECT * FROM project_host_paths WHERE project_id = ? AND host_id = ?'
  ).get(projectId, hostId);
}

export function setProjectHostPath(projectId, hostId, projectPath) {
  db.prepare(
    'INSERT OR REPLACE INTO project_host_paths (project_id, host_id, path) VALUES (?, ?, ?)'
  ).run(projectId, hostId, projectPath);
  return getProjectHostPath(projectId, hostId);
}

export function deleteProjectHostPath(projectId, hostId) {
  db.prepare('DELETE FROM project_host_paths WHERE project_id = ? AND host_id = ?')
    .run(projectId, hostId);
}

export function getProjectHostPaths(projectId) {
  return db.prepare(`
    SELECT php.project_id, php.host_id, php.path,
           h.name AS host_name, h.ssh_target AS host_ssh_target
    FROM project_host_paths php
    INNER JOIN hosts h ON php.host_id = h.id
    WHERE php.project_id = ?
    ORDER BY h.created_at
  `).all(projectId);
}

// Agents
function parseAgentConfig(row) {
  if (!row) return row;
  try {
    row.config = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {});
  } catch {
    row.config = {};
  }
  // Normalize legacy configs to include provider
  if (!row.config.provider) {
    row.config.provider = row.config.type === 'shell' ? 'shell' : 'claude';
  }
  return row;
}

export function getAgents() {
  return db.prepare(`
    SELECT a.*, p.name as project_name, p.color as project_color,
           h.name AS host_name, h.ssh_target AS host_ssh_target, h.path_prefix AS host_path_prefix
    FROM agents a
    LEFT JOIN projects p ON a.project_id = p.id
    LEFT JOIN hosts h ON a.host_id = h.id
    ORDER BY a.created_at DESC
  `).all().map(parseAgentConfig);
}

export function getAgent(id) {
  return parseAgentConfig(db.prepare(`
    SELECT a.*, p.name as project_name, p.color as project_color,
           h.name AS host_name, h.ssh_target AS host_ssh_target, h.path_prefix AS host_path_prefix
    FROM agents a
    LEFT JOIN projects p ON a.project_id = p.id
    LEFT JOIN hosts h ON a.host_id = h.id
    WHERE a.id = ?
  `).get(id));
}

export function getAgentsByProject(projectId) {
  return db.prepare(`
    SELECT a.*, h.name AS host_name, h.ssh_target AS host_ssh_target, h.path_prefix AS host_path_prefix
    FROM agents a
    LEFT JOIN hosts h ON a.host_id = h.id
    WHERE a.project_id = ?
    ORDER BY a.created_at DESC
  `).all(projectId).map(parseAgentConfig);
}

// Is a tmux session name already used by an agent on this host? (host_id null =
// local; SQLite `IS` is null-safe equality so it matches both null and a number.)
export function isSessionNameTaken(hostId, screenSession) {
  return !!db
    .prepare('SELECT 1 FROM agents WHERE screen_session = ? AND host_id IS ? LIMIT 1')
    .get(screenSession, hostId ?? null);
}

export function createAgent(projectId, name, screenSession, status = 'stopped', config = {}, hostId = null) {
  const stmt = db.prepare('INSERT INTO agents (project_id, name, screen_session, status, config, host_id) VALUES (?, ?, ?, ?, ?, ?)');
  const result = stmt.run(projectId, name, screenSession, status, JSON.stringify(config), hostId);
  return { id: result.lastInsertRowid, project_id: projectId, name, screen_session: screenSession, status, config, host_id: hostId };
}

export function updateAgentStatus(id, status) {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?').run(status, now, id);
  return getAgent(id);
}

export function updateAgent(id, { name } = {}) {
  if (typeof name === 'string' && name.trim()) {
    db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(name.trim(), id);
  }
  return getAgent(id);
}

export function updateAgentLastSeen(id) {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, id);
}

// Timestamp of the most recent input the user sent to this agent (chat send box).
export function updateAgentUserActivity(id) {
  const now = new Date().toISOString();
  db.prepare('UPDATE agents SET last_user_at = ? WHERE id = ?').run(now, id);
}

export function setAgentClaudeSessionId(id, sessionId) {
  db.prepare('UPDATE agents SET claude_session_id = ? WHERE id = ?').run(sessionId, id);
  return getAgent(id);
}

export function deleteAgent(id) {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

// Settings
export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// Activity log
export function logActivity(eventType, projectId, agentId, message, userId = null) {
  db.prepare('INSERT INTO activity_log (event_type, project_id, agent_id, message, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(eventType, projectId, agentId, message, userId);
}

export function getRecentActivity(limit = 50) {
  return db.prepare(`
    SELECT al.*, p.name as project_name, a.name as agent_name
    FROM activity_log al
    LEFT JOIN projects p ON al.project_id = p.id
    LEFT JOIN agents a ON al.agent_id = a.id
    ORDER BY al.timestamp DESC
    LIMIT ?
  `).all(limit);
}

// Users
export function createUser(username, passwordHash, role = 'user') {
  const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  const result = stmt.run(username, passwordHash, role);
  return { id: result.lastInsertRowid, username, role };
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function getUserById(id) {
  return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id);
}

export function getUsers() {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all();
}

export function updateUser(id, updates) {
  const fields = [];
  const values = [];
  if (updates.password_hash !== undefined) { fields.push('password_hash = ?'); values.push(updates.password_hash); }
  if (updates.role !== undefined) { fields.push('role = ?'); values.push(updates.role); }
  if (fields.length === 0) return getUserById(id);
  values.push(id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function getAdminCount() {
  return db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
}

export function getUserCount() {
  return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
}

// Project contributors
export function getProjectsForUser(userId) {
  return db.prepare(`
    SELECT p.*, pc.role as user_role
    FROM projects p
    INNER JOIN project_contributors pc ON p.id = pc.project_id
    WHERE pc.user_id = ?
    ORDER BY p.created_at DESC
  `).all(userId);
}

export function getAgentsForUser(userId) {
  return db.prepare(`
    SELECT a.*, p.name as project_name, p.color as project_color,
           h.name AS host_name, h.ssh_target AS host_ssh_target, h.path_prefix AS host_path_prefix
    FROM agents a
    LEFT JOIN projects p ON a.project_id = p.id
    LEFT JOIN hosts h ON a.host_id = h.id
    INNER JOIN project_contributors pc ON a.project_id = pc.project_id
    WHERE pc.user_id = ?
    ORDER BY a.created_at DESC
  `).all(userId).map(parseAgentConfig);
}

export function addProjectContributor(projectId, userId, role = 'contributor') {
  db.prepare(
    'INSERT OR REPLACE INTO project_contributors (project_id, user_id, role) VALUES (?, ?, ?)'
  ).run(projectId, userId, role);
}

export function removeProjectContributor(projectId, userId) {
  db.prepare('DELETE FROM project_contributors WHERE project_id = ? AND user_id = ?')
    .run(projectId, userId);
}

export function getProjectContributors(projectId) {
  return db.prepare(`
    SELECT u.id, u.username, u.role as user_role, pc.role as project_role, pc.added_at
    FROM project_contributors pc
    INNER JOIN users u ON pc.user_id = u.id
    WHERE pc.project_id = ?
    ORDER BY pc.role DESC, u.username
  `).all(projectId);
}

export function userHasProjectAccess(userId, projectId) {
  const row = db.prepare(
    'SELECT 1 FROM project_contributors WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId);
  return !!row;
}

export function isProjectOwner(userId, projectId) {
  const row = db.prepare(
    "SELECT 1 FROM project_contributors WHERE project_id = ? AND user_id = ? AND role = 'owner'"
  ).get(projectId, userId);
  return !!row;
}

export function getOrphanedProjectIds() {
  return db.prepare(`
    SELECT p.id FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM project_contributors pc WHERE pc.project_id = p.id
    )
  `).all().map(r => r.id);
}
