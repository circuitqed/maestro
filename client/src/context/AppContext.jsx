import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNotifications } from '../hooks/useNotifications';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const [hosts, setHosts] = useState([]);
  const [activeTerminal, setActiveTerminal] = useState(null);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Notifications
  const {
    agentStates,
    soundEnabled,
    toggleSound,
    connected: notificationsConnected,
    requestPermission,
  } = useNotifications(authenticated);

  // Check auth status on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Load data when authenticated
  useEffect(() => {
    if (authenticated) {
      loadProjects();
      loadAgents();
      loadHosts();
    }
  }, [authenticated]);

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();
      setAuthenticated(data.authenticated);
      setUser(data.user);
      setSetupRequired(data.setupRequired || false);
    } catch (err) {
      console.error('Auth check failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const login = async (username, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }

    const data = await res.json();
    setAuthenticated(true);
    setUser(data.user);
    return true;
  };

  const setup = async (username, password) => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Setup failed');
    }

    const data = await res.json();
    setAuthenticated(true);
    setUser(data.user);
    setSetupRequired(false);
    return true;
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthenticated(false);
    setUser(null);
    setProjects([]);
    setAgents([]);
  };

  const loadProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  };

  const loadAgents = async () => {
    try {
      const res = await fetch('/api/agents');
      const data = await res.json();
      setAgents(data);
    } catch (err) {
      console.error('Failed to load agents:', err);
    }
  };

  const loadHosts = async () => {
    try {
      const res = await fetch('/api/hosts');
      const data = await res.json();
      setHosts(data);
    } catch (err) {
      console.error('Failed to load hosts:', err);
    }
  };

  const createProject = async (projectData) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectData),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create project');
    }

    const created = await res.json();
    await loadProjects();
    await loadAgents(); // a seeded default agent may have been created
    return created;
  };

  const updateProject = async (id, updates) => {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update project');
    }

    await loadProjects();
    return res.json();
  };

  const deleteProject = async (id) => {
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete project');
    }

    await loadProjects();
    await loadAgents();
  };

  // Per-host project working directories
  const getProjectPaths = async (projectId) => {
    const res = await fetch(`/api/projects/${projectId}/paths`);
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to load project paths');
    }
    return res.json();
  };

  const setProjectHostPath = async (projectId, hostId, path, create = false) => {
    const res = await fetch(`/api/projects/${projectId}/paths/${hostId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, create }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to set project path');
    }
    const result = await res.json();
    await loadProjects();
    return result;
  };

  const deleteProjectHostPath = async (projectId, hostId) => {
    const res = await fetch(`/api/projects/${projectId}/paths/${hostId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete project path');
    }
    await loadProjects();
    return res.json();
  };

  const createAgent = async (agentData) => {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agentData),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create agent');
    }

    await loadAgents();
    return res.json();
  };

  const updateAgent = async (id, updates) => {
    const res = await fetch(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update agent');
    }

    await loadAgents();
    return res.json();
  };

  const updateAgentStatus = async (id, status) => {
    const res = await fetch(`/api/agents/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update agent status');
    }

    await loadAgents();
  };

  const startAgent = async (id) => {
    const res = await fetch(`/api/agents/${id}/start`, {
      method: 'POST',
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to start agent');
    }

    await loadAgents();
    return res.json();
  };

  const stopAgent = async (id) => {
    const res = await fetch(`/api/agents/${id}/stop`, {
      method: 'POST',
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to stop agent');
    }

    await loadAgents();
    return res.json();
  };

  const deleteAgent = async (id) => {
    const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete agent');
    }

    await loadAgents();
  };

  // User management (admin)
  const loadUsers = async () => {
    const res = await fetch('/api/auth/users');
    if (!res.ok) throw new Error('Failed to load users');
    return res.json();
  };

  const createNewUser = async (userData) => {
    const res = await fetch('/api/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create user');
    }
    return res.json();
  };

  const deleteUserAccount = async (id) => {
    const res = await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete user');
    }
    return res.json();
  };

  const updateUserAccount = async (id, updates) => {
    const res = await fetch(`/api/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update user');
    }
    return res.json();
  };

  // Contributor management
  const addContributor = async (projectId, userId) => {
    const res = await fetch(`/api/projects/${projectId}/contributors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to add contributor');
    }
    await loadProjects();
  };

  const removeContributor = async (projectId, userId) => {
    const res = await fetch(`/api/projects/${projectId}/contributors/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to remove contributor');
    }
    await loadProjects();
  };

  // Host management
  const createHost = async (hostData) => {
    const res = await fetch('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hostData),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create host');
    }
    await loadHosts();
    return res.json();
  };

  const updateHost = async (id, updates) => {
    const res = await fetch(`/api/hosts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update host');
    }
    await loadHosts();
    return res.json();
  };

  const deleteHost = async (id) => {
    const res = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to delete host');
    }
    await loadHosts();
  };

  const testHost = async (id) => {
    const res = await fetch(`/api/hosts/${id}/test`, { method: 'POST' });
    const result = await res.json();
    // Reload hosts to pick up the persisted status change
    await loadHosts();
    return result;
  };

  // Track close timeout to cancel it if opening a new terminal
  const closeTimeoutRef = React.useRef(null);

  // Open an agent in either the "terminal" or "chat" view. activeTerminal is an
  // object: { agentId, session, hostId, mode }.
  const openAgentView = useCallback((agent, mode = 'terminal') => {
    // Cancel any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setActiveTerminal({
      agentId: agent.id,
      session: agent.screen_session,
      hostId: agent.host_id ?? null,
      mode,
    });
    setTerminalOpen(true);
  }, []);

  // Back-compat: open a terminal by raw session name (no associated agent id).
  const openTerminal = useCallback((sessionName, hostId = null) => {
    // Cancel any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setActiveTerminal({ agentId: null, session: sessionName, hostId, mode: 'terminal' });
    setTerminalOpen(true);
  }, []);

  // Swap the rendered view for the currently open agent panel in place.
  const setViewMode = useCallback((mode) => {
    setActiveTerminal((prev) => (prev ? { ...prev, mode } : prev));
  }, []);

  // Inject text into an agent's tmux session (used by the chat send box).
  const sendAgentInput = useCallback(async (agentId, text) => {
    const res = await fetch(`/api/agents/${agentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      let message = 'Failed to send input';
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(message);
    }
    return res.json();
  }, []);

  const answerAgentQuestion = useCallback(async (agentId, choice) => {
    const res = await fetch(`/api/agents/${agentId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    });
    if (!res.ok) {
      let message = 'Failed to answer';
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        // ignore JSON parse errors
      }
      throw new Error(message);
    }
    return res.json();
  }, []);

  const getAgentPane = useCallback(async (agentId) => {
    const res = await fetch(`/api/agents/${agentId}/pane`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  }, []);

  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    // Delay clearing active terminal to allow close animation
    closeTimeoutRef.current = setTimeout(() => {
      setActiveTerminal(null);
      closeTimeoutRef.current = null;
    }, 300);
  }, []);

  const value = {
    // Auth
    authenticated,
    user,
    setupRequired,
    loading,
    login,
    setup,
    logout,

    // Data
    projects,
    agents,
    hosts,
    loadProjects,
    loadAgents,
    loadHosts,

    // CRUD
    createProject,
    updateProject,
    deleteProject,
    getProjectPaths,
    setProjectHostPath,
    deleteProjectHostPath,
    createAgent,
    updateAgent,
    updateAgentStatus,
    startAgent,
    stopAgent,
    deleteAgent,

    // User management
    loadUsers,
    createNewUser,
    deleteUserAccount,
    updateUserAccount,

    // Contributor management
    addContributor,
    removeContributor,

    // Host management
    createHost,
    updateHost,
    deleteHost,
    testHost,

    // Terminal / agent views
    activeTerminal,
    terminalOpen,
    openTerminal,
    openAgentView,
    setViewMode,
    sendAgentInput,
    answerAgentQuestion,
    getAgentPane,
    closeTerminal,

    // Notifications
    agentStates,
    soundEnabled,
    toggleSound,
    notificationsConnected,
    requestPermission,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
