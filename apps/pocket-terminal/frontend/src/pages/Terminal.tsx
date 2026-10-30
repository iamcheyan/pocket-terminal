import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  ClipboardCopy,
  ClipboardPaste,
  Columns2,
  Plus,
  Power,
  RotateCcw,
  Rows2,
  SquareTerminal,
  Type,
  X,
} from 'lucide-react';
import type {SessionKind, ShellOption, TerminalSession} from '../api';
import {sessionSocketUrl} from '../api';
import {Button, Dialog, Segmented} from '../components';
import {createSocket, type LinkState, type SessionSocket} from '../terminal';

// --- xterm theme bridge ---------------------------------------------------

const readVar = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

const buildTheme = (light: boolean) => ({
  background: readVar('--term-bg', light ? '#fbfcf7' : '#0b0e0c'),
  foreground: readVar('--term-fg', light ? '#23281f' : '#dfe6d9'),
  cursor: readVar('--accent', '#c4dc9c'),
  cursorAccent: readVar('--term-bg', '#0b0e0c'),
  selectionBackground: readVar('--term-selection', 'rgba(196,220,156,0.22)'),
  black: light ? '#1f241d' : '#1b201b',
  red: light ? '#b4473d' : '#e98d84',
  green: light ? '#3f6d2c' : '#9dcf8a',
  yellow: light ? '#8a6a17' : '#dcc07a',
  blue: light ? '#3a5b8c' : '#9db4dc',
  magenta: light ? '#7a4a86' : '#c8a2d8',
  cyan: light ? '#2f6b6b' : '#8fd0cd',
  white: light ? '#4a5145' : '#c8d0c2',
  brightBlack: light ? '#626b5d' : '#7d887b',
  brightRed: light ? '#8f2f27' : '#ffb1a8',
  brightGreen: light ? '#2c5c1c' : '#b9e8a6',
  brightYellow: light ? '#6b510f' : '#f0d79b',
  brightBlue: light ? '#274672' : '#b8cdf2',
  brightMagenta: light ? '#5f3469' : '#e2c3ec',
  brightCyan: light ? '#1f5656' : '#aee6e2',
  brightWhite: light ? '#0f120e' : '#f2f6ee',
});

interface PaneProps {
  session: TerminalSession | null;
  focused: boolean;
  fontSize: number;
  light: boolean;
  onFocus: () => void;
  onExit: (code: number | null) => void;
  onState: (state: LinkState, detail?: string) => void;
  registerActions: (actions: PaneActions | null) => void;
  onSplit: () => void;
  split: boolean;
  onCloseSplit: () => void;
  onNewTab: () => void;
}

export interface PaneActions {
  send: (data: string) => void;
  focus: () => void;
  selectAll: () => string;
  clear: () => void;
  reset: () => void;
  scrollToBottom: () => void;
}

const TerminalPane = ({
  session,
  focused,
  fontSize,
  light,
  onFocus,
  onExit,
  onState,
  registerActions,
  onSplit,
  split,
  onCloseSplit,
  onNewTab,
}: PaneProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const [linkState, setLinkState] = useState<LinkState>('connecting');
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  // Live PTY geometry, not the creation snapshot: the status bar must match
  // what the terminal is actually rendering after a resize.
  const [geometry, setGeometry] = useState<{cols: number; rows: number} | null>(null);

  // Callback identity must not decide socket lifetime: the parent re-renders
  // on every output frame burst, and inline handlers would tear down the link.
  const handlersRef = useRef({onState, onExit});
  handlersRef.current = {onState, onExit};

  const sessionId = session?.id ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const term = new Terminal({
      fontFamily: "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', ui-monospace, monospace",
      fontSize,
      lineHeight: 1.22,
      cursorBlink: true,
      convertEol: false,
      scrollback: 6000,
      allowProposedApi: false,
      theme: buildTheme(light),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
      setGeometry({cols: term.cols, rows: term.rows});
    } catch {
      // The host can be zero-sized while a hidden tab is mounted.
    }

    const actions: PaneActions = {
      send: data => socketRef.current?.send(data),
      focus: () => term.focus(),
      selectAll: () => {
        term.selectAll();
        return term.getSelection();
      },
      clear: () => term.clear(),
      reset: () => term.reset(),
      scrollToBottom: () => term.scrollToBottom(),
    };
    registerActions(actions);

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      setGeometry({cols: term.cols, rows: term.rows});
      const socket = socketRef.current;
      if (socket) socket.resize(term.cols, term.rows);
    });
    observer.observe(host);

    const onData = term.onData(data => socketRef.current?.send(data));
    return () => {
      onData.dispose();
      observer.disconnect();
      registerActions(null);
      term.dispose();
      termRef.current = null;
    };
    // The terminal instance is recreated only when the theme or font changes;
    // session switching below re-targets the socket without remounting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, light]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const term = termRef.current;
    if (!term) return undefined;
    setExited(undefined);
    term.reset();
    setLinkState('connecting');
    const socket = createSocket(sessionId, sessionSocketUrl, {
      onOutput: chunk => term.write(chunk),
      onState: (state, detail) => {
        setLinkState(state);
        handlersRef.current.onState(state, detail);
      },
      onExit: code => {
        setExited(code ?? null);
        handlersRef.current.onExit(code ?? null);
      },
    });
    socketRef.current = socket;
    socket.connect();
    const fit = fitRef.current;
    if (fit) {
      try {
        fit.fit();
      } catch {
        /* ignore hidden panes */
      }
      socket.resize(term.cols || 80, term.rows || 24);
      setGeometry({cols: term.cols || 80, rows: term.rows || 24});
    }
    return () => {
      socket.dispose();
      socketRef.current = null;
    };
  }, [sessionId]);

  // The xterm host must exist before the first session arrives: the terminal
  // instance is created once per font/theme, and the socket effect only
  // re-targets it. Returning early without the host would leave termRef null.
  return (
    <div className="term-pane" data-focused={focused} onMouseDown={onFocus} data-session-pane={session?.id ?? ''}>
      <div className="term-pane-head">
        <SquareTerminal size={11} />
        <span>{session ? `${session.mock ? 'mock · ' : ''}${session.shellId}` : 'no session'}</span>
        <span className="spacer" />
        <span className={`dot ${linkState === 'open' ? 'live' : linkState === 'closed' ? 'bad' : 'warn'}`} />
        <span>{session ? `${linkState}${session.state === 'exited' ? ' · exited' : ''}` : 'idle'}</span>
        <Button variant="ghost" size="sm" iconOnly label="Split pane" onClick={onSplit}>
          {split ? <Rows2 size={11} /> : <Columns2 size={11} />}
        </Button>
        {split ? (
          <Button variant="ghost" size="sm" iconOnly label="Close split pane" onClick={onCloseSplit}>
            <X size={11} />
          </Button>
        ) : null}
      </div>
      <div className="term-host" ref={hostRef} data-kb aria-label={`Terminal ${session?.title ?? 'none'}`} tabIndex={0} />
      <div className="term-status">
        <span>{geometry ? `${geometry.cols}×${geometry.rows}` : session ? `${session.cols}×${session.rows}` : '—'}</span>
        <span>·</span>
        <span>{session?.title ?? 'no session'}</span>
        {session?.kind === 'ssh' ? (
          <>
            <span>·</span>
            <span>ssh</span>
          </>
        ) : null}
        {session?.mock ? (
          <>
            <span>·</span>
            <span style={{color: 'var(--warn)'}}>mock=true</span>
          </>
        ) : null}
        <span className="spacer" style={{flex: 1}} />
        {exited !== undefined ? <span style={{color: 'var(--danger)'}}>exited {exited ?? '?'}</span> : null}
      </div>
      {!session ? (
        <div className="term-overlay">
          <div>
            <strong>No terminal open</strong>
            <p>Open a local shell or an SSH profile. terminald owns the PTY; the browser only renders it.</p>
            <Button variant="primary" onClick={onNewTab}>
              <Plus size={13} /> New local shell
            </Button>
          </div>
        </div>
      ) : session.state !== 'running' || linkState === 'error' ? (
        <div className="term-overlay">
          <div>
            <strong>{session.state === 'exited' ? 'Process exited' : 'Transport problem'}</strong>
            <p>
              {session.state === 'exited'
                ? `The shell ended with code ${session.exitCode ?? 'unknown'}. Open a new tab to continue; scrollback stays readable.`
                : 'The WebSocket to terminald dropped. Reconnecting replays anything produced while it was down.'}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// --- page -----------------------------------------------------------------

export interface TerminalPageProps {
  sessions: TerminalSession[];
  shells: ShellOption[];
  activeId: string | null;
  defaultShell: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: (kind: SessionKind, shell?: string) => Promise<TerminalSession | null>;
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const FONT_KEY = 'pt.fontSize';

const TerminalPage = ({
  sessions,
  shells,
  activeId,
  defaultShell,
  onActivate,
  onClose,
  onCreate,
  notify,
}: TerminalPageProps) => {
  const [fontSize, setFontSize] = useState(() => {
    const raw = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(raw) && raw >= 9 && raw <= 26 ? raw : 12;
  });
  const [split, setSplit] = useState(false);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [shellPicker, setShellPicker] = useState(false);
  const [chosenShell, setChosenShell] = useState(defaultShell);
  const [lightTheme, setLightTheme] = useState(
    () => document.documentElement.dataset.theme === 'light',
  );
  const [focusPane, setFocusPane] = useState<'primary' | 'secondary'>('primary');
  const [linkNote, setLinkNote] = useState<string>('');
  const primaryActions = useRef<PaneActions | null>(null);
  const secondaryActions = useRef<PaneActions | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLightTheme(document.documentElement.dataset.theme === 'light');
    });
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  const active = sessions.find(item => item.id === activeId) ?? sessions[0] ?? null;
  const secondary = sessions.find(item => item.id === secondaryId && item.id !== active?.id) ?? null;

  useEffect(() => {
    if (split && !secondaryId) {
      const candidate = sessions.find(item => item.id !== active?.id);
      if (candidate) setSecondaryId(candidate.id);
    }
    if (split && secondaryId && !sessions.some(item => item.id === secondaryId)) {
      const candidate = sessions.find(item => item.id !== active?.id);
      setSecondaryId(candidate?.id ?? null);
      if (!candidate) setSplit(false);
    }
  }, [split, secondaryId, sessions, active?.id]);

  const actionsFor = useMemo(
    () => (pane: 'primary' | 'secondary') => (pane === 'primary' ? primaryActions.current : secondaryActions.current),
    [],
  );

  const handleCopy = useCallback(async () => {
    const action = actionsFor(focusPane);
    const selected = action?.selectAll() ?? '';
    if (!selected.trim()) {
      notify('Nothing selected in the terminal. Drag to select first.', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(selected);
      notify(`Copied ${selected.length} characters`, 'good');
    } catch {
      notify('Clipboard write blocked by the browser', 'error');
    }
  }, [actionsFor, focusPane, notify]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        notify('Clipboard is empty', 'info');
        return;
      }
      actionsFor(focusPane)?.send(text);
      // Return focus to xterm: the toolbar button stole it, and the next
      // keystroke (Enter) must reach the PTY, not the toolbar.
      actionsFor(focusPane)?.focus();
      notify(`Pasted ${text.length} characters`, 'good');
    } catch {
      notify('Clipboard read blocked by the browser', 'error');
    }
  }, [actionsFor, focusPane, notify]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void handleCopy();
      }
      if (event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void handlePaste();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleCopy, handlePaste]);

  const currentShell = shells.find(shell => shell.id === chosenShell) ?? shells[0];

  return (
    <div className="term-shell">
      <div className="term-toolbar">
        <div className="tabs" role="tablist" aria-label="Terminal tabs">
          {sessions.map(session => (
            <div
              key={session.id}
              className="tab"
              role="tab"
              aria-selected={session.id === active?.id}
              tabIndex={0}
              data-kb
              onClick={() => {
                onActivate(session.id);
                setFocusPane('primary');
              }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onActivate(session.id);
                }
              }}
              title={`${session.title} · ${session.shell}`}
            >
              <span className="dot" style={{background: session.state === 'running' ? 'var(--good)' : 'var(--dim)'}} />
              <span className="tab-title">{session.mock ? '◆ ' : ''}{session.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                aria-label={`Close ${session.title}`}
                onClick={event => {
                  event.stopPropagation();
                  onClose(session.id);
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(session.id);
                  }
                }}
              >
                <X size={10} />
              </span>
            </div>
          ))}
          {sessions.length === 0 ? <span className="hint">No sessions yet</span> : null}
        </div>
        <Button variant="primary" size="sm" onClick={() => setShellPicker(true)}>
          <Plus size={12} /> New tab
        </Button>
      </div>

      <div className="term-toolbar">
        <Button size="sm" onClick={() => void handleCopy()} label="Copy selection (Ctrl+Shift+C)">
          <ClipboardCopy size={12} /> Copy
        </Button>
        <Button size="sm" onClick={() => void handlePaste()} label="Paste (Ctrl+Shift+V)">
          <ClipboardPaste size={12} /> Paste
        </Button>
        <Segmented
          label="Font size"
          value={String(fontSize)}
          onChange={value => setFontSize(Number(value))}
          options={['10', '12', '14', '16'].map(value => ({value, label: value}))}
        />
        <Button size="sm" iconOnly label="Decrease font size" onClick={() => setFontSize(size => Math.max(9, size - 1))}>
          <Type size={12} />
        </Button>
        <Button size="sm" iconOnly label="Increase font size" onClick={() => setFontSize(size => Math.min(24, size + 1))}>
          <Type size={15} />
        </Button>
        <span style={{flex: 1}} />
        <Button
          size="sm"
          variant={split ? 'primary' : 'default'}
          onClick={() => {
            setSplit(value => !value);
            if (!split) {
              const candidate = sessions.find(item => item.id !== active?.id);
              if (candidate) setSecondaryId(candidate.id);
            }
          }}
          label="Toggle split pane"
        >
          <Columns2 size={12} /> Split
        </Button>
        <Button
          size="sm"
          iconOnly
          label="Clear terminal"
          onClick={() => actionsFor(focusPane)?.clear()}
          disabled={!active}
        >
          <RotateCcw size={12} />
        </Button>
      </div>

      <div className={`term-body ${split ? 'split' : ''}`}>
        <TerminalPane
          session={active}
          focused={!split || focusPane === 'primary'}
          fontSize={fontSize}
          light={lightTheme}
          onFocus={() => setFocusPane('primary')}
          onExit={code => notify(`${active?.title ?? 'Session'} exited (${code ?? '?'})`, code === 0 ? 'info' : 'error')}
          onState={(state, detail) => {
            if (state === 'closed' || state === 'error') setLinkNote(detail ?? '');
          }}
          registerActions={actions => {
            primaryActions.current = actions;
          }}
          onSplit={() => setSplit(true)}
          split={split}
          onCloseSplit={() => setSplit(false)}
          onNewTab={() => setShellPicker(true)}
        />
        {split ? (
          <TerminalPane
            session={secondary}
            focused={focusPane === 'secondary'}
            fontSize={fontSize}
            light={lightTheme}
            onFocus={() => setFocusPane('secondary')}
            onExit={code => notify(`split session exited (${code ?? '?'})`, 'info')}
            onState={() => undefined}
            registerActions={actions => {
              secondaryActions.current = actions;
            }}
            onSplit={() => undefined}
            split
            onCloseSplit={() => setSplit(false)}
            onNewTab={() => setShellPicker(true)}
          />
        ) : null}
      </div>

      {linkNote ? (
        <div className="hint" role="status">
          transport: {linkNote}
        </div>
      ) : null}

      {shellPicker ? (
        <Dialog
          title="New terminal tab"
          eyebrow="local shell"
          onClose={() => setShellPicker(false)}
          footer={
            <>
              <span className="hint">Choose the shell terminald will spawn.</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => setShellPicker(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void onCreate('local', chosenShell).then(session => {
                    if (session) setShellPicker(false);
                  });
                }}
              >
                <Power size={12} /> Start session
              </Button>
            </>
          }
        >
          <div className="list" role="listbox" aria-label="Shells">
            {shells.map(shell => (
              <button
                key={shell.id}
                type="button"
                role="option"
                aria-selected={chosenShell === shell.id}
                className="row"
                data-kb
                onClick={() => setChosenShell(shell.id)}
              >
                <SquareTerminal size={14} />
                <span className="row-main">
                  <strong>
                    {shell.name} {shell.default ? '· default' : ''}
                  </strong>
                  <small>{shell.path}</small>
                </span>
              </button>
            ))}
          </div>
          {currentShell ? <div className="hint">PTY size follows the pane; shell detection is daemon-side.</div> : null}
        </Dialog>
      ) : null}
    </div>
  );
};

export default TerminalPage;
