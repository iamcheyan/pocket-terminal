import {useCallback, useEffect, useState} from 'react';
import {
  Activity,
  ArrowRight,
  Boxes,
  CircuitBoard,
  FileText,
  Plug,
  Server,
  Sparkles,
  SquareTerminal,
  Zap,
} from 'lucide-react';
import {
  errorMessage,
  fetchActions,
  fetchProfiles,
  fetchRuntime,
  fetchSessions,
  type ActionSpec,
  type ProfileBundle,
  type RuntimeReport,
  type TerminalSession,
} from '../api';
import {Button, Card, Chip} from '../components';

export interface HomePageProps {
  onNavigate: (page: string) => void;
  onQuickShell: () => void;
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const HomePage = ({onNavigate, onQuickShell, notify}: HomePageProps) => {
  const [bundle, setBundle] = useState<ProfileBundle | null>(null);
  const [runtime, setRuntime] = useState<RuntimeReport | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [actions, setActions] = useState<ActionSpec[]>([]);

  const load = useCallback(async () => {
    try {
      const [profiles, rt, sessionList, actionList] = await Promise.all([
        fetchProfiles(),
        fetchRuntime(),
        fetchSessions(),
        fetchActions(),
      ]);
      setBundle(profiles);
      setRuntime(rt);
      setSessions(sessionList.sessions);
      setActions(actionList.actions);
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const bridges = runtime?.bridges ?? [];
  const online = bridges.filter(bridge => bridge.reachable).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Developer console</h2>
          <p>
            Terminal, SSH, logs, diagnostics and runtime inspection in one surface. Start with a quick action or the
            command palette — the raw shell is the advanced path, not the entry fee.
          </p>
        </div>
        <span className="spacer" />
        <Button variant="primary" onClick={onQuickShell}>
          <SquareTerminal size={13} /> New shell
        </Button>
      </div>

      <div className="grid cols-4" style={{marginBottom: 10}}>
        <Card eyebrow="sessions" title="Terminal">
          <div className="metric-value">{sessions.length}</div>
          <div className="metric-detail">
            {sessions.filter(session => session.kind === 'ssh').length} ssh ·{' '}
            {sessions.filter(session => session.kind === 'local').length} local
          </div>
          <Button size="sm" variant="ghost" onClick={() => onNavigate('terminal')} style={{marginTop: 8}}>
            Open terminal <ArrowRight size={11} />
          </Button>
        </Card>
        <Card eyebrow="ssh" title="Profiles">
          <div className="metric-value">{bundle?.profiles.length ?? '—'}</div>
          <div className="metric-detail">
            {bundle?.mockTarget.available ? 'mock target available' : 'no mock target'}
          </div>
          <Button size="sm" variant="ghost" onClick={() => onNavigate('ssh')} style={{marginTop: 8}}>
            Manage hosts <ArrowRight size={11} />
          </Button>
        </Card>
        <Card eyebrow="runtime" title="Bridges">
          <div className="metric-value">
            {online}
            <span className="metric-unit">/{bridges.length || '—'}</span>
          </div>
          <div className="metric-detail">PocketJS services reachable</div>
          <Button size="sm" variant="ghost" onClick={() => onNavigate('runtime')} style={{marginTop: 8}}>
            Inspect runtime <ArrowRight size={11} />
          </Button>
        </Card>
        <Card eyebrow="apps" title="PocketJS">
          <div className="metric-value">{runtime?.apps.length ?? '—'}</div>
          <div className="metric-detail">{runtime?.apps.filter(app => app.hasDist).length ?? 0} built bundles</div>
          <Button size="sm" variant="ghost" onClick={() => onNavigate('diagnostics')} style={{marginTop: 8}}>
            Health panel <ArrowRight size={11} />
          </Button>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card eyebrow="quick actions" title="Start here" action={<Zap size={13} />}>
          <div className="list">
            {actions.slice(0, 5).map(action => (
              <button
                key={action.id}
                type="button"
                className="row"
                data-kb
                onClick={() => onNavigate('actions')}
                aria-label={action.title}
              >
                <Sparkles size={13} />
                <span className="row-main">
                  <strong>{action.title}</strong>
                  <small>
                    {action.category} · {action.support}
                  </small>
                </span>
                {action.dangerous ? <Chip tone="danger">confirm</Chip> : null}
              </button>
            ))}
            {actions.length === 0 ? <div className="hint">Loading action catalog…</div> : null}
          </div>
        </Card>

        <Card eyebrow="surfaces" title="Jump to" action={<Boxes size={13} />}>
          <div className="list">
            {[
              {id: 'terminal', title: 'Terminal', detail: 'PTY tabs, split panes, copy/paste', icon: <SquareTerminal size={13} />},
              {id: 'ssh', title: 'SSH', detail: 'Profiles, TOFU host keys, mock target', icon: <Server size={13} />},
              {id: 'logs', title: 'Logs', detail: 'journald + file sources, follow, export', icon: <FileText size={13} />},
              {id: 'diagnostics', title: 'Diagnostics', detail: 'CPU, memory, disks, thermals, services', icon: <Activity size={13} />},
              {id: 'runtime', title: 'Runtime inspector', detail: 'Daemon, Go runtime, PocketJS apps', icon: <CircuitBoard size={13} />},
            ].map(item => (
              <button key={item.id} type="button" className="row" data-kb onClick={() => onNavigate(item.id)}>
                {item.icon}
                <span className="row-main">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
                <ArrowRight size={12} />
              </button>
            ))}
          </div>
        </Card>
      </div>

      {bundle?.mockTarget.available ? (
        <div style={{marginTop: 10}}>
          <Card eyebrow="mock fixture" title="Loopback SSH target" action={<Plug size={13} />}>
            <div className="hint">
              {bundle.mockTarget.note} Connect with <code>{bundle.mockTarget.user}</code> to{' '}
              <code>{bundle.mockTarget.host}:{bundle.mockTarget.port}</code>. Sessions opened through it are labelled{' '}
              <code>mock=true</code> in the terminal status bar.
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};

export default HomePage;
