/**
 * The fetcher against a real local HTTP server. The URLs use invented public-looking names
 * ("site.example") that a fake resolver maps to 127.0.0.1, and `allowAddress` admits
 * loopback for the test only — so every other rule (scheme, port, redirect re-vetting,
 * pinning, caps) runs exactly as in production.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPage, type FetchOptions } from "./fetcher.js";
import type { Resolver } from "./guard.js";

let server: Server;
let port = 0;
let lastUserAgent = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUserAgent = String(req.headers["user-agent"]);
    const u = new URL(req.url ?? "/", "http://x");
    switch (u.pathname) {
      case "/ok":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<html><head><title>Hi</title></head><body><p>ok</p></body></html>");
      case "/gzip":
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        return res.end(gzipSync("<title>Zipped</title>"));
      case "/latin1":
        res.writeHead(200, { "Content-Type": "text/html; charset=iso-8859-1" });
        return res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9])); // "<p>café"
      case "/json":
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{}");
      case "/big":
        res.writeHead(200, { "Content-Type": "text/html" }); // no length: must be counted while streaming
        for (let i = 0; i < 64; i++) res.write("x".repeat(1024));
        return res.end();
      case "/bomb": {
        // 64 KB on the wire that inflates to 4 MB: the cap must apply after decompression.
        res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
        return res.end(gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x61)));
      }
      case "/slow":
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write("<p>");
        return; // never ends
      case "/redirect":
        res.writeHead(302, { Location: u.searchParams.get("to") ?? "/ok" });
        return res.end();
      case "/loop":
        res.writeHead(301, { Location: "/loop" });
        return res.end();
      case "/404":
        res.writeHead(404, { "Content-Type": "text/html" });
        return res.end("gone");
      default:
        res.writeHead(500);
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const dns: Resolver = async (host) => {
  if (host === "site.example") return [{ address: "127.0.0.1", family: 4 }];
  if (host === "intranet.example") return [{ address: "192.168.1.10", family: 4 }];
  throw new Error("ENOTFOUND");
};
const opts = (extra: FetchOptions = {}): FetchOptions => ({
  resolver: dns,
  allowAddress: (a) => a === "127.0.0.1",
  connectPort: port,
  ...extra,
});

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as Error & { code: string };
  }
  throw new Error("expected a failure");
};

describe("fetchPage", () => {
  it("fetches HTML with an honest User-Agent, pinned to the vetted IP", async () => {
    // "site.example" does not exist in real DNS; success proves the socket used the pinned address.
    const page = await fetchPage("http://site.example/ok", opts());
    expect(page.status).toBe(200);
    expect(page.html).toContain("<title>Hi</title>");
    expect(page.remoteAddress).toBe("127.0.0.1");
    expect(lastUserAgent).toBe("RepoDemoBot/1.0 (+https://www.repo.lv)");
  });

  it("decompresses gzip and decodes the declared charset", async () => {
    expect((await fetchPage("http://site.example/gzip", opts())).html).toBe("<title>Zipped</title>");
    expect((await fetchPage("http://site.example/latin1", opts())).html).toBe("<p>café");
  });

  it("refuses non-HTML content types", async () => {
    expect((await fail(fetchPage("http://site.example/json", opts()))).code).toBe("not_html");
  });

  it("aborts a body over the cap while streaming", async () => {
    const err = await fail(fetchPage("http://site.example/big", opts({ limits: { maxBytes: 16 * 1024 } })));
    expect(err.code).toBe("too_large");
  });

  it("applies the cap to decompressed bytes (gzip bomb)", async () => {
    const err = await fail(fetchPage("http://site.example/bomb", opts({ limits: { maxBytes: 1024 * 1024 } })));
    expect(err.code).toBe("too_large");
  });

  it("times out a server that never finishes", async () => {
    const err = await fail(fetchPage("http://site.example/slow", opts({ limits: { timeoutMs: 300 } })));
    expect(err.code).toBe("timeout");
  });

  it("times out a DNS lookup that never answers", async () => {
    const hang: Resolver = () => new Promise(() => {});
    const started = Date.now();
    const err = await fail(fetchPage("http://site.example/ok", opts({ resolver: hang, limits: { timeoutMs: 300 } })));
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("follows a same-site redirect and records it", async () => {
    const page = await fetchPage("http://site.example/redirect?to=/ok", opts());
    expect(page.finalUrl).toBe("http://site.example/ok");
    expect(page.redirects).toHaveLength(1);
  });

  it("re-vets every redirect hop: a redirect to a private literal is blocked", async () => {
    const err = await fail(fetchPage("http://site.example/redirect?to=http://10.0.0.5/", opts()));
    expect(err.code).toBe("private_address");
    expect(err.message).toMatch(/redirected/);
  });

  it("re-vets every redirect hop: a redirect to a name resolving privately is blocked", async () => {
    const err = await fail(fetchPage("http://site.example/redirect?to=http://intranet.example/", opts()));
    expect(err.code).toBe("private_address");
  });

  it("re-vets every redirect hop: a redirect to loopback via hex is blocked", async () => {
    const err = await fail(fetchPage("http://site.example/redirect?to=http://0x7f.1/", opts()));
    expect(err.code).toBe("private_address");
  });

  it("re-vets every redirect hop: a redirect to another scheme or port is blocked", async () => {
    expect((await fail(fetchPage("http://site.example/redirect?to=file:///etc/passwd", opts()))).code).toBe("bad_scheme");
    expect((await fail(fetchPage("http://site.example/redirect?to=http://site.example:8080/", opts()))).code).toBe("bad_port");
  });

  it("stops after 3 redirects", async () => {
    expect((await fail(fetchPage("http://site.example/loop", opts()))).code).toBe("too_many_redirects");
  });

  it("reports an upstream error status", async () => {
    expect((await fail(fetchPage("http://site.example/404", opts()))).code).toBe("upstream_status");
  });

  it("in production mode, refuses the same loopback server outright", async () => {
    // No allowAddress override: the real guard is in charge.
    const err = await fail(fetchPage("http://site.example/ok", { resolver: dns, connectPort: port }));
    expect(err.code).toBe("private_address");
  });
});
