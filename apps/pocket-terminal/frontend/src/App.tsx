import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Activity,
  CircuitBoard,
  Command,
  FileText,
  House,
  Server,
  Settings2,
  SquareTerminal,
  Sun,
  Moon,
  MonitorSmartphone,
  Zap,
} from 'lucide-react';
import {
  createSession,
  errorMessage,
  fetchMeta,
  fetchSessions,
  closeSession,
  type Meta,
  type SessionKind,
  type TerminalSession,
} from './api';
import {Button, Chip, Toasts, type ToastItem} from './components';
import {loadMapping, useInputNavigation} from './input';
import ActionsPage from './pages/Actions';
import DiagnosticsPage from './pages/Diagnostics';
import HomePage from './pages/Home';
import LogsPage from './pages/Logs';
import CommandPalette, {type PaletteCommand} from './pages/Palette';
import RuntimePage from './pages/Runtime';
import SSHPage from './pages/SSH';
import SettingsPage, {type LayoutMode, type SettingsState, type ThemeMode} from './pages/Settings';
import TerminalPage from './pages/Terminal';

type PageId = 'home' | 'terminal' | 'ssh' | 'logs' | 'diagnostics' | 'runtime' | 'actions' | 'settings';

const PAGES: {id: PageId; label: string; short: string; icon: typeof House}[] = [
  {id: 'home', label: 'Overview', short: 'Home', icon: House},
  {id: 'terminal', label: 'Terminal', short: 'Term', icon: SquareTerminal},
  {id: 'ssh', label: 'SSH', short: 'SSH', icon: Server},
  {id: 'logs', label: 'Logs', short: 'Logs', icon: FileText},
  {id: 'diagnostics', label: 'Diagnostics', short: 'Health', icon: Activity},
  {id: 'runtime', label: 'Runtime', short: 'Runtime', icon: CircuitBoard},
  {id: 'actions', label: 'Quick actions', short: 'Actions', icon: Zap},
  {id: 'settings', label: 'Settings', short: 'Setup', icon: Settings2},
];

const PAGE_TITLES: Record<PageId, string> = {
  home: 'Overview',
  terminal: 'Terminal',
  ssh: 'SSH manager',
  logs: 'Log viewer',
  diagnostics: 'System diagnostics',
  runtime: 'Runtime inspector',
  actions: 'Quick actions',
  settings: 'Settings & input',
};

const LAYOUT_KEY = 'pt.layout';
const THEME_KEY = 'pt.theme';
const FONT_KEY = 'pt.font';
const LAST_PAGE_KEY = 'pt.page';

const readLayout = (): LayoutMode => {
  const raw = localStorage.getItem(LAYOUT_KEY);
  return raw === 'handheld' || raw === 'eink' || raw === 'desktop' ? raw : 'desktop';
};

const readTheme = (): ThemeMode => {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === 'light' ? 'light' : 'dark';
};

const readPage = (): PageId => {
  const raw = new URLSearchParams(window.location.search).get('page');
  if (raw && PAGES.some(page => page.id === raw)) return raw as PageId;
  const stored = localStorage.getItem(LAST_PAGE_KEY);
  return stored && PAGES.some(page => page.id === stored) ? (stored as PageId) : 'home';
};

export default function App() {
  const [page, setPage] = useState<PageId>(readPage);
  const [settings, setSettings] = useState<SettingsState>(() => ({
    layout: readLayout(),
    theme: readTheme(),
    font: localStorage.getItem(FONT_KEY) === 'system' ? 'system' : 'mono',
    touchTargets: true,
  }));
  const [meta, setMeta] = useState<Meta | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [health, setHealth] = useState<{live: boolean; detail: string}>({live: false, detail: 'connecting'});
  const toastSeq = useRef(0);

  const notify = useCallback((message: string, tone: 'info' | 'good' | 'error' = 'info') => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts(items => [...items.slice(-3), {id, message, tone}]);
    window.setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 4800);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.layout = settings.layout;
    document.documentElement.dataset.font = settings.font;
    localStorage.setItem(THEME_KEY, settings.theme);
    localStorage.setItem(LAYOUT_KEY, settings.layout);
    localStorage.setItem(FONT_KEY, settings.font);
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(LAST_PAGE_KEY, page);
    const url = new URL(window.location.href);
    url.searchParams.set('page', page);
    window.history.replaceState(null, '', url);
  }, [page]);

  const refreshSessions = useCallback(async () => {
    try {
      const result = await fetchSessions();
      setSessions(result.sessions);
      setActiveSessionId(current =>
        current && result.sessions.some(session => session.id === current)
          ? current
          : (result.sessions.find(session => session.state === 'running')?.id ?? result.sessions[0]?.id ?? null),
      );
    } catch (error) {
      setHealth({live: false, detail: errorMessage(error)});
    }
  }, []);

  useEffect(() => {
    void fetchMeta()
      .then(data => {
        setMeta(data);
        setHealth({live: true, detail: `${data.service} ${data.version}`});
      })
      .catch(error => {
        setHealth({live: false, detail: errorMessage(error)});
        notify(`terminald unreachable: ${errorMessage(error)}`, 'error');
      });
    void refreshSessions();
  }, [notify, refreshSessions]);

  const spawn = useCallback(
    async (kind: SessionKind, shell?: string): Promise<TerminalSession | null> => {
      try {
        const session = await createSession({shell, cols: 120, rows: 30, title: kind === 'ssh' ? 'ssh' : undefined});
        setSessions(current => [...current, session]);
        setActiveSessionId(session.id);
        setPage('terminal');
        notify(`Started ${session.title}`, 'good');
        return session;
      } catch (error) {
        notify(errorMessage(error), 'error');
        return null;
      }
    },
    [notify],
  );

  const killSession = useCallback(
    async (id: string) => {
      try {
        await closeSession(id);
      } catch (error) {
        // A session that already exited 404s; that is the desired end state.
        if (!(error instanceof Error)) notify(errorMessage(error), 'error');
      }
      await refreshSessions();
    },
    [notify, refreshSessions],
  );

  const onSSHConnected = useCallback(
    (session: TerminalSession) => {
      setSessions(current => [...current.filter(item => item.id !== session.id), session]);
      setActiveSessionId(session.id);
      setPage('terminal');
    },
    [],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const nav: PaletteCommand[] = PAGES.map(item => ({
      id: `nav-${item.id}`,
      title: `Go to ${item.label}`,
      detail: item.id === 'terminal' ? 'PTY tabs, split pane, clipboard' : undefined,
      group: 'Navigate',
      keywords: `page ${item.id}`,
      run: () => setPage(item.id),
    }));
    const shell: PaletteCommand[] = [
      {
        id: 'shell-new',
        title: 'New local shell',
        detail: meta?.shells.find(candidate => candidate.default)?.path ?? 'default $SHELL',
        group: 'Terminal',
        keywords: 'tab bash zsh fish pty',
        run: () => void spawn('local'),
      },
      {
        id: 'shell-new-tab',
        title: 'Open terminal page',
        group: 'Terminal',
        run: () => setPage('terminal'),
      },
      {
        id: 'ssh-mock',
        title: 'SSH quick connect (mock target)',
        detail: 'loopback fixture bundled with terminald',
        group: 'SSH',
        keywords: 'demo pocket loopback',
        run: () => setPage('ssh'),
      },
    ];
    const theme: PaletteCommand[] = [
      {
        id: 'theme-toggle',
        title: `Switch to ${settings.theme === 'dark' ? 'light' : 'dark'} theme`,
        group: 'Appearance',
        run: () => setSettings(current => ({...current, theme: current.theme === 'dark' ? 'light' : 'dark'})),
      },
      {
        id: 'layout-handheld',
        title: 'Layout: handheld',
        group: 'Appearance',
        run: () => setSettings(current => ({...current, layout: 'handheld'})),
      },
      {
        id: 'layout-eink',
        title: 'Layout: e-ink',
        group: 'Appearance',
        run: () => setSettings(current => ({...current, layout: 'eink'})),
      },
      {
        id: 'layout-desktop',
        title: 'Layout: desktop',
        group: 'Appearance',
        run: () => setSettings(current => ({...current, layout: 'desktop'})),
      },
    ];
    const sessionCommands: PaletteCommand[] = sessions.slice(0, 8).map(session => ({
      id: `session-${session.id}`,
      title: `Focus tab: ${session.title}`,
      detail: `${session.kind} · ${session.state}${session.mock ? ' · mock' : ''}`,
      group: 'Sessions',
      run: () => {
        setActiveSessionId(session.id);
        setPage('terminal');
      },
    }));
    return [...nav, ...shell, ...sessionCommands, ...theme];
  }, [meta?.shells, sessions, settings.theme, spawn]);

  const back = useCallback(() => {
    if (paletteOpen) {
      setPaletteOpen(false);
      return;
    }
    if (page !== 'home') setPage('home');
  }, [page, paletteOpen]);

  useInputNavigation({
    onPalette: () => setPaletteOpen(value => !value),
    onBack: back,
    suspended: paletteOpen,
    mapping: loadMapping(),
  });

  const running = sessions.filter(session => session.state === 'running').length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Command size={15} />
          </span>
          <span className="brand-copy">
            <strong>Pocket Terminal</strong>
            <span>PJOS console</span>
          </span>
        </div>
        <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)} data-kb>
          <Command size={12} />
          <span>Command palette</span>
          <kbd>⌘K</kbd>
        </button>
        <div className="nav-label">Workspace</div>
        <nav className="nav-group" aria-label="Primary">
          {PAGES.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => setPage(item.id)}
                data-kb
              >
                <Icon size={14} />
                <span>{item.label}</span>
                {item.id === 'terminal' && running > 0 ? <span className="nav-count">{running}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="engine-line">
            <span className={`dot ${health.live ? 'live' : 'bad'}`} />
            terminald {health.live ? 'online' : 'offline'}
          </div>
          <div className="engine-line" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
            {health.detail}
          </div>
          <div className="chip-row">
            <Chip>{settings.layout}</Chip>
            <Chip>{settings.theme}</Chip>
            {meta?.capabilities.mockSSH ? <Chip tone="mock">mock ssh</Chip> : null}
            {meta?.capabilities.systemControl ? <Chip tone="danger">control on</Chip> : null}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{PAGE_TITLES[page]}</h1>
            <span className="crumb">{running} live · {health.live ? 'daemon ok' : 'daemon down'}</span>
          </div>
          <div className="topbar-actions">
            <Button
              size="sm"
              iconOnly
              label={`Switch to ${settings.theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={() => setSettings(current => ({...current, theme: current.theme === 'dark' ? 'light' : 'dark'}))}
            >
              {settings.theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            </Button>
            <Button
              size="sm"
              iconOnly
              label="Cycle layout profile"
              onClick={() =>
                setSettings(current => ({
                  ...current,
                  layout:
                    current.layout === 'desktop' ? 'handheld' : current.layout === 'handheld' ? 'eink' : 'desktop',
                }))
              }
            >
              <MonitorSmartphone size={13} />
            </Button>
            <Button size="sm" onClick={() => setPaletteOpen(true)}>
              <Command size={12} /> Palette
            </Button>
          </div>
        </header>

        {page === 'terminal' ? (
          <div className="page tight">
            <TerminalPage
              sessions={sessions}
              shells={meta?.shells ?? []}
              activeId={activeSessionId}
              defaultShell={meta?.defaultShell ?? ''}
              onActivate={id => setActiveSessionId(id)}
              onClose={id => void killSession(id)}
              onCreate={spawn}
              notify={notify}
            />
          </div>
        ) : (
          <div className="page">
            {page === 'home' ? (
              <HomePage
                onNavigate={target => setPage(target as PageId)}
                onQuickShell={() => void spawn('local')}
                notify={notify}
              />
            ) : null}
            {page === 'ssh' ? <SSHPage onConnected={onSSHConnected} notify={notify} /> : null}
            {page === 'logs' ? <LogsPage notify={notify} /> : null}
            {page === 'diagnostics' ? <DiagnosticsPage notify={notify} /> : null}
            {page === 'runtime' ? <RuntimePage notify={notify} /> : null}
            {page === 'actions' ? <ActionsPage notify={notify} /> : null}
            {page === 'settings' ? (
              <SettingsPage
                settings={settings}
                onChange={patch => setSettings(current => ({...current, ...patch}))}
                runtime={{
                  version: meta?.version ?? '—',
                  shells: meta?.shells.length ?? 0,
                  sessions: sessions.length,
                  mock: meta?.capabilities.mockSSH ?? false,
                }}
              />
            ) : null}
          </div>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Primary (handheld)">
        {PAGES.filter(item => item.id !== 'settings').map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
              data-kb
            >
              <Icon size={16} />
              <span>{item.short}</span>
            </button>
          );
        })}
      </nav>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <Toasts items={toasts} onDismiss={id => setToasts(items => items.filter(item => item.id !== id))} />
    </div>
  );
}
