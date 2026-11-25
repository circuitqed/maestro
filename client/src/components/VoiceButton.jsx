import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictation into the chat composer, via the browser's speech recognition.
 *
 * Web Speech API: Safari (macOS and iOS, where it is Siri's dictation) and Chrome/Edge.
 * Firefox has none, and every browser needs a secure context, so on plain http the
 * button simply isn't rendered. Nothing is recorded or sent anywhere by Maestro: the
 * browser does the recognition and we only see the text.
 *
 * Tap to start, tap again to stop. Words land in the composer as you speak (interim
 * results replace themselves), appended after whatever was already typed, and are
 * never sent on their own: the person reads them and presses Send.
 */

const Recognition =
  typeof window !== 'undefined' && window.isSecureContext !== false
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const voiceSupported = !!Recognition;

// Safari on every platform, including iOS Chrome/Firefox (all WebKit underneath).
const isSafari =
  typeof navigator !== 'undefined' &&
  (/^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent) ||
    /iPad|iPhone|iPod/.test(navigator.userAgent));

export default function VoiceButton({ value, onChange, inputRef, disabled }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const baseRef = useRef('');
  // The latest value, for joining onto at start without re-creating callbacks.
  const valueRef = useRef(value);
  valueRef.current = value;

  // True from the tap that starts dictation to the tap that stops it. A recognition
  // session can end on its own (Safari ends at each pause; Chrome after a long
  // silence), and while this is set a new one starts where the last left off.
  const wantRef = useRef(false);
  const quickEndsRef = useRef(0);

  const stop = useCallback(() => {
    wantRef.current = false;
    const rec = recRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* already stopped */ }
    }
  }, []);

  const start = () => {
    if (!Recognition) return;
    wantRef.current = true;
    quickEndsRef.current = 0;
    setError(null);
    session();
  };

  const session = () => {
    const startedAt = Date.now();
    const rec = new Recognition();
    // Safari's continuous mode repeats earlier phrases in later results, so ask for
    // one utterance at a time there and chain sessions instead (see wantRef).
    rec.continuous = !isSafari;
    rec.interimResults = true;  // show words as they come
    rec.lang = navigator.language || 'en-US';
    const base = valueRef.current || '';
    baseRef.current = base && !/\s$/.test(base) ? `${base} ` : base;

    rec.onresult = (e) => {
      // Rebuild from all results each time: finals accumulate, the last may be interim.
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onChange(baseRef.current + text.replace(/^\s+/, ''));
    };
    rec.onerror = (e) => {
      // "no-speech" and "aborted" are just endings, not something to show.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRef.current = false;
        setError('Microphone permission was refused. Allow it for this site in the browser settings.');
      } else if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        wantRef.current = false;
        setError(`Dictation stopped: ${e.error}`);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      // Ended by itself while still wanted: carry on. Several instant ends in a row
      // mean something is refusing quietly, so give up rather than spin.
      if (wantRef.current) {
        quickEndsRef.current = Date.now() - startedAt < 1000 ? quickEndsRef.current + 1 : 0;
        if (quickEndsRef.current < 3) { session(); return; }
        wantRef.current = false;
      }
      setListening(false);
      // Hand the composer back for editing, cursor at the end.
      const el = inputRef && inputRef.current;
      if (el) {
        el.focus();
        const n = el.value.length;
        try { el.setSelectionRange(n, n); } catch { /* not a text field */ }
      }
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      recRef.current = null;
      wantRef.current = false;
      setListening(false);
      setError(err.message || 'Could not start dictation');
    }
  };

  // Stop listening if the chat unmounts (switching agent, closing the panel).
  useEffect(() => () => {
    wantRef.current = false;
    const rec = recRef.current;
    if (rec) { rec.onend = null; try { rec.abort(); } catch { /* gone */ } }
  }, []);

  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  if (!Recognition) return null;

  return (
    <div className="relative flex-shrink-0 self-end">
      <button
        type="button"
        onClick={listening ? stop : start}
        disabled={disabled && !listening}
        title={listening ? 'Stop dictation' : 'Dictate'}
        aria-label={listening ? 'Stop dictation' : 'Dictate'}
        aria-pressed={listening}
        className={`p-2 rounded transition-colors disabled:opacity-40 ${
          listening
            ? 'bg-red-600 text-white hover:bg-red-500 animate-pulse motion-reduce:animate-none'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
        }`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-14 0M12 18v3" />
        </svg>
      </button>
      {error && (
        <div role="alert" className="absolute bottom-full left-0 mb-2 w-64 rounded bg-gray-800 border border-red-500/60 px-2.5 py-1.5 text-xs text-red-200 shadow-lg">
          {error}
        </div>
      )}
    </div>
  );
}
