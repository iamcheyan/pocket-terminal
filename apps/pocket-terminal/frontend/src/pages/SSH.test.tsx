import {render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import type {ProfileBundle, SSHProfile, TerminalSession} from '../api';
import SSHPage from './SSH';

/**
 * SSH page interaction tests: the TOFU contract (409 → dialog → explicit
 * accept) is the security-relevant path, so it is asserted at the component
 * level as well as in the Go integration test.
 */

const profile: SSHProfile = {
  id: 'p-mock',
  name: 'Mock Lab',
  group: 'Demo',
  host: '127.0.0.1',
  port: 2222,
  user: 'demo',
  authKind: 'password',
  hasPassword: true,
  hasKey: false,
  mock: true,
  color: '#c4dc9c',
  description: 'loopback fixture',
  createdAt: '2026-01-01T00:00:00Z',
  lastConnectedAt: '',
};

const bundle: ProfileBundle = {
  profiles: [profile],
  groups: {Demo: 1},
  mockTarget: {available: true, host: '127.0.0.1', port: 2222, user: 'demo', note: 'loopback'},
  portForwarding: {supported: false, status: 'todo', note: 'Local and remote forwarding are planned.'},
};

const session: TerminalSession = {
  id: 's-1',
  title: 'Mock Lab',
  shell: 'ssh demo@127.0.0.1',
  shellId: 'ssh',
  kind: 'ssh',
  tabsGroup: 'main',
  profileId: 'p-mock',
  mock: true,
  state: 'running',
  createdAt: '2026-01-01T00:00:00Z',
  exitCode: null,
  rows: 30,
  cols: 100,
  bytes: 0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

const installFetch = (connectResponses: Response[]) => {
  const calls: {url: string; body: unknown}[] = [];
  const queue = [...connectResponses];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({url, body: init?.body ? JSON.parse(String(init.body)) : undefined});
    if (url.endsWith('/api/ssh/profiles') && (!init || init.method !== 'POST')) {
      return json(bundle);
    }
    if (url.endsWith('/api/ssh/known-hosts')) return json({knownHosts: []});
    if (url.endsWith('/connect')) {
      const next = queue.shift();
      if (next) return next;
      return json({session});
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
};

const renderPage = async () => {
  const onConnected = vi.fn();
  const notify = vi.fn();
  render(<SSHPage onConnected={onConnected} notify={notify} />);
  await waitFor(() => expect(screen.getAllByText('Mock Lab').length).toBeGreaterThan(0));
  return {onConnected, notify};
};

describe('SSH page', () => {
  it('lists grouped profiles with mock and credential badges', async () => {
    installFetch([]);
    await renderPage();
    expect(screen.getAllByText('Demo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('mock').length).toBeGreaterThan(0);
    expect(screen.getByText(/password · stored/)).toBeInTheDocument();
    expect(screen.getAllByText(/mock target 127\.0\.0\.1:2222/).length).toBeGreaterThan(0);
  });

  it('keeps the port-forwarding surface visible as an explicit TODO', async () => {
    installFetch([]);
    await renderPage();
    expect(screen.getByText(/Local -L \(planned\)/)).toBeDisabled();
    expect(screen.getByText(/Local and remote forwarding are planned/)).toBeInTheDocument();
  });

  it('shows the TOFU dialog on host_key_unknown and connects only after explicit trust', async () => {
    const challenge = json(
      {
        error: {
          code: 'host_key_unknown',
          message: 'host key is not trusted yet',
          details: {fingerprint: 'SHA256:abc123', keyType: 'ssh-ed25519', host: '127.0.0.1', port: 2222, mock: true},
        },
      },
      409,
    );
    const calls = installFetch([challenge, json({session}, 201)]);
    const {onConnected} = await renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', {name: /^Connect$/}));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Unknown host key/);
    expect(dialog).toHaveTextContent('SHA256:abc123');
    // Nothing was accepted yet.
    expect(calls.filter(call => call.url.endsWith('/connect'))[0].body).toEqual({acceptHostKey: undefined, fingerprint: undefined, cols: 0, rows: 0});
    expect(onConnected).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', {name: /Trust and connect/}));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(session));
    const accepted = calls.filter(call => call.url.endsWith('/connect')).at(-1);
    expect(accepted?.body).toMatchObject({acceptHostKey: true, fingerprint: 'SHA256:abc123'});
  });

  it('surfaces a connection failure without pretending to be connected', async () => {
    installFetch([json({error: {code: 'ssh_connect_failed', message: 'dial tcp: connection refused'}}, 502)]);
    const {onConnected, notify} = await renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', {name: /^Connect$/}));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls.some(([message]) => /connection refused/.test(String(message)))).toBe(true);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('opens the profile editor as a hand-drawn dialog with labelled fields', async () => {
    installFetch([]);
    await renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', {name: /New profile/}));
    const dialog = await screen.findByRole('dialog');
    expect(document.querySelector('dialog')).toBeNull();
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Host')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Port')).toBeInTheDocument();
  });
});
