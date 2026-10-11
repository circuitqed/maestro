import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

/**
 * Changing your own password.
 *
 * Available to every role, unlike Manage Users. Until now a non-admin had no way
 * to change their password at all: the endpoint had been there from the start and
 * nothing in the client ever called it, so the only route was asking an admin to
 * reset it -- which hands your password to someone else by construction.
 *
 * The current password is required by the server, and that is the point: a session
 * left open on an unlocked machine should not be enough to lock the real owner out.
 */
function ChangePassword({ onClose }) {
  const { changeOwnPassword } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    // Checked here as well as on the server: a typo in a value you cannot see is
    // the single most likely way to lock yourself out, and the server has no way
    // to catch it -- both fields are valid passwords as far as it knows.
    if (next !== confirm) { setError('The new passwords do not match'); return; }
    if (next.length < 8) { setError('Use at least 8 characters'); return; }
    if (next === current) { setError('That is already your password'); return; }
    setBusy(true);
    try {
      await changeOwnPassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Failed to change password');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white '
    + 'focus:outline-none focus:ring-1 focus:ring-primary-500';

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div
          className="bg-gray-800 rounded-lg shadow-xl w-full max-w-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Change your password</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-white" type="button">✕</button>
          </div>

          {done ? (
            <div className="p-4">
              <p className="text-sm text-emerald-300 mb-3">Password changed.</p>
              {/* The session survives the change -- say so, or the natural assumption
                  is that you have been signed out everywhere and should re-login. */}
              <p className="text-xs text-gray-400 mb-4">
                You stay signed in here. Use the new password next time you log in.
              </p>
              <button
                onClick={onClose}
                className="w-full px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded"
                type="button"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="p-4 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Current password</label>
                <input
                  type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
                  className={field} required autoFocus autoComplete="current-password"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">New password</label>
                <input
                  type="password" value={next} onChange={(e) => setNext(e.target.value)}
                  className={field} required autoComplete="new-password"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Confirm new password</label>
                <input
                  type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  className={field} required autoComplete="new-password"
                />
              </div>
              {error && <div className="text-xs text-red-400">{error}</div>}
              <div className="flex gap-2 pt-1">
                <button
                  type="submit" disabled={busy}
                  className="flex-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm
                             rounded disabled:opacity-50"
                >
                  {busy ? 'Changing…' : 'Change password'}
                </button>
                <button
                  type="button" onClick={onClose}
                  className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

export default ChangePassword;
