import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import UserManagement from './UserManagement';
import HostManagement from './HostManagement';

function Header() {
  const { logout, user, projects, agents, soundEnabled, toggleSound, requestPermission } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showHostManagement, setShowHostManagement] = useState(false);

  const runningAgents = agents.filter((a) =>
    a.status === 'running' || a.status === 'busy'
  ).length;
  const idleAgents = agents.filter((a) => a.status === 'idle').length;

  return (
    <>
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

          {/* User info + Menu */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex items-center gap-2 p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              {user && <span className="text-sm hidden sm:inline">{user.username}</span>}
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 mt-2 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20">
                  {user && (
                    <div className="px-4 py-2 border-b border-gray-700">
                      <div className="text-sm text-white font-medium">{user.username}</div>
                      <div className="text-xs text-gray-400 capitalize">{user.role}</div>
                    </div>
                  )}
                  {user?.role === 'admin' && (
                    <button
                      onClick={() => {
                        setShowUserManagement(true);
                        setShowMenu(false);
                      }}
                      className="w-full px-4 py-2 text-left text-gray-300 hover:bg-gray-700 transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                      </svg>
                      Manage Users
                    </button>
                  )}
                  {user?.role === 'admin' && (
                    <button
                      onClick={() => {
                        setShowHostManagement(true);
                        setShowMenu(false);
                      }}
                      className="w-full px-4 py-2 text-left text-gray-300 hover:bg-gray-700 transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                      </svg>
                      Manage Hosts
                    </button>
                  )}
                  <button
                    onClick={() => {
                      logout();
                      setShowMenu(false);
                    }}
                    className="w-full px-4 py-2 text-left text-gray-300 hover:bg-gray-700 rounded-b-lg transition-colors flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Logout
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {showUserManagement && (
        <UserManagement onClose={() => setShowUserManagement(false)} />
      )}

      {showHostManagement && (
        <HostManagement onClose={() => setShowHostManagement(false)} />
      )}
    </>
  );
}

export default Header;
