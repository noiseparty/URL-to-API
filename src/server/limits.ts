/**
 * In-memory limits. This process is a single container, so memory is the right store: no
 * Redis to run, and a restart forgetting everyone's budget is harmless.
 */
import type { IncomingMessage } from "node:http";

/** Per-key token bucket. `capacity` requests burst, refilled at `perMinute`. */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a token. Returns 0 on success, else seconds until one is available. */
  take(key: string): number {
    const t = this.now();
    const rate = this.perMinute / 60_000; // tokens per ms
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      this.sweep(t);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  /** Drop buckets that have refilled completely; they carry no information. */
  private sweep(t: number) {
    if (this.buckets.size < 5000) return;
    const full = this.capacity / (this.perMinute / 60_000);
    for (const [k, b] of this.buckets) if (t - b.at > full) this.buckets.delete(k);
  }
}

/** Counting semaphore without a queue: over the cap, callers are told to come back. */
export class Concurrency {
  private active = 0;
  constructor(private readonly max: number) {}
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  get inFlight() {
    return this.active;
  }
}

/** Small LRU with TTL, on Map's insertion order. */
export class LruCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, { v, exp: this.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/**
 * The caller's address: the FIRST X-Forwarded-For entry, which Caddy sets to the real
 * remote address (it discards client-supplied values from untrusted peers), else the
 * socket. The container only listens on loopback, so the header cannot arrive any other way.
 */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}
