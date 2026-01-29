import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

const STATUS_COLORS = {
  running: 'bg-blue-500',
  busy: 'bg-blue-500',
  idle: 'bg-green-500',
  stopped: 'bg-gray-500',
};

function AgentRow({ agent }) {
  const { startAgent, stopAgent, deleteAgent, openTerminal } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    try {
      await startAgent(agent.id);
      // Open terminal after starting
      if (agent.screen_session) {
        openTerminal(agent.screen_session);
      }
    } catch (err) {
      console.error('Failed to start agent:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await stopAgent(agent.id);
    } catch (err) {
      console.error('Failed to stop agent:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    await deleteAgent(agent.id);
    setShowConfirm(false);
  };

  const handleOpenTerminal = () => {
    if (agent.screen_session) {
      openTerminal(agent.screen_session);
    }
  };

  const isRunning = agent.status === 'running' || agent.status === 'idle' || agent.status === 'busy';

  return (
    <div className="flex items-center gap-3 py-2 px-3 bg-gray-700/50 rounded-lg group">
      {/* Status indicator */}
      <span
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_COLORS[agent.status]} ${
          isRunning ? 'animate-pulse' : ''
        }`}
        title={agent.status}
      />

      {/* Agent info */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-white text-sm truncate">{agent.name}</div>
        {agent.screen_session && (
          <div className="text-xs text-gray-500 font-mono truncate">{agent.screen_session}</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {/* Start/Stop button */}
        <button
          onClick={isRunning ? handleStop : handleStart}
          disabled={loading || !agent.screen_session}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50 ${
            isRunning
              ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30'
              : 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
          }`}
        >
          {loading ? '...' : isRunning ? 'Stop' : 'Start'}
        </button>

        {/* Terminal button */}
        {agent.screen_session && (
          <button
            onClick={handleOpenTerminal}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
            title="Open terminal"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>
        )}

        {/* Menu button */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="6" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="18" r="1.5" />
            </svg>
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-full mt-1 w-32 bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-20 py-1">
                <button
                  onClick={() => {
                    setShowMenu(false);
                    setShowConfirm(true);
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-700"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
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

export default AgentRow;
