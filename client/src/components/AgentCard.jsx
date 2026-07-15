import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import ProviderIcon from './ProviderIcon';

const STATUS_COLORS = {
  running: 'bg-blue-500',
  busy: 'bg-blue-500',
  idle: 'bg-green-500',
  stopped: 'bg-gray-500',
};

function AgentCard({ agent }) {
  const { deleteAgent, startAgent, stopAgent, openAgentView, updateAgent } = useApp();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(agent.name);
  const editInputRef = useRef(null);

  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    setEditName(agent.name);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditName(agent.name);
  };

  const saveEdit = async () => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === agent.name) {
      cancelEdit();
      return;
    }
    try {
      await updateAgent(agent.id, { name: trimmed });
      setEditing(false);
    } catch (err) {
      console.error('Failed to rename agent:', err);
      cancelEdit();
    }
  };

  const handleDelete = async () => {
    await deleteAgent(agent.id);
    setShowConfirm(false);
  };

  const handleToggleStatus = async () => {
    setLoading(true);
    try {
      if (agent.status === 'running' || agent.status === 'idle') {
        await stopAgent(agent.id);
      } else {
        await startAgent(agent.id);
        // Open terminal after starting
        if (agent.screen_session) {
          openAgentView(agent, 'terminal');
        }
      }
    } catch (err) {
      console.error('Failed to toggle agent:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenTerminal = () => {
    if (agent.screen_session) {
      openAgentView(agent, 'terminal');
    }
  };

  const handleOpenChat = () => {
    if (agent.screen_session) {
      openAgentView(agent, 'chat');
    }
  };

  const isRunning = agent.status === 'running' || agent.status === 'idle' || agent.status === 'busy';
  const provider = agent.config?.provider || 'claude';

  return (
    <div className="bg-gray-800 rounded-lg p-4 hover:bg-gray-750 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[agent.status]} ${
              isRunning ? 'animate-pulse' : ''
            }`}
            title={agent.status}
          />
          <ProviderIcon provider={provider} className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          {editing ? (
            <input
              ref={editInputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                else if (e.key === 'Escape') cancelEdit();
              }}
              className="font-medium text-white bg-gray-900 border border-gray-600 rounded px-1.5 py-0.5 text-sm flex-1 min-w-0 focus:outline-none focus:border-blue-500"
            />
          ) : (
            <h3
              className="font-medium text-white truncate cursor-text hover:text-blue-300"
              onDoubleClick={startEdit}
              title="Double-click to rename"
            >
              {agent.name}
            </h3>
          )}
        </div>
        {!editing && (
          <div className="flex items-center ml-2">
            <button
              onClick={startEdit}
              className="p-1 text-gray-500 hover:text-blue-400 transition-colors"
              title="Rename agent (takes effect on next start)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="p-1 text-gray-500 hover:text-red-400 transition-colors"
              title="Delete agent"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {agent.project_name && (
        <div className="flex items-center gap-1.5 mb-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: agent.project_color || '#4b5563' }}
          />
          <span
            className="text-sm truncate"
            style={{ color: agent.project_color || '#9ca3af' }}
          >
            {agent.project_name}
          </span>
        </div>
      )}

      {(agent.screen_session || agent.host_ssh_target) && (
        <div className="flex items-center gap-2 mb-3 min-w-0">
          {agent.screen_session && (
            <p className="text-gray-500 text-xs font-mono truncate">{agent.screen_session}</p>
          )}
          {agent.host_ssh_target && (
            <span
              className="flex items-center gap-1 rounded bg-gray-700 text-[10px] text-gray-300 px-1.5 py-0.5 flex-shrink-0"
              title={agent.host_ssh_target}
            >
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              {agent.host_name}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleToggleStatus}
          disabled={loading || !agent.screen_session}
          className={`flex-1 px-3 py-1.5 text-sm font-medium rounded transition-colors disabled:opacity-50
                     ${isRunning
                       ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
                       : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
                     }`}
        >
          {loading ? '...' : isRunning ? 'Stop' : 'Start'}
        </button>

        {agent.screen_session && (provider === 'claude' || provider === 'codex') && (
          <button
            onClick={handleOpenChat}
            className="px-3 py-1.5 text-sm font-medium bg-gray-700 text-gray-300
                       hover:bg-gray-600 rounded transition-colors"
            title="Open chat view"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </button>
        )}

        {agent.screen_session && (
          <button
            onClick={handleOpenTerminal}
            className="px-3 py-1.5 text-sm font-medium bg-gray-700 text-gray-300
                       hover:bg-gray-600 rounded transition-colors"
            title="Open terminal"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showConfirm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setShowConfirm(false)} />
          <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg p-6 max-w-sm w-full shadow-xl">
              <h4 className="text-lg font-semibold text-white mb-2">Delete {provider === 'shell' ? 'Shell' : 'Agent'}?</h4>
              <p className="text-gray-400 mb-4">
                This will delete "{agent.name}". This cannot be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AgentCard;
