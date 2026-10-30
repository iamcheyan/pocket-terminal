import {useCallback, useEffect, useState} from 'react';
import {Boxes, CircuitBoard, RefreshCw, Terminal} from 'lucide-react';
import {errorMessage, fetchMeta, fetchRuntime, type Meta, type RuntimeReport} from '../api';
import {Button, Card, Chip, Empty} from '../components';

export interface RuntimePageProps {
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const RuntimePage = ({notify}: RuntimePageProps) => {
  const [report, setReport] = useState<RuntimeReport | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [runtime, metaData] = await Promise.all([fetchRuntime(), fetchMeta()]);
      setReport(runtime);
      setMeta(metaData);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!report) {
    return (
      <Empty
        icon={<CircuitBoard size={22} />}
        title={busy ? 'Sampling runtime…' : 'Runtime inspector unavailable'}
        body="terminald reports its own process state plus PocketJS app discovery."
        action={<Button onClick={() => void load()}>Reload</Button>}
      />
    );
  }

  const daemon = report.daemon;
  const capabilities = Object.entries(meta?.capabilities ?? {});

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Runtime inspector</h2>
          <p>
            What this device is actually running: the daemon process, the Go runtime, discovered PocketJS bundles and
            reachable sibling services. No WebView internals are inspected.
          </p>
        </div>
        <span className="spacer" />
        <Chip>{report.generatedAt.slice(11, 19)}</Chip>
        <Button iconOnly label="Refresh runtime" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="grid cols-3" style={{marginBottom: 10}}>
        <Card eyebrow="daemon" title={String(daemon.name ?? 'terminald')}>
          <dl className="kv">
            <dt>version</dt>
            <dd>{String(daemon.version ?? '—')}</dd>
            <dt>pid</dt>
            <dd>{String(daemon.pid ?? '—')}</dd>
            <dt>uptime</dt>
            <dd>{String(daemon.uptime ?? '—')}</dd>
            <dt>addr</dt>
            <dd>{String(daemon.addr ?? '—')}</dd>
          </dl>
        </Card>
        <Card eyebrow="go runtime" title={String(report.go.version ?? 'go')}>
          <dl className="kv">
            <dt>goroutines</dt>
            <dd>{String(daemon.goroutines ?? '—')}</dd>
            <dt>heap</dt>
            <dd>{String(daemon.heapAllocBytes ?? '—')} B</dd>
            <dt>sys</dt>
            <dd>{String(daemon.sysBytes ?? '—')} B</dd>
            <dt>gc</dt>
            <dd>{String(daemon.gcCycles ?? '—')} cycles</dd>
          </dl>
        </Card>
        <Card eyebrow="host" title={String(report.host.hostname ?? 'host')}>
          <dl className="kv">
            <dt>os</dt>
            <dd>{String(report.host.os ?? '—')}</dd>
            <dt>kernel</dt>
            <dd>{String(report.host.kernel ?? '—')}</dd>
            <dt>cpu</dt>
            <dd>{String(report.host.numCPU ?? '—')} cores</dd>
            <dt>go</dt>
            <dd>{String(report.host.goVersion ?? '—')}</dd>
          </dl>
        </Card>
      </div>

      <div className="grid cols-2" style={{marginBottom: 10}}>
        <Card eyebrow="bridges" title="Sibling services" action={<CircuitBoard size={13} />}>
          <div className="list">
            {report.bridges.map(bridge => (
              <div className="row" key={bridge.id}>
                <span className={`dot ${bridge.reachable ? 'live' : ''}`} />
                <span className="row-main">
                  <strong>{bridge.label}</strong>
                  <small>{bridge.baseURL}</small>
                </span>
                {bridge.mock ? <Chip tone="mock">mock</Chip> : null}
                <Chip tone={bridge.reachable ? 'on' : ''}>{bridge.reachable ? `${bridge.latencyMs}ms` : 'offline'}</Chip>
              </div>
            ))}
          </div>
        </Card>

        <Card eyebrow="capabilities" title="Daemon features" action={<Terminal size={13} />}>
          <div className="list">
            {capabilities.map(([key, enabled]) => (
              <div className="row" key={key}>
                <span className={`dot ${enabled ? 'live' : ''}`} />
                <span className="row-main">
                  <strong>{key}</strong>
                </span>
                <Chip tone={enabled ? 'on' : ''}>{enabled ? 'enabled' : 'off'}</Chip>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card eyebrow="pocketjs" title="Discovered apps" action={<Boxes size={13} />}>
        {report.apps.length === 0 ? (
          <div className="hint">No PocketJS app bundles found under {report.appsRoots.join(', ') || 'known roots'}.</div>
        ) : (
          <div className="grid auto">
            {report.apps.map(app => (
              <div className="row" key={app.id}>
                <span className="profile-avatar">{app.name.slice(0, 2).toUpperCase()}</span>
                <span className="row-main">
                  <strong>{app.id}</strong>
                  <small>{app.path}</small>
                </span>
                {app.hasDist ? <Chip tone="on">dist</Chip> : <Chip>source</Chip>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {report.notes.length ? (
        <div className="hint" style={{marginTop: 10}}>
          {report.notes.map(note => (
            <div key={note}>· {note}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default RuntimePage;
