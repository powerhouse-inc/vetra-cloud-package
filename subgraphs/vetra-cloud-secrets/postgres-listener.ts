import { Client, type Notification } from "pg";

type NotifyHandler = (payload: string) => void;

export interface PostgresListenerOptions {
  databaseUrl: string;
  channel: string;
  onNotify: NotifyHandler;
  onReconnect?: () => void;
}

export class PostgresListener {
  private client: Client | null = null;
  private stopped = false;
  private reconnectDelayMs = 1000;
  private readonly maxReconnectDelayMs = 30_000;
  private connected = false;

  constructor(private readonly opts: PostgresListenerOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.connected = false;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectAndListen();
        // Reset backoff after successful connection
        this.reconnectDelayMs = 1000;
        return;
      } catch (err) {
        this.connected = false;
        console.error(
          `[listener] connection error: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, this.reconnectDelayMs));
        this.reconnectDelayMs = Math.min(
          this.reconnectDelayMs * 2,
          this.maxReconnectDelayMs,
        );
      }
    }
  }

  private async connectAndListen(): Promise<void> {
    const client = new Client({ connectionString: this.opts.databaseUrl });
    this.client = client;

    client.on("error", (err) => {
      console.error(`[listener] client error: ${err.message}`);
      this.connected = false;
      this.scheduleReconnect();
    });

    client.on("end", () => {
      this.connected = false;
      if (!this.stopped) this.scheduleReconnect();
    });

    client.on("notification", (msg: Notification) => {
      if (msg.channel !== this.opts.channel) return;
      const payload = msg.payload ?? "";
      try {
        this.opts.onNotify(payload);
      } catch (err) {
        console.error(
          `[listener] onNotify handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    await client.connect();
    await client.query(`LISTEN ${escapeIdent(this.opts.channel)}`);
    this.connected = true;
    console.info(`[listener] listening on channel '${this.opts.channel}'`);
    this.opts.onReconnect?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => {
      if (!this.stopped && !this.connected) void this.connectLoop();
    }, this.reconnectDelayMs);
  }
}

function escapeIdent(s: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`invalid LISTEN channel name: ${s}`);
  }
  return s;
}
