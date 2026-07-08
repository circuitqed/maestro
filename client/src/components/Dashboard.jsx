import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import ProjectCard from './ProjectCard';
import AgentRow from './AgentRow';
import AddAgentForm from './AddAgentForm';

// Collapsible section component
function Section({ title, count, defaultCollapsed = false, children, variant = 'default' }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (count === 0) return null;

  const variantStyles = {
    default: 'text-gray-400',
    active: 'text-blue-400',
    idle: 'text-green-400',
    stopped: 'text-gray-500',
  };

  return (
    <div className="mb-6">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 mb-3 group"
      >
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className={`text-sm font-medium ${variantStyles[variant]}`}>
          {title}
        </span>
        <span className="text-xs text-gray-600">({count})</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function Dashboard() {
  const { projects, agents, createProject, agentStates, loadAgents } = useApp();
  const [view, setView] = useState(() => localStorage.getItem('dashboardView') || 'projects');
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', path: '', description: '' });
  const [error, setError] = useState('');

  // Persist view preference
  useEffect(() => {
    localStorage.setItem('dashboardView', view);
  }, [view]);

  // Re-render periodically so the "recently active" window stays current even
  // when nothing else changes (e.g. an idle agent crossing the 10-min mark).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Refresh the agent list (fresh status + sort timestamps) whenever any agent
  // changes state on the notifications socket — keeps the tab live in realtime.
  useEffect(() => {
    const t = setTimeout(() => loadAgents(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentStates]);

  // Activity classification. Prefer the realtime busy/idle from the notifications
  // socket, falling back to the last-fetched DB status. An agent is "active" if
  // it's working now OR interacted within the last 10 minutes (recent agent
  // response or user input) — i.e. still in an active conversation.
  const RECENT_ACTIVE_MS = 10 * 60 * 1000;
  const tsOf = (v) => (v ? new Date(v).getTime() : 0);
  const liveStatus = (a) => {
    const live = agentStates[a.id];
    return live === 'busy' || live === 'idle' ? live : a.status;
  };
  const lastActivity = (a) => Math.max(tsOf(a.last_seen_at), tsOf(a.last_user_at));
  const bucket = (a) => {
    const s = liveStatus(a);
    if (s === 'stopped') return 'stopped';
    if (s === 'busy' || s === 'running') return 'active';
    if (now - lastActivity(a) < RECENT_ACTIVE_MS) return 'active';
    return 'idle';
  };

  const handleAddProject = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await createProject(newProject);
      setNewProject({ name: '', path: '', description: '' });
      setShowAddProject(false);
    } catch (err) {
      setError(err.message);
    }
  };

  // Group agents by project for projects view
  const projectAgents = {};
  agents.forEach((agent) => {
    if (agent.project_id) {
      if (!projectAgents[agent.project_id]) {
        projectAgents[agent.project_id] = [];
      }
      projectAgents[agent.project_id].push(agent);
    }
  });

  // Categorize projects by their agents' activity (same rules as agents)
  const getProjectActivity = (project) => {
    const buckets = (projectAgents[project.id] || []).map(bucket);
    if (buckets.includes('active')) return 'active';
    if (buckets.includes('idle')) return 'idle';
    return 'stopped';
  };

  const activeProjects = projects.filter((p) => getProjectActivity(p) === 'active');
  const idleProjects = projects.filter((p) => getProjectActivity(p) === 'idle');
  const stoppedProjects = projects.filter((p) => getProjectActivity(p) === 'stopped');

  // Within each group, sort by most-recent agent response (last_seen_at), then
  // most-recent user input (last_user_at).
  const byRecency = (a, b) =>
    (tsOf(b.last_seen_at) - tsOf(a.last_seen_at)) ||
    (tsOf(b.last_user_at) - tsOf(a.last_user_at)) ||
    (a.name || '').localeCompare(b.name || '');
  const activeAgents = agents.filter((a) => bucket(a) === 'active').sort(byRecency);
  const idleAgents = agents.filter((a) => bucket(a) === 'idle').sort(byRecency);
  const stoppedAgents = agents.filter((a) => bucket(a) === 'stopped').sort(byRecency);

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      {/* Header with view toggle */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
          <button
            onClick={() => setView('projects')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              view === 'projects'
                ? 'bg-primary-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Projects
          </button>
          <button
            onClick={() => setView('agents')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              view === 'agents'
                ? 'bg-primary-600 text-white'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Agents
          </button>
        </div>

        {view === 'projects' ? (
          <button
            onClick={() => setShowAddProject(!showAddProject)}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm
                       font-medium rounded transition-colors"
          >
            + Add Project
          </button>
        ) : (
          <button
            onClick={() => setShowAddAgent(!showAddAgent)}
            className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm
                       font-medium rounded transition-colors"
          >
            + Add Agent
          </button>
        )}
      </div>

      {/* Add Project Form */}
      {view === 'projects' && showAddProject && (
        <form onSubmit={handleAddProject} className="bg-gray-800 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <input
              type="text"
              placeholder="Project name"
              value={newProject.name}
              onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
              className="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white
                         focus:outline-none focus:ring-2 focus:ring-primary-500"
              required
            />
            <input
              type="text"
              placeholder="Path (optional)"
              value={newProject.path}
              onChange={(e) => setNewProject({ ...newProject, path: e.target.value })}
              className="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white
                         focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newProject.description}
              onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
              className="px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white
                         focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm mb-2">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowAddProject(false)}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Add Agent Form (Agents view only) */}
      {view === 'agents' && showAddAgent && (
        <div className="bg-gray-800 rounded-lg p-4 mb-4">
          <AddAgentForm
            onClose={() => setShowAddAgent(false)}
            showProjectSelector
            projects={projects}
          />
        </div>
      )}

      {/* Projects View */}
      {view === 'projects' && (
        <div>
          {/* Active Projects */}
          <Section title="Active" count={activeProjects.length} variant="active">
            <div className="space-y-4">
              {activeProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  agents={projectAgents[project.id] || []}
                />
              ))}
            </div>
          </Section>

          {/* Idle Projects */}
          <Section title="Ready" count={idleProjects.length} variant="idle" defaultCollapsed={activeProjects.length > 0}>
            <div className="space-y-4">
              {idleProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  agents={projectAgents[project.id] || []}
                />
              ))}
            </div>
          </Section>

          {/* Stopped Projects */}
          <Section title="Stopped" count={stoppedProjects.length} variant="stopped" defaultCollapsed={true}>
            <div className="space-y-4">
              {stoppedProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  agents={projectAgents[project.id] || []}
                />
              ))}
            </div>
          </Section>

          {projects.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No projects yet. Add one to get started.
            </div>
          )}
        </div>
      )}

      {/* Agents View */}
      {view === 'agents' && (
        <div>
          {/* Active Agents */}
          <Section title="Active" count={activeAgents.length} variant="active">
            <div className="space-y-2">
              {activeAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} showProject />
              ))}
            </div>
          </Section>

          {/* Idle Agents */}
          <Section title="Ready" count={idleAgents.length} variant="idle" defaultCollapsed={activeAgents.length > 0}>
            <div className="space-y-2">
              {idleAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} showProject />
              ))}
            </div>
          </Section>

          {/* Stopped Agents */}
          <Section title="Stopped" count={stoppedAgents.length} variant="stopped" defaultCollapsed={true}>
            <div className="space-y-2">
              {stoppedAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} showProject />
              ))}
            </div>
          </Section>

          {agents.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No agents yet. Add one to get started.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Dashboard;
