import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Download, Play, Radio, RefreshCw, Search, Square, X} from 'lucide-react';
import {
  errorMessage,
  exportLogs,
  fetchLogSources,
  fetchLogs,
  followLogs,
  type LogEntry,
  type LogQuery,
  type LogSource,
} from '../api';
import {Button, Chip, Empty, Segmented} from '../components';

const LEVELS = ['all', 'error', 'warning', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_LABEL: Record<Level, string> = {
  all: 'All',
  error: 'Errors',
  warning: 'Warn',
  info: 'Info',
  debug: 'Debug',
};

const MAX_ROWS = 1500;

export interface LogsPageProps {
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const LogsPage = ({notify}: LogsPageProps) => {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [sourceId, setSourceId] = useState('journald');
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [follow, setFollow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [durationMs, setDurationMs] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const viewRef = useRef<HTMLDivElement>(null);
  const disposeFollow = useRef<(() => void) | null>(null);

  const currentSource = sources.find(source => source.id === sourceId) ?? null;

  const activeQuery = useMemo<LogQuery>(
    () => ({
      source: sourceId,
      level: level === 'all' ? undefined : level,
      q: query.trim() || undefined,
      limit: 400,
    }),
    [sourceId, level, query],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchLogs(activeQuery);
      setEntries(result.entries);
      setDurationMs(result.durationMs);
    } catch (error) {
      setEntries([]);
      notify(errorMessage(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [activeQuery, notify]);

  useEffect(() => {
    void fetchLogSources()
      .then(list => {
        setSources(list);
        const firstAvailable = list.find(source => source.available);
        if (firstAvailable) setSourceId(firstAvailable.id);
      })
      .catch(error => notify(errorMessage(error), 'error'));
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    disposeFollow.current?.();
    disposeFollow.current = null;
    if (!follow) return undefined;
    disposeFollow.current = followLogs(activeQuery, {
      onBatch: batch => {
        if (batch.length === 0) return;
        // The stream replays the initial window on subscribe; merge by id so a
        // row already on screen is not duplicated.
        setEntries(previous => {
          const known = new Set(previous.map(entry => entry.id));
          return [...previous, ...batch.filter(entry => !known.has(entry.id))].slice(-MAX_ROWS);
        });
      },
      onError: message => notify(message, 'error'),
    });
    return () => {
      disposeFollow.current?.();
      disposeFollow.current = null;
    };
  }, [follow, activeQuery, notify]);

  useEffect(() => {
    if (!autoScroll) return;
    const node = viewRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, autoScroll]);

  const counts = useMemo(() => {
    const bucket: Record<string, number> = {error: 0, warning: 0, info: 0, debug: 0, other: 0};
    for (const entry of entries) {
      if (entry.level === 'error' || entry.level === 'crit' || entry.level === 'alert' || entry.level === 'emerg') bucket.error += 1;
      else if (entry.level === 'warning') bucket.warning += 1;
      else if (entry.level === 'info' || entry.level === 'notice') bucket.info += 1;
      else if (entry.level === 'debug') bucket.debug += 1;
      else bucket.other += 1;
    }
    return bucket;
  }, [entries]);

  const download = async () => {
    try {
      const {filename, text} = await exportLogs({...activeQuery, limit: 2000});
      const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      notify(`Exported ${filename}`, 'good');
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  };

  return (
    <div className="page tight" style={{display: 'flex', flexDirection: 'column', minHeight: 0}}>
      <div className="page-head" style={{marginBottom: 10}}>
        <div>
          <h2>Logs</h2>
          <p>
            journald and allowlisted file sources, read-only. Follow mode streams new entries; export downloads the
            current filter without writing to the host.
          </p>
        </div>
        <span className="spacer" />
        <Chip>{entries.length} rows</Chip>
        <Chip>{durationMs}ms</Chip>
        <Button iconOnly label="Reload log query" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="toolbar-row">
        <Segmented
          label="Log source"
          value={sourceId}
          onChange={setSourceId}
          options={sources.map(source => ({
            value: source.id,
            label: source.kind === 'journal' ? source.label : source.label,
          }))}
        />
        <span className="search-field">
          <Search size={12} />
          <input
            className="input"
            placeholder="Filter text (grep)"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label="Log text filter"
            data-kb
          />
          {query ? (
            <Button variant="ghost" size="sm" iconOnly label="Clear filter" onClick={() => setQuery('')}>
              <X size={11} />
            </Button>
          ) : null}
        </span>
        <Button
          size="sm"
          variant={follow ? 'primary' : 'default'}
          onClick={() => setFollow(value => !value)}
          label={follow ? 'Stop following' : 'Follow new entries'}
        >
          {follow ? <Square size={11} /> : <Radio size={11} />} {follow ? 'Following' : 'Follow'}
        </Button>
        <Button size="sm" onClick={() => void download()}>
          <Download size={11} /> Export
        </Button>
      </div>

      <div className="toolbar-row" style={{marginBottom: 8}}>
        <Segmented label="Level filter" value={level} onChange={value => setLevel(value)} options={LEVELS.map(value => ({value, label: LEVEL_LABEL[value]}))} />
        <Chip tone={counts.error > 0 ? 'danger' : ''}>{counts.error} errors</Chip>
        <Chip tone={counts.warning > 0 ? 'mock' : ''}>{counts.warning} warnings</Chip>
        <Chip>{counts.info} info</Chip>
        <Chip>{counts.debug} debug</Chip>
        <span style={{flex: 1}} />
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={autoScroll}
          aria-label="Auto-scroll new entries"
          data-kb
          onClick={() => setAutoScroll(value => !value)}
        >
          <span className="switch-track" aria-hidden="true" />
          <span style={{fontSize: 10}}>Auto-scroll</span>
        </button>
      </div>

      {currentSource && !currentSource.available ? (
        <Empty
          icon={<Play size={22} />}
          title={`${currentSource.label} unavailable`}
          body={currentSource.reason || 'This host does not expose the source.'}
        />
      ) : (
        <div
          className="log-view"
          ref={viewRef}
          role="log"
          aria-live={follow ? 'polite' : 'off'}
          aria-label="Log entries"
          data-kb
          tabIndex={0}
          onScroll={event => {
            const node = event.currentTarget;
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            if (atBottom !== autoScroll) setAutoScroll(atBottom);
          }}
        >
          {entries.length === 0 ? (
            <div className="hint" style={{padding: 14}}>
              {loading ? 'Loading…' : 'No entries match the current filter.'}
            </div>
          ) : (
            entries.map(entry => (
              <div className="log-line" key={entry.id} data-level={entry.level}>
                <span className="lt">{entry.time.slice(11, 19)}</span>
                <span className="lvl" data-level={entry.level}>
                  {entry.level}
                </span>
                <span className="lu">{entry.unit || '—'}</span>
                <span className="lm">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="hint" style={{marginTop: 7}}>
        Sources: {sources.map(source => `${source.label}${source.available ? '' : ' (unavailable)'}`).join(' · ') || 'loading'}
      </div>
    </div>
  );
};

export default LogsPage;
