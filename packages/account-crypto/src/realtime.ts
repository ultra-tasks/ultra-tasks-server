import type { SyncClient } from './sync-client';

export interface RealtimeSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}
export interface RealtimeOptions {
  socket: (ticket: string) => RealtimeSocket;
  updated: (scopeId: string) => void;
  failed?: (scopeId: string, error: unknown) => void;
  revoked?: (scopeId: string) => void;
  status?: (connected: boolean) => void;
  batchMs?: number;
  maximumWaitMs?: number;
  fallbackMs?: number;
  now?: () => number;
}
interface Pending {
  first: number;
  due: number;
  retries: number;
}
export const createRealtimeSocket = (url: string): RealtimeSocket => {
  const socket = new WebSocket(url);
  const adapter: RealtimeSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: (code, reason) => socket.close(code, reason),
  };
  socket.onopen = (event) => adapter.onopen?.(event);
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onclose = (event) => adapter.onclose?.({ code: event.code });
  socket.onerror = (event) => adapter.onerror?.(event);
  return adapter;
};

/** Shared scopes only. Personal captures/uploads stay on their independent schedule. */
export class RealtimeSync {
  private readonly pending = new Map<string, Pending>();
  private readonly scopes = new Set<string>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private fallback?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private socket?: RealtimeSocket;
  private unsubscribe?: () => void;
  private readonly jobs = new Map<string, Promise<void>>();
  private revocations: Promise<void> = Promise.resolve();
  private active = false;
  private epoch = 0;
  private attempts = 0;
  private connected = false;
  constructor(
    readonly client: SyncClient,
    private readonly options: RealtimeOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.client.subscribeLocal((scopeId) => this.changed(scopeId));
    this.updateScopes();
    this.fallback = setInterval(() => {
      for (const scope of this.scopes) this.changed(scope, true);
    }, this.options.fallbackMs ?? 5000);
  }
  updateScopes(): void {
    if (!this.active) return;
    const current = Object.values(this.client.state.scopes)
      .filter((s) => s.info.kind === 'project' && !s.revoked)
      .map((s) => s.info.id);
    const same =
      current.length === this.scopes.size && current.every((id) => this.scopes.has(id));
    if (same) return;
    this.scopes.clear();
    for (const id of current) {
      this.scopes.add(id);
      this.changed(id, true);
    }
    for (const id of this.pending.keys())
      if (!this.scopes.has(id)) this.pending.delete(id);
    this.disconnect();
    if (current.length) void this.connect();
  }
  resume(): void {
    if (!this.active) return;
    for (const scope of this.scopes) this.changed(scope, true);
    this.disconnect();
    if (this.scopes.size) void this.connect();
  }
  changed(scopeId: string, immediate = false): void {
    if (!this.active || !this.scopes.has(scopeId)) return;
    const now = this.now();
    const old = this.pending.get(scopeId);
    const first = old?.first ?? now;
    const due = immediate
      ? now
      : Math.min(
          now + (this.options.batchMs ?? 150),
          first + (this.options.maximumWaitMs ?? 1000),
        );
    this.pending.set(scopeId, { first, due, retries: old?.retries ?? 0 });
    this.arm();
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active || this.jobs.size >= 4) return;
    const waiting = [...this.pending].filter(([id]) => !this.jobs.has(id));
    if (!waiting.length) return;
    const due = Math.min(...waiting.map(([, pending]) => pending.due));
    this.timer = setTimeout(() => this.drain(), Math.max(0, due - this.now()));
  }
  private drain(): void {
    // A slow project occupies one slot, never the entire account scheduler.
    for (const [id, pending] of [...this.pending]) {
      if (!this.active || this.jobs.size >= 4) break;
      if (this.jobs.has(id) || pending.due > this.now()) continue;
      this.pending.delete(id);
      const job = this.runScope(id, pending).finally(() => {
        this.jobs.delete(id);
        this.arm();
      });
      this.jobs.set(id, job);
    }
    this.arm();
  }
  private async runScope(id: string, pending: Pending): Promise<void> {
    try {
      await this.client.syncScope(id);
      this.options.updated(id);
    } catch (error) {
      if ((error as { status?: number }).status === 404) this.revoke(id);
      else if (this.active) {
        const retries = pending.retries + 1;
        const backoff = 2 ** Math.min(retries, 6);
        if (!this.pending.has(id))
          this.pending.set(id, {
            first: this.now(),
            due: this.now() + Math.min(10000, 250 * backoff),
            retries,
          });
        this.options.failed?.(id, error);
      }
    }
  }
  private async connect(): Promise<void> {
    if (!this.active || !this.scopes.size) return;
    const epoch = ++this.epoch;
    try {
      const { ticket } = await this.client.account.request<{ ticket: string }>(
        '/sync/socket-ticket',
        { scopes: [...this.scopes] },
      );
      if (!this.active || epoch !== this.epoch) return;
      const socket = this.options.socket(ticket);
      this.socket = socket;
      socket.onopen = () => {
        if (epoch === this.epoch) {
          this.connected = true;
          this.attempts = 0;
          this.options.status?.(true);
        }
      };
      socket.onmessage = (event) => {
        if (epoch !== this.epoch || typeof event.data !== 'string') return;
        try {
          const value = JSON.parse(event.data) as {
            type: string;
            scopeId?: string;
            scopes?: { scopeId: string }[];
          };
          if (
            value.type === 'scope-revoked' &&
            value.scopeId &&
            this.scopes.has(value.scopeId)
          ) {
            this.revoke(value.scopeId);
          } else if (value.type === 'ready' || value.type === 'scopes-changed') {
            for (const scope of value.scopes ?? []) this.changed(scope.scopeId, true);
          }
        } catch {
          socket.close(1002, 'Invalid notification');
        }
      };
      socket.onclose = (event) => {
        if (epoch !== this.epoch) return;
        this.connected = false;
        this.options.status?.(false);
        if (event.code === 4001)
          this.options.failed?.('', new Error('Realtime session expired or revoked'));
        this.scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (epoch === this.epoch) {
        this.options.failed?.('', error);
        this.scheduleReconnect();
      }
    }
  }
  private scheduleReconnect(): void {
    if (!this.active || !this.scopes.size) return;
    if (this.reconnect) clearTimeout(this.reconnect);
    const backoff = 2 ** Math.min(this.attempts++, 7);
    this.reconnect = setTimeout(
      () => {
        void this.connect();
      },
      Math.min(30000, 250 * backoff),
    );
  }
  private revoke(id: string): void {
    const scope = this.client.state.scopes[id];
    if (scope) scope.revoked = true;
    this.scopes.delete(id);
    this.pending.delete(id);
    if (!this.scopes.size) this.disconnect();
    this.revocations = this.revocations
      .then(() => this.client.markRevoked(id))
      .then(() => {
        this.options.revoked?.(id);
      })
      .catch((error) => {
        this.options.failed?.(id, error);
      });
  }
  private disconnect(): void {
    this.epoch++;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close(1000, 'Subscriptions changed');
    this.socket = undefined;
    this.connected = false;
    this.options.status?.(false);
  }
  async stop(): Promise<void> {
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback) clearInterval(this.fallback);
    this.disconnect();
    this.pending.clear();
    this.scopes.clear();
    await Promise.all(this.jobs.values());
    await this.revocations;
  }
  get isConnected(): boolean {
    return this.connected;
  }
}
