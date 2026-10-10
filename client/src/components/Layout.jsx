import React, { useEffect, useRef, useCallback } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useApp } from '../context/AppContext';
import useMediaQuery from '../hooks/useMediaQuery';
import Header from './Header';
import Dashboard from './Dashboard';
import TerminalPanel from './TerminalPanel';
import TerminalModal from './TerminalModal';
import SwarmPanel from './SwarmPanel';

function Layout() {
  const { terminalOpen, activeTerminal, closeTerminal, activeSwarm, closeSwarm, panelFocus } = useApp();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const terminalRef = useRef(null);

  // One slot, two tenants: whichever was opened last is on top, and the other is
  // parked rather than closed. Closing the one on top reveals the parked one -- which
  // is what makes "Open session" on a stuck worker safe to click, since the swarm you
  // were reading comes back when you are done looking at the pane.
  const terminalAvailable = terminalOpen && !!activeTerminal;
  const swarmAvailable = !!activeSwarm;
  const swarmShown = swarmAvailable && (panelFocus === 'swarm' || !terminalAvailable);
  const terminalShown = !swarmShown && terminalAvailable;
  const slotFilled = swarmShown || terminalShown;

  // Global keyboard capture - focus terminal when typing
  const handleGlobalKeyDown = useCallback((e) => {
    // Don't capture if terminal is closed, or if the swarm panel has the slot — its
    // buttons and scroll must not have every keystroke stolen by a hidden xterm.
    if (!terminalOpen || !activeTerminal || swarmShown) return;

    // Only capture for the terminal view (chat has its own textarea)
    if (activeTerminal.mode && activeTerminal.mode !== 'terminal') return;

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
  }, [terminalOpen, activeTerminal, swarmShown]);

  useEffect(() => {
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  // Mobile layout with modal
  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <Header />
        <div className="flex-1 min-h-0 overflow-auto">
          <Dashboard />
        </div>
        {terminalShown && (
          <TerminalModal
            onClose={closeTerminal}
            agentId={activeTerminal.agentId}
            sessionName={activeTerminal.session}
            hostId={activeTerminal.hostId}
            mode={activeTerminal.mode}
          />
        )}
        {/* No TerminalModal equivalent for swarms: the panel is ordinary scrolling
            HTML, so it needs none of that component's keyboard-viewport arithmetic. */}
        {swarmShown && (
          <div className="fixed inset-0 z-50 flex flex-col bg-gray-900">
            <SwarmPanel swarmId={activeSwarm.id} onClose={closeSwarm} />
          </div>
        )}
      </div>
    );
  }

  // Desktop layout with resizable panel
  return (
    <div className="h-screen flex flex-col bg-gray-900">
      <Header />
      {slotFilled ? (
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
            {swarmShown ? (
              <SwarmPanel swarmId={activeSwarm.id} onClose={closeSwarm} />
            ) : (
              <TerminalPanel
                ref={terminalRef}
                agentId={activeTerminal.agentId}
                sessionName={activeTerminal.session}
                hostId={activeTerminal.hostId}
                mode={activeTerminal.mode}
                onClose={closeTerminal}
              />
            )}
          </Panel>
        </PanelGroup>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <Dashboard />
        </div>
      )}
    </div>
  );
}

export default Layout;
