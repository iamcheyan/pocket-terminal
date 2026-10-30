import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Activity,
  Cpu,
  HardDrive,
  Network,
  RefreshCw,
  Server,
  Thermometer,
  Timer,
} from 'lucide-react';
import {
  errorMessage,
  fetchDiagnostics,
  fetchRuntime,
  formatBytes,
  formatDuration,
  type DiagnosticReport,
  type RuntimeReport,
} from '../api';
import {Button, Card, Chip, Empty, Meter} from '../components';

export interface DiagnosticsPageProps {
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const toneFor = (percent: number): 'warn' | 'bad' | undefined => (percent > 90 ? 'bad' : percent > 75 ? 'warn' : undefined);

const DiagnosticsPage = ({notify}: DiagnosticsPageProps) => {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [runtime, setRuntime] = useState<RuntimeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [diag, rt] = await Promise.all([fetchDiagnostics(), fetchRuntime()]);
      setReport(diag);
      setRuntime(rt);
      setError('');
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const host = report?.host ?? {};
  const memory = report?.memory.find(metric => metric.label === 'Memory used');
  const swap = report?.memory.find(metric => metric.label === 'Swap used');
  const cpu = report?.cpu.find(metric => metric.label === 'CPU usage');

  const services = useMemo(() => runtime?.bridges ?? [], [runtime]);

  if (error && !report) {
    return (
      <Empty
        icon={<Activity size={22} />}
        title="Diagnostics unavailable"
        body={error}
        action={<Button onClick={() => void load()}>Retry</Button>}
      />
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Diagnostics</h2>
          <p>
            Host health collected by terminald from procfs, sysfs and systemd. Every block names its provider so a
            missing subsystem reads as unavailable instead of zero.
          </p>
        </div>
        <span className="spacer" />
        {report ? <Chip>{report.generatedAt.slice(11, 19)}</Chip> : null}
        <Button iconOnly label="Refresh diagnostics" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="grid cols-4" style={{marginBottom: 10}}>
        <Card eyebrow="cpu" title="Processor">
          <div className="metric-value">
            {cpu ? cpu.value.toFixed(1) : '—'}
            <span className="metric-unit">%</span>
          </div>
          {cpu ? <Meter percent={cpu.percent} tone={toneFor(cpu.percent)} /> : null}
          <div className="metric-detail">{cpu?.detail || `${host.numCPU ?? '—'} cores`}</div>
        </Card>
        <Card eyebrow="memory" title="RAM">
          <div className="metric-value">
            {memory ? formatBytes(memory.value) : '—'}
          </div>
          {memory ? <Meter percent={memory.percent} tone={toneFor(memory.percent)} /> : null}
          <div className="metric-detail">{memory?.detail || 'unavailable'}</div>
        </Card>
        <Card eyebrow="swap" title="Swap">
          <div className="metric-value">{swap ? formatBytes(swap.value) : '—'}</div>
          {swap ? <Meter percent={swap.percent} tone={toneFor(swap.percent)} /> : null}
          <div className="metric-detail">{swap?.detail || 'no swap configured'}</div>
        </Card>
        <Card eyebrow="uptime" title="Uptime">
          <div className="metric-value">{report ? formatDuration(report.uptime) : '—'}</div>
          <div className="metric-detail">
            load {report?.load.map(value => value.toFixed(2)).join(' · ') || '—'}
          </div>
        </Card>
      </div>

      <div className="grid cols-2" style={{marginBottom: 10}}>
        <Card eyebrow="storage" title="Filesystems" action={<HardDrive size={13} />}>
          {report?.disks.length ? (
            <div className="list">
              {report.disks.map(disk => (
                <div key={disk.mount}>
                  <div style={{display: 'flex', alignItems: 'baseline', gap: 8}}>
                    <strong style={{fontFamily: 'var(--font-mono)', fontSize: 10.5}}>{disk.mount}</strong>
                    {disk.aliases.length ? (
                      <span className="hint" style={{fontFamily: 'var(--font-mono)', fontSize: 9}}>
                        + {disk.aliases.join(', ')}
                      </span>
                    ) : null}
                    <span className="spacer" style={{flex: 1}} />
                    <span className="hint">
                      {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)} · {disk.usedPct}%
                    </span>
                  </div>
                  <Meter percent={disk.usedPct} tone={toneFor(disk.usedPct)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">statfs unavailable for the standard mounts.</div>
          )}
        </Card>

        <Card eyebrow="thermal" title="Temperatures" action={<Thermometer size={13} />}>
          {report?.temperatures.length ? (
            <div className="list">
              {report.temperatures.map(zone => (
                <div className="row" key={zone.zone}>
                  <span className="row-main">
                    <strong>{zone.label}</strong>
                    <small>{zone.zone}</small>
                  </span>
                  <Chip tone={zone.celsius > 80 ? 'danger' : zone.celsius > 65 ? 'mock' : ''}>{zone.celsius.toFixed(1)} °C</Chip>
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">No thermal zones exposed by this kernel.</div>
          )}
        </Card>
      </div>

      <div className="grid cols-2" style={{marginBottom: 10}}>
        <Card eyebrow="network" title="Interfaces" action={<Network size={13} />}>
          {report?.network.length ? (
            <div className="list">
              {report.network.slice(0, 6).map(net => (
                <div className="row" key={net.interface}>
                  <span className="row-main">
                    <strong>{net.interface}</strong>
                    <small>
                      ↑ {formatBytes(net.txBytes)} · ↓ {formatBytes(net.rxBytes)}
                    </small>
                  </span>
                  <span className="hint" style={{fontFamily: 'var(--font-mono)'}}>
                    {net.rxRate.toFixed(0)} B/s
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">/proc/net/dev unavailable.</div>
          )}
        </Card>

        <Card eyebrow="systemd" title="Services" action={<Server size={13} />}>
          {report?.services.length ? (
            <div className="list">
              {report.services.map(service => (
                <div className="row" key={service.name}>
                  <span className={`dot ${service.active === 'active' ? 'live' : service.active === 'failed' ? 'bad' : ''}`} />
                  <span className="row-main">
                    <strong>{service.name}</strong>
                    <small>{service.description || `${service.load} / ${service.sub}`}</small>
                  </span>
                  <Chip tone={service.active === 'active' ? 'on' : service.active === 'failed' ? 'danger' : ''}>{service.active}</Chip>
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">systemctl is not available on this host.</div>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card eyebrow="pocketjs runtime" title="Runtime bridges" action={<Cpu size={13} />}>
          <div className="list">
            {services.map(bridge => (
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
            {services.length === 0 ? <div className="hint">No bridge probes returned.</div> : null}
          </div>
          <div className="hint" style={{marginTop: 8}}>
            PocketJS apps discovered: {runtime?.apps.length ?? 0} · roots {runtime?.appsRoots.join(', ') || 'none'}
          </div>
        </Card>

        <Card eyebrow="host" title="Identity" action={<Timer size={13} />}>
          <dl className="kv">
            <dt>host</dt>
            <dd>{String(host.hostname ?? '—')}</dd>
            <dt>os</dt>
            <dd>{String(host.os ?? '—')}</dd>
            <dt>kernel</dt>
            <dd>{String(host.kernel ?? '—')}</dd>
            <dt>arch</dt>
            <dd>{String(host.arch ?? '—')}</dd>
            <dt>boot</dt>
            <dd>{String(host.bootTime ?? '—')}</dd>
            <dt>providers</dt>
            <dd style={{fontFamily: 'var(--font-mono)', fontSize: 9.5}}>
              {Object.entries(report?.providers ?? {})
                .map(([key, value]) => `${key}=${value}`)
                .join(' · ') || 'none'}
            </dd>
          </dl>
        </Card>
      </div>
    </div>
  );
};

export default DiagnosticsPage;
