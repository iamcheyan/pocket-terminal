import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ArrowRight,
  Check,
  KeyRound,
  Lock,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react';
import {
  ApiError,
  connectProfile,
  deleteKnownHost,
  deleteProfile,
  errorMessage,
  fetchKnownHosts,
  fetchProfiles,
  saveProfile,
  testProfile,
  type KnownHost,
  type ProfileBundle,
  type ProfileInput,
  type SSHProfile,
  type SSHTestResult,
  type TerminalSession,
} from '../api';
import {Button, Card, Chip, Dialog, Empty, Field} from '../components';

export interface SSHPageProps {
  onConnected: (session: TerminalSession) => void;
  notify: (message: string, tone?: 'info' | 'good' | 'error') => void;
}

type EditorState = {mode: 'create'} | {mode: 'edit'; profile: SSHProfile} | null;

const emptyDraft: ProfileInput = {
  name: '',
  group: 'Lab',
  host: '',
  port: 22,
  user: 'root',
  authKind: 'password',
  password: '',
  privateKey: '',
  description: '',
};

const AuthBadge = ({profile}: {profile: SSHProfile}) => {
  const tone = profile.authKind === 'key' ? 'on' : '';
  const Icon = profile.authKind === 'key' ? KeyRound : Lock;
  return (
    <Chip tone={tone}>
      <Icon size={9} /> {profile.authKind}
      {profile.authKind === 'password' && profile.hasPassword ? ' · stored' : ''}
      {profile.authKind === 'key' && profile.hasKey ? ' · stored' : ''}
    </Chip>
  );
};

const SSHPage = ({onConnected, notify}: SSHPageProps) => {
  const [bundle, setBundle] = useState<ProfileBundle | null>(null);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [draft, setDraft] = useState<ProfileInput>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<SSHTestResult | null>(null);
  const [tofu, setTofu] = useState<{profile: SSHProfile; fingerprint: string; keyType: string; mock: boolean} | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SSHProfile | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const [profileBundle, hosts] = await Promise.all([fetchProfiles(), fetchKnownHosts()]);
      setBundle(profileBundle);
      setKnownHosts(hosts);
      setSelectedId(current => current ?? profileBundle.profiles[0]?.id ?? null);
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const profiles = bundle?.profiles ?? [];
  const selected = profiles.find(profile => profile.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(profile =>
      [profile.name, profile.host, profile.user, profile.group].some(value => value.toLowerCase().includes(needle)),
    );
  }, [profiles, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, SSHProfile[]>();
    for (const profile of filtered) {
      const list = map.get(profile.group) ?? [];
      list.push(profile);
      map.set(profile.group, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const openCreate = () => {
    setDraft({...emptyDraft, group: selected?.group ?? 'Lab'});
    setEditor({mode: 'create'});
  };

  const openEdit = (profile: SSHProfile) => {
    setDraft({
      name: profile.name,
      group: profile.group,
      host: profile.host,
      port: profile.port,
      user: profile.user,
      authKind: profile.authKind,
      description: profile.description,
      password: '',
      privateKey: '',
    });
    setEditor({mode: 'edit', profile});
  };

  const submitEditor = async () => {
    if (!draft.name?.trim() || !draft.host?.trim()) {
      notify('Name and host are required', 'error');
      return;
    }
    setBusy(true);
    try {
      const saved = await saveProfile(draft, editor?.mode === 'edit' ? editor.profile.id : undefined);
      notify(editor?.mode === 'edit' ? `Updated ${saved.name}` : `Created ${saved.name}`, 'good');
      setEditor(null);
      await load();
      setSelectedId(saved.id);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const connect = async (profile: SSHProfile, accept?: boolean, fingerprint?: string) => {
    setBusy(true);
    try {
      const session = await connectProfile(profile.id, {acceptHostKey: accept, fingerprint, cols: 0, rows: 0});
      setTofu(null);
      notify(`Connected to ${profile.name}${session.mock ? ' (mock target)' : ''}`, 'good');
      onConnected(session);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'host_key_unknown') {
        setTofu({
          profile,
          fingerprint: String(error.details.fingerprint ?? ''),
          keyType: String(error.details.keyType ?? 'unknown'),
          mock: Boolean(error.details.mock),
        });
        return;
      }
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const probe = async (profile: SSHProfile) => {
    setBusy(true);
    setTestResult(null);
    try {
      const result = await testProfile(profile.id);
      setTestResult(result);
      notify(result.authenticated ? 'Handshake and authentication succeeded' : result.message, result.authenticated ? 'good' : 'info');
      await load();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>SSH</h2>
          <p>
            Profiles, quick connect and host-key trust. Credentials are sealed with AES-256-GCM in terminald and never
            returned to this UI; the loopback fixture is labelled <code>mock</code> wherever it appears.
          </p>
        </div>
        <span className="spacer" />
        <Button variant="primary" onClick={openCreate}>
          <Plus size={13} /> New profile
        </Button>
        <Button iconOnly label="Refresh profiles" onClick={() => void load()}>
          <RefreshCw size={13} />
        </Button>
      </div>

      <div className="toolbar-row">
        <span className="search-field">
          <Server size={12} />
          <input
            className="input"
            placeholder="Filter by name, host, user or group"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            aria-label="Filter profiles"
            data-kb
          />
        </span>
        {bundle?.mockTarget.available ? (
          <Chip tone="mock">
            <Plug size={9} /> mock target 127.0.0.1:{bundle.mockTarget.port || '—'}
          </Chip>
        ) : (
          <Chip>no mock target</Chip>
        )}
        <Chip>{profiles.length} profiles</Chip>
        <Chip>{knownHosts.length} known hosts</Chip>
      </div>

      <div className="ssh-layout">
        <div>
          {grouped.length === 0 ? (
            <Empty
              icon={<Server size={22} />}
              title="No profiles"
              body="Add a host to connect. Passwords and private keys are encrypted before they touch disk."
              action={
                <Button variant="primary" onClick={openCreate}>
                  <Plus size={13} /> Create the first profile
                </Button>
              }
            />
          ) : (
            grouped.map(([group, list]) => (
              <div key={group}>
                <div className="group-head">
                  {group} <span>{list.length}</span>
                </div>
                <div className="list">
                  {list.map(profile => (
                    <button
                      key={profile.id}
                      type="button"
                      className="profile-card"
                      aria-selected={profile.id === selectedId}
                      data-kb
                      onClick={() => {
                        setSelectedId(profile.id);
                        setTestResult(null);
                      }}
                    >
                      <span className="profile-top">
                        <span className="profile-avatar" style={{color: profile.color}}>
                          {profile.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="profile-name">
                          <strong>{profile.name}</strong>
                          <small>
                            {profile.user}@{profile.host}:{profile.port}
                          </small>
                        </span>
                        {profile.mock ? <Chip tone="mock">mock</Chip> : null}
                        {profile.lastConnectedAt ? (
                          <Chip tone="on">
                            <Check size={9} /> used
                          </Chip>
                        ) : null}
                      </span>
                      <span className="profile-meta">
                        <AuthBadge profile={profile} />
                        {profile.hasKey || profile.hasPassword ? null : <Chip tone="danger">no secret</Chip>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="list">
          {selected ? (
            <Card
              eyebrow={selected.group}
              title={selected.name}
              action={selected.mock ? <Chip tone="mock">mock=true</Chip> : null}
            >
              <dl className="kv">
                <dt>target</dt>
                <dd>
                  {selected.user}@{selected.host}:{selected.port}
                </dd>
                <dt>auth</dt>
                <dd>
                  {selected.authKind} {selected.hasPassword ? '· password stored' : ''} {selected.hasKey ? '· key stored' : ''}
                </dd>
                <dt>trust</dt>
                <dd>{knownHosts.some(host => host.host === selected.host && host.port === selected.port) ? 'known host' : 'not trusted yet'}</dd>
                {selected.description ? (
                  <>
                    <dt>notes</dt>
                    <dd>{selected.description}</dd>
                  </>
                ) : null}
              </dl>
              <div className="toolbar-row" style={{marginTop: 10, marginBottom: 0}}>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void connect(selected)}>
                  <Plug size={12} /> Connect
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void probe(selected)}>
                  <ShieldCheck size={12} /> Test
                </Button>
                <Button size="sm" onClick={() => openEdit(selected)}>
                  <Pencil size={12} /> Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(selected)}>
                  <Trash2 size={12} /> Delete
                </Button>
              </div>
              {testResult ? (
                <div className="hint" role="status" style={{marginTop: 8}}>
                  reachable={String(testResult.reachable)} · authenticated={String(testResult.authenticated)} · key=
                  {testResult.hostKeyState} · {testResult.latencyMs}ms
                  {testResult.fingerprint ? <div style={{fontFamily: 'var(--font-mono)'}}>{testResult.fingerprint}</div> : null}
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card eyebrow="known_hosts" title="Trust store">
            {knownHosts.length === 0 ? (
              <div className="hint">Nothing trusted yet. The first connection to a host asks you to confirm its fingerprint (TOFU).</div>
            ) : (
              <div className="list">
                {knownHosts.map(host => (
                  <div className="row" key={host.id}>
                    <ShieldCheck size={13} />
                    <span className="row-main">
                      <strong>
                        {host.host}:{host.port} {host.mock ? '· mock' : ''}
                      </strong>
                      <small>
                        {host.keyType} {host.fingerprint}
                      </small>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      label={`Forget ${host.host}`}
                      onClick={() => {
                        void deleteKnownHost(host.id).then(() => load()).then(() => notify('Host key removed', 'good'));
                      }}
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card eyebrow="roadmap" title="Port forwarding">
            <div className="hint">
              {bundle?.portForwarding.status === 'todo' ? 'TODO —' : ''} {bundle?.portForwarding.note ??
                'Local and remote forwarding are not implemented in Phase 1. The surface is reserved here so it is not silently absent.'}
            </div>
            <div className="toolbar-row" style={{marginTop: 9, marginBottom: 0}}>
              <Button size="sm" disabled>
                <ArrowRight size={11} /> Local -L (planned)
              </Button>
              <Button size="sm" disabled>
                <ArrowRight size={11} /> Remote -R (planned)
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {editor ? (
        <Dialog
          title={editor.mode === 'edit' ? `Edit ${editor.profile.name}` : 'New SSH profile'}
          eyebrow="credentials stay server-side"
          onClose={() => setEditor(null)}
          footer={
            <>
              <span className="hint">Passwords and keys are encrypted with a daemon-owned key (0600).</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void submitEditor()}>
                <Check size={12} /> Save profile
              </Button>
            </>
          }
        >
          <div className="grid cols-2">
            <Field id="ssh-name" label="Name">
              <input
                id="ssh-name"
                data-autofocus
                className="input"
                value={draft.name ?? ''}
                onChange={event => setDraft({...draft, name: event.target.value})}
              />
            </Field>
            <Field id="ssh-group" label="Group">
              <input
                id="ssh-group"
                className="input"
                value={draft.group ?? ''}
                onChange={event => setDraft({...draft, group: event.target.value})}
              />
            </Field>
            <Field id="ssh-host" label="Host">
              <input
                id="ssh-host"
                className="input"
                placeholder="192.168.1.10 or host.lan"
                value={draft.host ?? ''}
                onChange={event => setDraft({...draft, host: event.target.value})}
              />
            </Field>
            <Field id="ssh-port" label="Port">
              <input
                id="ssh-port"
                className="input"
                inputMode="numeric"
                value={draft.port ?? 22}
                onChange={event => setDraft({...draft, port: Number(event.target.value) || 22})}
              />
            </Field>
            <Field id="ssh-user" label="User">
              <input
                id="ssh-user"
                className="input"
                value={draft.user ?? ''}
                onChange={event => setDraft({...draft, user: event.target.value})}
              />
            </Field>
            <Field id="ssh-auth" label="Auth">
              <div className="segmented" role="group" aria-label="Authentication method">
                {(['password', 'key', 'none'] as const).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={(draft.authKind ?? 'password') === kind}
                    onClick={() => setDraft({...draft, authKind: kind})}
                    data-kb
                  >
                    {kind}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          {draft.authKind === 'password' ? (
            <Field
              id="ssh-password"
              label="Password"
              hint={editor.mode === 'edit' ? 'Leave blank to keep the stored password.' : 'Encrypted before it is written to disk.'}
            >
              <input
                id="ssh-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={draft.password ?? ''}
                onChange={event => setDraft({...draft, password: event.target.value})}
              />
            </Field>
          ) : null}
          {draft.authKind === 'key' ? (
            <Field
              id="ssh-key"
              label="Private key"
              hint="Paste an OpenSSH private key. It is sealed with AES-256-GCM; the UI never receives it back."
            >
              <textarea
                id="ssh-key"
                className="textarea"
                value={draft.privateKey ?? ''}
                onChange={event => setDraft({...draft, privateKey: event.target.value})}
              />
            </Field>
          ) : null}
          <Field id="ssh-notes" label="Notes">
            <input
              id="ssh-notes"
              className="input"
              value={draft.description ?? ''}
              onChange={event => setDraft({...draft, description: event.target.value})}
            />
          </Field>
        </Dialog>
      ) : null}

      {tofu ? (
        <Dialog
          title="Unknown host key"
          eyebrow="trust on first use"
          onClose={() => setTofu(null)}
          footer={
            <>
              <span className="hint">Verify the fingerprint out-of-band before trusting.</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => setTofu(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void connect(tofu.profile, true, tofu.fingerprint)}
              >
                <ShieldCheck size={12} /> Trust and connect
              </Button>
            </>
          }
        >
          <div className="row" style={{alignItems: 'flex-start'}}>
            <ShieldAlert size={18} style={{color: 'var(--warn)', marginTop: 1}} />
            <div className="row-main">
              <strong>
                {tofu.profile.user}@{tofu.profile.host}:{tofu.profile.port}
              </strong>
              <small>
                {tofu.keyType} {tofu.mock ? '· mock target' : ''}
              </small>
            </div>
          </div>
          <div className="card tight" style={{fontFamily: 'var(--font-mono)', fontSize: 11, overflowWrap: 'anywhere'}}>
            {tofu.fingerprint}
          </div>
          <div className="hint">
            This fingerprint will be stored in known_hosts. A later connection presenting a different key is refused
            until you remove the entry.
          </div>
        </Dialog>
      ) : null}

      {confirmDelete ? (
        <Dialog
          title={`Delete ${confirmDelete.name}?`}
          eyebrow="destructive"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void deleteProfile(confirmDelete.id)
                    .then(() => {
                      notify(`Deleted ${confirmDelete.name}`, 'good');
                      setSelectedId(null);
                      setConfirmDelete(null);
                      return load();
                    })
                    .catch(error => notify(errorMessage(error), 'error'));
                }}
              >
                <Unplug size={12} /> Delete profile
              </Button>
            </>
          }
        >
          <p style={{margin: 0, fontSize: 11.5, lineHeight: 1.6}}>
            The stored credential is deleted with the profile. Known-host entries are kept so the next connection does
            not silently re-trust a changed key.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
};

export default SSHPage;
