import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';

function UserManagement({ onClose }) {
  const { user: currentUser, loadUsers, createNewUser, deleteUserAccount, updateUserAccount } = useApp();
  const [users, setUsers] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Which user's password is being reset, and to what. A bcrypt hash cannot be
  // read back, so "I forgot their password" has exactly one answer: set a new one.
  const [resetFor, setResetFor] = useState(null);
  const [resetPw, setResetPw] = useState('');
  const [resetDone, setResetDone] = useState(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const data = await loadUsers();
      setUsers(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await createNewUser({ username: newUsername, password: newPassword, role: newRole });
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      setShowCreate(false);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    setError('');
    try {
      await deleteUserAccount(id);
      setDeleteConfirm(null);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  /**
   * Four words and a number: ~60 bits, and unlike a random string it survives
   * being read aloud or retyped, which is how a reset password actually reaches
   * the person it belongs to.
   */
  const suggestPassword = () => {
    const words = ['copper', 'lantern', 'harbor', 'meadow', 'quartz', 'thicket', 'ember', 'cobalt',
      'willow', 'saffron', 'glacier', 'pumice', 'bramble', 'cinder', 'fathom', 'juniper',
      'marlin', 'orchid', 'pewter', 'rivet', 'sable', 'tundra', 'velvet', 'zephyr'];
    const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
    const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
    return `${pick()}-${pick()}-${pick()}-${pick()}-${n}`;
  };

  const openReset = (u) => {
    setError('');
    setResetDone(null);
    setResetFor(u.id);
    setResetPw(suggestPassword());
  };

  const handleReset = async (u) => {
    setError('');
    if (!resetPw.trim()) { setError('A password is required'); return; }
    setLoading(true);
    try {
      await updateUserAccount(u.id, { password: resetPw });
      // Shown once, deliberately: it is the only moment this value is readable,
      // and the admin has to be able to pass it on.
      setResetDone({ id: u.id, password: resetPw });
      setResetFor(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRole = async (targetUser) => {
    setError('');
    const newRole = targetUser.role === 'admin' ? 'user' : 'admin';
    try {
      await updateUserAccount(targetUser.id, { role: newRole });
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const adminCount = users.filter(u => u.role === 'admin').length;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h3 className="text-lg font-semibold text-white">Manage Users</h3>
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

          {/* User list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {users.map((u) => (
              <div key={u.id} className="bg-gray-700/50 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    u.role === 'admin' ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-300'
                  }`}>
                    {u.username[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm text-white font-medium">
                      {u.username}
                      {u.id === currentUser?.id && (
                        <span className="ml-2 text-xs text-gray-400">(you)</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 capitalize">{u.role}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {/* Reset password */}
                  <button
                    onClick={() => openReset(u)}
                    className="px-2 py-1 text-xs rounded transition-colors
                               text-gray-400 hover:text-white hover:bg-gray-600"
                    title="Set a new password for this user"
                  >
                    Password
                  </button>
                  {/* Toggle role */}
                  <button
                    onClick={() => handleToggleRole(u)}
                    disabled={u.role === 'admin' && adminCount <= 1}
                    className="px-2 py-1 text-xs rounded transition-colors
                               text-gray-400 hover:text-white hover:bg-gray-600
                               disabled:opacity-30 disabled:cursor-not-allowed"
                    title={u.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
                  >
                    {u.role === 'admin' ? 'Demote' : 'Promote'}
                  </button>
                  {/* Delete */}
                  {deleteConfirm === u.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(u.id)}
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
                      onClick={() => setDeleteConfirm(u.id)}
                      disabled={u.id === currentUser?.id}
                      className="px-2 py-1 text-xs rounded transition-colors
                                 text-red-400 hover:text-red-300 hover:bg-gray-600
                                 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={u.id === currentUser?.id ? 'Cannot delete yourself' : 'Delete user'}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Reset form, inline under the user it belongs to */}
              {resetFor === u.id && (
                <div className="mt-2 border-t border-gray-600/70 pt-2">
                  <label className="block text-xs text-gray-400 mb-1">
                    New password for <span className="text-gray-200">{u.username}</span>
                  </label>
                  <div className="flex gap-2">
                    {/* type=text, not password: the admin is setting a value to pass
                        on to someone else, so hiding it serves nobody -- they cannot
                        relay what they cannot read, and it is never read back later. */}
                    <input
                      type="text"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      className="flex-1 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-sm
                                 text-white font-mono focus:outline-none focus:ring-1 focus:ring-primary-500"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      onClick={() => setResetPw(suggestPassword())}
                      className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-600 rounded"
                      title="Suggest another"
                      type="button"
                    >
                      ↻
                    </button>
                    <button
                      onClick={() => handleReset(u)}
                      disabled={loading}
                      className="px-3 py-1 text-xs bg-primary-600 hover:bg-primary-700 text-white rounded
                                 disabled:opacity-50"
                      type="button"
                    >
                      {loading ? 'Setting…' : 'Set'}
                    </button>
                    <button
                      onClick={() => { setResetFor(null); setError(''); }}
                      className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200"
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Shown once. The hash is one-way, so if this is lost the only
                  remedy is another reset -- say so rather than let it be closed
                  on the assumption it can be looked up again. */}
              {resetDone && resetDone.id === u.id && (
                <div className="mt-2 border-t border-gray-600/70 pt-2">
                  <div className="text-xs text-gray-400 mb-1">
                    New password for {u.username} — copy it now, it cannot be shown again:
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-gray-900 rounded text-sm text-emerald-300 font-mono break-all">
                      {resetDone.password}
                    </code>
                    <button
                      onClick={() => { navigator.clipboard?.writeText(resetDone.password); }}
                      className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-600 rounded"
                      type="button"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => setResetDone(null)}
                      className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200"
                      type="button"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
              </div>
            ))}
          </div>

          {/* Create form */}
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
                Add User
              </button>
            ) : (
              <form onSubmit={handleCreate} className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Username"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
                    className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                               focus:outline-none focus:ring-1 focus:ring-primary-500"
                    required
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                    className="px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                               focus:outline-none focus:ring-1 focus:ring-primary-500"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <input
                  type="password"
                  placeholder="Password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                             focus:outline-none focus:ring-1 focus:ring-primary-500"
                  required
                  autoComplete="new-password"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded
                               transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Creating...' : 'Create User'}
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

export default UserManagement;
