/**
 * Transport for one terminal tab.
 *
 * The browser never spawns processes. This module only moves bytes between an
 * xterm.js instance and terminald's WebSocket, and it survives reconnects by
 * resuming from the byte offset the daemon reports, so output produced while
 * the socket was down is replayed instead of lost.
 */

export type LinkState = 'connecting' | 'open' | 'closed' | 'error';

export interface SessionSocketHandlers {
  onOutput: (chunk: Uint8Array) => void;
  onState: (state: LinkState, detail?: string) => void;
  onExit?: (code: number | null) => void;
}

interface ControlMessage {
  type: string;
  state?: string;
  data?: string;
  error?: string;
}

const encoder = new TextEncoder();

export class SessionSocket {
  private socket: WebSocket | null = null;
  private offset = 0;
  private disposed = false;
  private retryTimer: number | undefined;
  private attempts = 0;
  private pendingInput: ArrayBuffer[] = [];
  private size = {cols: 80, rows: 24};

  constructor(
    private readonly sessionId: string,
    private readonly buildUrl: (id: string, offset: number) => string,
    private readonly handlers: SessionSocketHandlers,
  ) {}

  connect() {
    if (this.disposed) return;
    this.handlers.onState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.buildUrl(this.sessionId, this.offset));
    } catch (error) {
      this.handlers.onState('error', error instanceof Error ? error.message : 'socket creation failed');
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.handlers.onState('open');
      this.resize(this.size.cols, this.size.rows);
      for (const chunk of this.pendingInput.splice(0)) socket.send(chunk);
    };
    socket.onmessage = event => {
      if (typeof event.data === 'string') {
        this.handleControl(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const chunk = new Uint8Array(event.data);
      this.offset += chunk.byteLength;
      if (chunk.byteLength > 0) this.handlers.onOutput(chunk);
    };
    socket.onerror = () => {
      // `close` always follows; report there to avoid double toasts.
    };
    socket.onclose = event => {
      this.socket = null;
      if (this.disposed) return;
      if (event.code === 1000) {
        this.handlers.onState('closed', event.reason || 'session ended');
        return;
      }
      this.handlers.onState('closed', event.reason || 'connection lost');
      this.scheduleReconnect();
    };
  }

  private handleControl(raw: string) {
    let message: ControlMessage;
    try {
      message = JSON.parse(raw) as ControlMessage;
    } catch {
      return;
    }
    if (message.type === 'exit') {
      const parsed = /code (\d+)/.exec(message.data ?? '');
      this.handlers.onExit?.(parsed ? Number(parsed[1]) : null);
      return;
    }
    if (message.type === 'error' && message.error) {
      this.handlers.onState('error', message.error);
    }
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    this.attempts += 1;
    if (this.attempts > 6) return;
    const delay = Math.min(4000, 250 * 2 ** (this.attempts - 1));
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  send(data: string | Uint8Array) {
    const chunk = (typeof data === 'string' ? encoder.encode(data) : data) as Uint8Array<ArrayBuffer>;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
      return;
    }
    if (this.pendingInput.length < 64) {
      this.pendingInput.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    }
  }

  resize(cols: number, rows: number) {
    this.size = {cols, rows};
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({type: 'resize', cols, rows}));
    }
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    this.socket?.close(1000, 'tab closed');
    this.socket = null;
    this.pendingInput = [];
  }
}

/** Keeps the byte offset stable across React re-renders for one tab. */
export const createSocket = (
  id: string,
  buildUrl: (id: string, offset: number) => string,
  handlers: SessionSocketHandlers,
): SessionSocket => new SessionSocket(id, buildUrl, handlers);
