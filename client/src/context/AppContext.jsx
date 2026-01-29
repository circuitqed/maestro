import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNotifications } from '../hooks/useNotifications';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
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
    }
  }, [authenticated]);

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();
      setAuthenticated(data.authenticated);
      setPasswordRequired(data.passwordRequired);
    } catch (err) {
      console.error('Auth check failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const login = async (password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }

    setAuthenticated(true);
    return true;
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthenticated(false);
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

    await loadProjects();
    return res.json();
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

  // Track close timeout to cancel it if opening a new terminal
  const closeTimeoutRef = React.useRef(null);

  const openTerminal = useCallback((sessionName) => {
    // Cancel any pending close timeout
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setActiveTerminal(sessionName);
    setTerminalOpen(true);
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
    passwordRequired,
    loading,
    login,
    logout,

    // Data
    projects,
    agents,
    loadProjects,
    loadAgents,

    // CRUD
    createProject,
    updateProject,
    deleteProject,
    createAgent,
    updateAgentStatus,
    startAgent,
    stopAgent,
    deleteAgent,

    // Terminal
    activeTerminal,
    terminalOpen,
    openTerminal,
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
