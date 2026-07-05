import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

// Mirror the server-side validation regexes
const NAME_REGEX = /^[\w .-]{1,64}$/;
const SSH_TARGET_REGEX = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

const STATUS_DOT = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  unknown: 'bg-gray-500',
};

function HostManagement({ onClose }) {
  const { hosts, createHost, deleteHost, testHost } = useApp();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSshTarget, setNewSshTarget] = useState('');
  const [newPathPrefix, setNewPathPrefix] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [testResults, setTestResults] = useState({}); // hostId -> {ok, version|error}
  const [testingId, setTestingId] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    if (!NAME_REGEX.test(newName)) {
      setError('Name must be 1-64 characters: letters, numbers, spaces, dots, dashes, underscores');
      return;
    }
    if (!SSH_TARGET_REGEX.test(newSshTarget)) {
      setError('SSH target must look like user@hostname');
      return;
    }
    setLoading(true);
    try {
      const payload = { name: newName, sshTarget: newSshTarget };
      if (newPathPrefix.trim()) payload.pathPrefix = newPathPrefix.trim();
      await createHost(payload);
      setNewName('');
      setNewSshTarget('');
      setNewPathPrefix('');
      setShowAdvanced(false);
      setShowCreate(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    setError('');
    try {
      await deleteHost(id);
      setDeleteConfirm(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTest = async (id) => {
    setError('');
    setTestingId(id);
    setTestResults((prev) => ({ ...prev, [id]: null }));
    try {
      const result = await testHost(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h3 className="text-lg font-semibold text-white">Manage Hosts</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mx-4 mt-3 bg-red-900/50 border border-red-500 text-red-200 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          {/* Host list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {hosts.map((h) => {
              const isLocal = !h.ssh_target;
              const result = testResults[h.id];
              return (
                <div key={h.id} className="bg-gray-700/50 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[h.status] || STATUS_DOT.unknown}`}
                        title={h.status || 'unknown'}
                      />
                      <div className="min-w-0">
                        <div className="text-sm text-white font-medium truncate">{h.name}</div>
                        <div className="text-xs text-gray-400 font-mono truncate">
                          {isLocal ? 'local' : h.ssh_target}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {!isLocal && (
                        <button
                          onClick={() => handleTest(h.id)}
                          disabled={testingId === h.id}
                          className="px-2 py-1 text-xs rounded transition-colors
                                     text-gray-400 hover:text-white hover:bg-gray-600
                                     disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Run tmux -V over SSH"
                        >
                          {testingId === h.id ? 'Testing...' : 'Test'}
                        </button>
                      )}
                      {!isLocal && (
                        deleteConfirm === h.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(h.id)}
                              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(h.id)}
                            className="px-2 py-1 text-xs rounded transition-colors
                                       text-red-400 hover:text-red-300 hover:bg-gray-600"
                            title="Delete host"
                          >
                            Delete
                          </button>
                        )
                      )}
                    </div>
                  </div>
                  {result && (
                    <div className={`mt-1.5 text-xs font-mono ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
                      {result.ok ? result.version : (result.error || 'Test failed')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add host form */}
          <div className="border-t border-gray-700 p-4">
            {!showCreate ? (
              <button
                onClick={() => setShowCreate(true)}
                className="w-full py-2 px-4 border border-gray-600 text-gray-300 hover:bg-gray-700
                           rounded transition-colors text-sm flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Host
              </button>
            ) : (
              <form onSubmit={handleCreate} className="space-y-3">
                <input
                  type="text"
                  placeholder="Host name (e.g. mac-mini)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                             focus:outline-none focus:ring-1 focus:ring-primary-500"
                  required
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="dave@davids-mac-mini"
                  value={newSshTarget}
                  onChange={(e) => setNewSshTarget(e.target.value)}
                  className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                             focus:outline-none focus:ring-1 focus:ring-primary-500 font-mono"
                  required
                />
                <div>
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
                      placeholder="PATH prefix (e.g. /opt/homebrew/bin:/usr/local/bin)"
                      value={newPathPrefix}
                      onChange={(e) => setNewPathPrefix(e.target.value)}
                      className="mt-1 w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-white
                                 focus:outline-none focus:ring-1 focus:ring-primary-500 font-mono text-xs"
                    />
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded
                               transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Adding...' : 'Add Host'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setError(''); }}
                    className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export default HostManagement;
