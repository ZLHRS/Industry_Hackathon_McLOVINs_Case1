export type LiveState = "offline" | "connecting" | "live" | "reconnecting";

type ServerMessage = { type: "ready" | "refresh"; revision: number } | { type: "heartbeat" };
type Options = {
  token: string;
  onState: (state: LiveState) => void;
  onRefresh: (revision: number) => void;
  onUnauthorized: () => void;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
};

/** Authenticated, one-way real-time connection. Client frames are limited to the initial authentication. */
export class RealtimeConnection {
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof window.setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof window.setTimeout> | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private options: Options) {}

  start() {
    this.stopped = false;
    window.addEventListener("online", this.resume);
    window.addEventListener("offline", this.pause);
    this.connect(false);
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.resume);
    window.removeEventListener("offline", this.pause);
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.options.onState("offline");
  }

  private resume = () => {
    if (!this.stopped && !this.socket) this.connect(true);
  };

  private pause = () => {
    this.clearRetry();
    this.options.onState("offline");
    this.socket?.close();
  };

  private connect(reconnecting: boolean) {
    if (this.stopped || !navigator.onLine) {
      this.options.onState("offline");
      return;
    }
    this.clearRetry();
    const WS = this.options.WebSocketImpl ?? WebSocket;
    this.options.onState(reconnecting ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WS(`${protocol}//${location.host}/api/v1/realtime`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      socket.send(JSON.stringify({ type: "authenticate", token: this.options.token }));
      this.armWatchdog(socket);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.armWatchdog(socket);
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "ready") {
        this.attempt = 0;
        this.options.onState("live");
        this.options.onRefresh(message.revision);
      }
      if (message.type === "refresh") this.options.onRefresh(message.revision);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.clearWatchdog();
      this.socket = null;
      if (event.code === 4401) {
        this.options.onUnauthorized();
        return;
      }
      this.schedule();
    };
    socket.onerror = () => socket.close();
  }

  private armWatchdog(socket: WebSocket) {
    this.clearWatchdog();
    this.watchdogTimer = window.setTimeout(() => {
      if (this.socket === socket && !this.stopped) socket.close();
    }, 35000);
  }

  private schedule() {
    if (this.stopped || !navigator.onLine || this.retryTimer !== null) return;
    const jitter = this.options.random?.() ?? Math.random();
    const delay = Math.min(30000, 800 * 2 ** this.attempt++) + Math.round(jitter * 350);
    this.options.onState("reconnecting");
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect(true);
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer === null) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearWatchdog() {
    if (this.watchdogTimer === null) return;
    window.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private clearTimers() {
    this.clearRetry();
    this.clearWatchdog();
  }
}
