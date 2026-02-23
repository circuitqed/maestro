import React, { useEffect, useState } from 'react';
import Terminal from './Terminal';

function TerminalModal({ sessionName, onClose }) {
  const [viewportHeight, setViewportHeight] = useState(
    window.visualViewport?.height ?? window.innerHeight
  );

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Track visual viewport height to resize when mobile keyboard opens/closes
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const handleResize = () => {
      setViewportHeight(vv.height);
    };

    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed left-0 right-0 top-0 z-50 bg-gray-900 flex flex-col"
      style={{ height: viewportHeight }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Close terminal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <span className="text-white font-medium">Terminal</span>
        </div>
        <span className="text-gray-400 text-sm font-mono truncate max-w-[200px]">{sessionName}</span>
      </div>

      {/* Terminal */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Terminal sessionName={sessionName} />
      </div>
    </div>
  );
}

export default TerminalModal;
