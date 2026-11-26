import { useEffect, useRef } from 'react';

// Close a modal on Escape. The handler is read through a ref so a parent passing a
// fresh arrow function each render does not re-bind the listener every time.
export default function useEscape(onClose, enabled = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && ref.current) ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
