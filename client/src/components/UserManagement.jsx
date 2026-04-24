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
              <div key={u.id} className="flex items-center justify-between bg-gray-700/50 rounded-lg px-3 py-2">
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
                    onChange={(e) => setNewUsername(e.target.value)}
                    className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                               focus:outline-none focus:ring-1 focus:ring-primary-500"
                    required
                    autoFocus
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
