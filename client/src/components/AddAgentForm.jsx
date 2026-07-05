import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import ProviderIcon from './ProviderIcon';

const PROVIDERS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'gemini', name: 'Gemini' },
  { id: 'aider', name: 'Aider' },
  { id: 'custom', name: 'Custom' },
  { id: 'shell', name: 'Shell' },
];

function sanitizeSessionName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function AddAgentForm({ projectId, onClose, type = 'agent', showProjectSelector = false, projects = [] }) {
  const { createAgent, hosts } = useApp();
  const [provider, setProvider] = useState(type === 'shell' ? 'shell' : 'claude');
  const [name, setName] = useState('');
  const [screenSession, setScreenSession] = useState('');
  const [sessionEdited, setSessionEdited] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId || '');
  const [selectedHostId, setSelectedHostId] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [flags, setFlags] = useState('');
  const [model, setModel] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const hideProviderSelector = type === 'shell';

  // Host selection: default to the local host (ssh_target null); only shown when
  // more than one host is configured
  const showHostSelector = hosts.length > 1;
  const localHost = hosts.find((h) => !h.ssh_target);
  const effectiveHostId = selectedHostId ?? localHost?.id ?? null;

  const handleNameChange = (value) => {
    setName(value);
    if (!sessionEdited) {
      setScreenSession(sanitizeSessionName(value));
    }
  };

  const handleSessionChange = (value) => {
    setScreenSession(value);
    setSessionEdited(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const config = { provider };
      if (flags) config.flags = flags;
      if (model && provider === 'aider') config.model = model;
      if (customCommand && provider === 'custom') config.customCommand = customCommand;

      const payload = {
        projectId: showProjectSelector ? selectedProjectId : projectId,
        name,
        screenSession,
        config,
      };
      if (showHostSelector && effectiveHostId != null) {
        payload.hostId = Number(effectiveHostId);
      }

      await createAgent(payload);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-3 bg-gray-700/30 rounded-lg mt-2">
      {/* Provider selector */}
      {!hideProviderSelector && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setProvider(p.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors
                ${provider === p.id
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
            >
              <ProviderIcon provider={p.id} className="w-3.5 h-3.5" />
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Project selector (when used from Dashboard agents view) */}
      {showProjectSelector && (
        <div className="mb-2">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                       focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Host selector (only when remote hosts are configured) */}
      {showHostSelector && (
        <div className="mb-2">
          <select
            value={effectiveHostId ?? ''}
            onChange={(e) => setSelectedHostId(Number(e.target.value))}
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                       focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}{h.ssh_target ? ` (${h.ssh_target})` : ' (local)'}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Name and session fields */}
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder={`${provider === 'shell' ? 'Shell' : 'Agent'} name`}
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                     focus:outline-none focus:ring-1 focus:ring-primary-500"
          required
          autoFocus
        />
        <input
          type="text"
          placeholder="tmux session name"
          value={screenSession}
          onChange={(e) => handleSessionChange(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                     focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>

      {/* Custom command field (required for custom provider) */}
      {provider === 'custom' && (
        <div className="mb-2">
          <input
            type="text"
            placeholder="Command to run (e.g. htop, python3 agent.py)"
            value={customCommand}
            onChange={(e) => setCustomCommand(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                       focus:outline-none focus:ring-1 focus:ring-primary-500"
            required
          />
        </div>
      )}

      {/* Model field (for aider) */}
      {provider === 'aider' && (
        <div className="mb-2">
          <input
            type="text"
            placeholder="Model (e.g. gpt-4o, claude-sonnet-4-20250514)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                       focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
        </div>
      )}

      {/* Advanced section (flags override) */}
      {provider !== 'shell' && provider !== 'custom' && (
        <div className="mb-2">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-gray-400 hover:text-gray-300 transition-colors flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
              fill="currentColor" viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
            Advanced
          </button>
          {showAdvanced && (
            <input
              type="text"
              placeholder="CLI flags override"
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                         focus:outline-none focus:ring-1 focus:ring-primary-500 font-mono text-xs"
            />
          )}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors disabled:opacity-50"
        >
          {loading ? 'Creating...' : `Add ${provider === 'shell' ? 'Shell' : 'Agent'}`}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default AddAgentForm;
