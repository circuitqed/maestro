import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

const STATUS_COLORS = {
  running: 'bg-blue-500',
  busy: 'bg-blue-500',
  idle: 'bg-green-500',
  stopped: 'bg-gray-500',
};

function AgentCard({ agent }) {
  const { deleteAgent, startAgent, stopAgent, openTerminal } = useApp();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

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
          openTerminal(agent.screen_session);
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
      openTerminal(agent.screen_session);
    }
  };

  const isRunning = agent.status === 'running' || agent.status === 'idle' || agent.status === 'busy';

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
          <h3 className="font-medium text-white truncate">{agent.name}</h3>
        </div>
        <button
          onClick={() => setShowConfirm(true)}
          className="p-1 text-gray-500 hover:text-red-400 transition-colors ml-2"
          title="Delete agent"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
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

      {agent.screen_session && (
        <p className="text-gray-500 text-xs font-mono truncate mb-3">{agent.screen_session}</p>
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
              <h4 className="text-lg font-semibold text-white mb-2">Delete Agent?</h4>
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
