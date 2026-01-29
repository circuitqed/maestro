import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

function Header() {
  const { logout, projects, agents, soundEnabled, toggleSound, requestPermission } = useApp();
  const [showMenu, setShowMenu] = useState(false);

  const runningAgents = agents.filter((a) =>
    a.status === 'running' || a.status === 'busy'
  ).length;
  const idleAgents = agents.filter((a) => a.status === 'idle').length;

  return (
    <header className="bg-gray-800 border-b border-gray-700 px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold text-white">Maestro</h1>
        <div className="hidden sm:flex items-center gap-4 text-sm text-gray-400">
          <span>{projects.length} projects</span>
          <span className="text-gray-600">|</span>
          <span className="flex items-center gap-2">
            {agents.length} agents
            {runningAgents > 0 && (
              <span className="text-blue-400">({runningAgents} busy)</span>
            )}
            {idleAgents > 0 && (
              <span className="text-green-400">({idleAgents} ready)</span>
            )}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Sound toggle */}
        <button
          onClick={() => {
            toggleSound();
            requestPermission();
          }}
          className={`p-2 rounded transition-colors ${
            soundEnabled
              ? 'text-green-400 hover:text-green-300 hover:bg-gray-700'
              : 'text-gray-500 hover:text-gray-400 hover:bg-gray-700'
          }`}
          title={soundEnabled ? 'Sound notifications on' : 'Sound notifications off'}
        >
          {soundEnabled ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            </svg>
          )}
        </button>

        {/* Menu */}
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20">
                <button
                  onClick={() => {
                    logout();
                    setShowMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-gray-300 hover:bg-gray-700 rounded-lg transition-colors"
                >
                  Logout
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;
