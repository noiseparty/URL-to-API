import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIp, Concurrency, LruCache, TokenBucket } from "./limits.js";

describe("TokenBucket", () => {
  it("allows a burst, then refuses with a wait, then refills", () => {
    let now = 0;
    const b = new TokenBucket(3, 6, () => now); // one token per 10 s
    expect([b.take("a"), b.take("a"), b.take("a")]).toEqual([0, 0, 0]);
    expect(b.take("a")).toBe(10);
    expect(b.take("b")).toBe(0); // separate key, separate bucket
    now += 10_000;
    expect(b.take("a")).toBe(0);
  });
});

describe("Concurrency", () => {
  it("caps in-flight work and releases idempotently", () => {
    const c = new Concurrency(2);
    const r1 = c.tryAcquire()!;
    c.tryAcquire();
    expect(c.tryAcquire()).toBeNull();
    r1();
    r1();
    expect(c.inFlight).toBe(1);
  });
});

describe("LruCache", () => {
  it("expires entries and evicts the least recently used", () => {
    let now = 0;
    const c = new LruCache<number>(2, 1000, () => now);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    now = 2000;
    expect(c.get("a")).toBeUndefined();
  });
});

describe("clientIp", () => {
  const req = (xff: string | undefined) =>
    ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
  it("takes the first X-Forwarded-For entry, else the socket address", () => {
    expect(clientIp(req("203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
    expect(clientIp(req(undefined))).toBe("127.0.0.1");
  });
});
