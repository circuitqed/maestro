import React, { useEffect, useRef, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useApp } from '../context/AppContext';
import useMediaQuery from '../hooks/useMediaQuery';
import Header from './Header';
import Dashboard from './Dashboard';
import TerminalPanel from './TerminalPanel';
import TerminalModal from './TerminalModal';

function Layout() {
  const { terminalOpen, activeTerminal, closeTerminal } = useApp();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const terminalRef = useRef(null);

  // Global keyboard capture - focus terminal when typing
  const handleGlobalKeyDown = useCallback((e) => {
    // Don't capture if terminal is closed
    if (!terminalOpen || !activeTerminal) return;

    // Don't capture if user is in an input field
    const activeElement = document.activeElement;
    const isInputField = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.tagName === 'SELECT' ||
      activeElement.isContentEditable
    );
    if (isInputField) return;

    // Don't capture modifier-only keys or special keys we want to preserve
    if (e.key === 'Tab' || e.key === 'Escape') return;
    if (e.ctrlKey || e.altKey || e.metaKey) {
      // Allow Ctrl+C, Ctrl+V etc to go to terminal
      if (!['c', 'v', 'a', 'z', 'x'].includes(e.key.toLowerCase())) {
        return;
      }
    }

    // Focus the terminal - it will handle the input
    if (terminalRef.current?.focus) {
      terminalRef.current.focus();
    }
  }, [terminalOpen, activeTerminal]);

  useEffect(() => {
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  // Mobile layout with modal
  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <Header />
        <Dashboard />
        {terminalOpen && activeTerminal && (
          <TerminalModal onClose={closeTerminal} sessionName={activeTerminal} />
        )}
      </div>
    );
  }

  // Desktop layout with resizable panel
  return (
    <div className="h-screen flex flex-col bg-gray-900">
      <Header />
      {terminalOpen && activeTerminal ? (
        <PanelGroup direction="horizontal" className="flex-1 min-h-0">
          <Panel defaultSize={35} minSize={20} className="overflow-hidden">
            <div className="h-full overflow-auto">
              <Dashboard />
            </div>
          </Panel>
          <PanelResizeHandle className="w-2 bg-gray-700 hover:bg-primary-500 cursor-col-resize transition-colors flex items-center justify-center group">
            <div className="w-1 h-8 bg-gray-600 group-hover:bg-primary-400 rounded-full transition-colors" />
          </PanelResizeHandle>
          <Panel defaultSize={65} minSize={30} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
            <TerminalPanel ref={terminalRef} sessionName={activeTerminal} onClose={closeTerminal} />
          </Panel>
        </PanelGroup>
      ) : (
        <Dashboard />
      )}
    </div>
  );
}

export default Layout;
