import {useCallback, useEffect, useMemo, useState} from 'react';
import {AlertTriangle, Play, RefreshCw, ShieldQuestion} from 'lucide-react';
import {errorMessage, fetchActions, runAction, type ActionSpec, type ActionResult} from '../api';
import {Button, Card, Chip, Dialog, Empty} from '../components';

export interface ActionsPageProps {
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

const CategoryIcon = ({category}: {category: string}) => {
  const letter = category.slice(0, 1).toUpperCase();
  return <span className="profile-avatar">{letter}</span>;
};

const renderPreview = (preview: unknown) => {
  if (preview === null || preview === undefined) return null;
  return (
    <pre
      style={{
        margin: '8px 0 0',
        padding: 9,
        border: '1px solid var(--line)',
        borderRadius: 7,
        background: 'var(--term-bg)',
        color: 'var(--term-fg)',
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        lineHeight: 1.5,
        maxHeight: 210,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {JSON.stringify(preview, null, 2)}
    </pre>
  );
};

const ActionsPage = ({notify}: ActionsPageProps) => {
  const [actions, setActions] = useState<ActionSpec[]>([]);
  const [controlEnabled, setControlEnabled] = useState(false);
  const [policy, setPolicy] = useState('');
  const [pending, setPending] = useState<ActionSpec | null>(null);
  const [results, setResults] = useState<Record<string, ActionResult>>({});
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const bundle = await fetchActions();
      setActions(bundle.actions);
      setControlEnabled(bundle.controlEnabled);
      setPolicy(bundle.policy);
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, ActionSpec[]>();
    for (const action of actions) {
      const list = map.get(action.category) ?? [];
      list.push(action);
      map.set(action.category, list);
    }
    return Array.from(map.entries());
  }, [actions]);

  const execute = async (action: ActionSpec, confirm: boolean) => {
    setBusy(action.id);
    try {
      const result = await runAction(action.id, confirm);
      setResults(previous => ({...previous, [action.id]: result}));
      if (result.refusal === 'confirmation_required') {
        setPending(action);
        return;
      }
      if (result.refusal) {
        notify(`${action.title}: ${result.refusal}`, 'error');
      } else {
        notify(`${action.title} completed in ${result.durationMs}ms`, 'good');
      }
      setPending(null);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Quick actions</h2>
          <p>
            Allowlisted operations with explicit confirmation. The daemon never runs a shell string: argv is fixed
            server-side, and system-control actions stay disabled unless terminald was started with the flag.
          </p>
        </div>
        <span className="spacer" />
        <Chip tone={controlEnabled ? 'mock' : ''}>{controlEnabled ? 'system control ON' : 'system control off'}</Chip>
        <Button iconOnly label="Reload actions" onClick={() => void load()}>
          <RefreshCw size={13} />
        </Button>
      </div>

      {actions.length === 0 ? (
        <Empty icon={<ShieldQuestion size={22} />} title="No actions" body="terminald returned an empty catalog." />
      ) : (
        grouped.map(([category, list]) => (
          <div key={category} style={{marginBottom: 12}}>
            <div className="group-head">{category}</div>
            <div className="grid auto">
              {list.map(action => {
                const result = results[action.id];
                return (
                  <Card key={action.id} className="tight">
                    <div className="card-head" style={{marginBottom: 6}}>
                      <CategoryIcon category={category} />
                      <div style={{minWidth: 0}}>
                        <h3>{action.title}</h3>
                        <div className="eyebrow">{action.support}</div>
                      </div>
                      <span className="spacer" />
                      {action.dangerous ? <Chip tone="danger">confirm</Chip> : null}
                      {action.needsRoot ? <Chip>root</Chip> : null}
                    </div>
                    <div className="hint">{action.description}</div>
                    <div className="toolbar-row" style={{marginTop: 8, marginBottom: 0}}>
                      <Button
                        size="sm"
                        variant={action.dangerous ? 'danger' : 'default'}
                        disabled={busy === action.id}
                        onClick={() => {
                          if (action.dangerous) {
                            setPending(action);
                            return;
                          }
                          void execute(action, false);
                        }}
                      >
                        <Play size={11} /> {action.dangerous ? 'Review & run' : 'Run'}
                      </Button>
                      {result ? (
                        <Chip tone={result.refusal ? 'danger' : 'on'}>
                          {result.refusal ? result.refusal : `${result.durationMs}ms`}
                        </Chip>
                      ) : null}
                    </div>
                    {result?.output ? (
                      <pre
                        style={{
                          margin: '8px 0 0',
                          padding: 8,
                          border: '1px solid var(--line)',
                          borderRadius: 6,
                          background: 'var(--term-bg)',
                          color: 'var(--term-fg)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9,
                          maxHeight: 160,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {result.output}
                      </pre>
                    ) : null}
                    {result ? renderPreview(result.preview) : null}
                  </Card>
                );
              })}
            </div>
          </div>
        ))
      )}

      {policy ? <div className="hint">{policy}</div> : null}

      {pending ? (
        <Dialog
          title={pending.title}
          eyebrow="confirm action"
          onClose={() => setPending(null)}
          footer={
            <>
              <span className="hint">{pending.needsRoot ? 'Requires root; will be refused without system control.' : 'Scoped to terminald.'}</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy === pending.id}
                onClick={() => void execute(pending, true)}
              >
                <AlertTriangle size={12} /> Confirm and run
              </Button>
            </>
          }
        >
          <p style={{margin: 0, fontSize: 11.5, lineHeight: 1.6}}>{pending.description}</p>
          <div className="hint">
            support={pending.support} · dangerous={String(pending.dangerous)} · needsRoot={String(pending.needsRoot)}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
};

export default ActionsPage;
