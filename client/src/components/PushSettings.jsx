import React, { useEffect, useState } from 'react';
import { pushStatus, enablePush, disablePush, testPush, isIOS } from '../lib/push';

/**
 * Phone notifications: Web Push for "an agent needs you" (server/services/push.js).
 * Per device -- each phone or browser subscribes itself.
 */
const TEXT = {
  'needs-home-screen': 'On iPhone, notifications only work from the Home Screen app. In Safari tap Share, then Add to Home Screen, open Maestro from there, and come back here.',
  unsupported: 'This browser cannot receive push notifications.',
  denied: isIOS()
    ? 'Notifications are blocked. Turn them on in Settings › Notifications › Maestro.'
    : 'Notifications are blocked for this site. Allow them in the browser’s site settings.',
  off: 'Off on this device. Turn on to get a notification when an agent stops on a question, even with the phone locked.',
  on: 'On for this device. You’ll be notified when an agent stops on a question.',
};

export default function PushSettings({ onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const refresh = () => pushStatus().then(setStatus).catch((e) => { setStatus('off'); setError(e.message); });
  useEffect(() => { refresh(); }, []);

  const run = async (fn, okMsg) => {
    setBusy(true); setError(''); setMsg('');
    try { const r = await fn(); if (okMsg) setMsg(typeof okMsg === 'function' ? okMsg(r) : okMsg); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); refresh(); }
  };

  const btn = 'px-3 py-1.5 text-sm rounded transition-colors disabled:opacity-40';
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4 pointer-events-none">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-sm pointer-events-auto">
          <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Phone notifications</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-white" type="button" aria-label="Close">✕</button>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-sm text-gray-300">{status ? TEXT[status] : 'Checking…'}</p>
            {msg && <p className="text-sm text-emerald-300">{msg}</p>}
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <div className="flex flex-wrap gap-2">
              {status === 'off' && (
                <button type="button" disabled={busy} className={`${btn} bg-blue-600 text-white hover:bg-blue-500`}
                  onClick={() => run(enablePush, 'Turned on.')}>Turn on</button>
              )}
              {status === 'on' && (
                <>
                  <button type="button" disabled={busy} className={`${btn} bg-blue-600 text-white hover:bg-blue-500`}
                    onClick={() => run(testPush, (r) => (r.disabled ? 'Push is switched off on the server (setting push=off).' : r.sent ? 'Test sent. It should arrive in a few seconds.' : 'The push service refused the test; try turning it off and on.'))}>Send test</button>
                  <button type="button" disabled={busy} className={`${btn} bg-gray-700 text-gray-200 hover:bg-gray-600`}
                    onClick={() => run(disablePush, 'Turned off.')}>Turn off</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
