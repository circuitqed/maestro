import React, { useEffect, useRef, useState } from 'react';

/**
 * Dictation into the chat composer.
 *
 * Records audio in the browser and sends it to POST /api/transcribe, which runs
 * whisper.cpp on the mac mini (server/routes/transcribe.js). It replaced the
 * browser's own speech recognition (Web Speech), which:
 *   - is refused in an iOS Home Screen app ("service-not-allowed"), whatever the
 *     microphone permission says -- the first thing that broke on a real iPhone;
 *   - doesn't exist in Firefox;
 *   - hears our vocabulary as ordinary words ("em-sim" -> "M-SIM", "yap queue" ->
 *     "YAPQ"); Whisper is given the agent names as a prompt.
 * The cost is no live text while speaking: the words land ~1-2 s after stopping.
 *
 * Tap to start, tap again to stop. The text is appended after whatever was typed and
 * is never sent on its own: the person reads it and presses Send.
 */

const MAX_MS = 5 * 60 * 1000;

export const voiceSupported =
  typeof window !== 'undefined' &&
  window.isSecureContext !== false &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  typeof window.MediaRecorder !== 'undefined';

function pickType() {
  // Safari records mp4/aac, Chrome and Firefox webm/opus; ask for what it has.
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* old Safari */ }
  }
  return '';
}

function micError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      ? 'Microphone access is off. On iPhone: Settings › Apps › Safari › Microphone (or, in Safari, aA › Website Settings › Microphone › Allow). A Home Screen app asks again after each relaunch.'
      : 'Microphone access was refused. Allow it for this site in the browser’s site settings.';
  }
  if (n === 'NotFoundError') return 'No microphone found.';
  if (n === 'NotReadableError') return 'The microphone is in use by another app.';
  return `Could not start the microphone${err && err.message ? `: ${err.message}` : ''}`;
}

export default function VoiceButton({ value, onChange, inputRef, disabled }) {
  const [phase, setPhase] = useState('idle'); // idle | recording | transcribing
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const abortRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const release = () => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    const s = streamRef.current;
    streamRef.current = null;
    if (s) s.getTracks().forEach((t) => t.stop()); // turns the mic indicator off
  };

  const transcribe = async (blob) => {
    setPhase('transcribing');
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': (blob.type || 'application/octet-stream').split(';')[0] },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const text = (data.text || '').trim();
      // Whisper's stock output for silence; never worth inserting.
      if (text && !/^\[?(blank_audio|silence|no speech)\]?$/i.test(text)) {
        const base = valueRef.current || '';
        onChange(base && !/\s$/.test(base) ? `${base} ${text}` : base + text);
      }
      const el = inputRef && inputRef.current;
      if (el) {
        el.focus();
        const n = el.value.length;
        try { el.setSelectionRange(n, n); } catch { /* not a text field */ }
      }
    } catch (err) {
      setError(err.message || 'Transcription failed');
    } finally {
      setPhase('idle');
    }
  };

  const start = async () => {
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setError(micError(err));
      return;
    }
    streamRef.current = stream;
    const type = pickType();
    let rec;
    try {
      rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch (err) {
      release();
      setError(`Could not record: ${err.message || err}`);
      return;
    }
    chunksRef.current = [];
    abortRef.current = false;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      release();
      recRef.current = null;
      if (abortRef.current) { setPhase('idle'); return; }
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || type || 'audio/mp4' });
      chunksRef.current = [];
      if (blob.size < 1000) { setPhase('idle'); return; } // a tap, not speech
      transcribe(blob);
    };
    recRef.current = rec;
    rec.start(1000); // chunks every second, so a long take isn't one giant buffer at the end
    const t0 = Date.now();
    setElapsed(0);
    timerRef.current = setInterval(() => {
      const ms = Date.now() - t0;
      setElapsed(ms);
      if (ms >= MAX_MS) stop();
    }, 250);
    setPhase('recording');
  };

  const stop = () => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { release(); setPhase('idle'); }
    }
  };

  // Leaving the chat mid-take: drop it, and free the mic.
  useEffect(() => () => {
    abortRef.current = true;
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* gone */ } }
    release();
  }, []);

  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  if (!voiceSupported) return null;

  const recording = phase === 'recording';
  const busy = phase === 'transcribing';
  const secs = Math.floor(elapsed / 1000);
  const label = recording ? 'Stop and transcribe' : busy ? 'Transcribing…' : 'Dictate';

  return (
    <div className="relative flex-shrink-0 self-end">
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={busy || (disabled && !recording)}
        title={label}
        aria-label={label}
        aria-pressed={recording}
        className={`p-2 rounded transition-colors disabled:opacity-60 ${
          recording
            ? 'bg-red-600 text-white hover:bg-red-500'
            : busy
              ? 'text-blue-300'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
        }`}
      >
        {busy ? (
          <svg className="w-5 h-5 animate-spin motion-reduce:animate-none" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
            <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : recording ? (
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0M12 18v3" />
          </svg>
        )}
      </button>
      {recording && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 flex items-center gap-1 rounded bg-gray-900/90 px-1.5 py-0.5 text-[11px] tabular-nums text-red-300 whitespace-nowrap pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none" />
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </div>
      )}
      {error && (
        <div role="alert" className="absolute bottom-full left-0 mb-2 w-72 max-w-[80vw] rounded bg-gray-800 border border-red-500/60 px-2.5 py-1.5 text-xs text-red-200 shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
