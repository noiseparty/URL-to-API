/**
 * The HTTP surface: static frontend + one API route, all under BASE. Plain node:http —
 * there are four routes, a framework would be most of the attack surface.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { brotliCompressSync, gzipSync, constants as zc } from "node:zlib";
import { checkUrl, GuardError } from "./guard.js";
import { FetchError, fetchPage, type FetchOptions } from "./fetcher.js";
import { extract, type Extracted } from "./extract.js";
import { clientIp, Concurrency, LruCache, TokenBucket } from "./limits.js";

export const BASE = "/demo/scrape";

const MAX_URL = 4096;
const SECTIONS = ["title", "meta", "jsonLd", "tables", "lists", "headings", "links"] as const;

export interface ExtractResult {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  redirects: Array<{ status: number; from: string; to: string }>;
  bytes: { wire: number; html: number };
  timing: { fetchMs: number; parseMs: number; totalMs: number };
  cached: boolean;
  data: Partial<Extracted>;
}

export interface AppOptions {
  publicDir: string;
  perMinute?: number;
  burst?: number;
  maxConcurrent?: number;
  fetchOptions?: FetchOptions;
}

type Asset = { body: Buffer; gz: Buffer | null; br: Buffer | null; type: string; immutable: boolean };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Loads the built frontend into memory once, pre-compressed. It is a few hundred KB. */
function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = "/" + relative(dir, full).split(sep).join("/");
        const body = readFileSync(full);
        const type = TYPES[extname(name)] ?? "application/octet-stream";
        const compressible = /text|javascript|json|svg|manifest/.test(type) && body.length > 512;
        assets.set(rel, {
          body,
          type,
          gz: compressible ? gzipSync(body, { level: 9 }) : null,
          br: compressible ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : null,
          immutable: rel.startsWith("/assets/"),
        });
      }
    }
  };
  walk(dir);
  return assets;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function baseHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown, pretty = false, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body, null, pretty ? 2 : undefined);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...extra,
  });
  res.end(text + (pretty ? "\n" : ""));
}

function sendError(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}, pretty = false) {
  sendJson(res, status, { ok: false, error: { code, message } }, pretty, extra);
}

export function createApp(opts: AppOptions) {
  const assets = loadAssets(opts.publicDir);
  const bucket = new TokenBucket(opts.burst ?? 10, opts.perMinute ?? 10);
  const gate = new Concurrency(opts.maxConcurrent ?? 4);
  const cache = new LruCache<Omit<ExtractResult, "cached" | "timing"> & { timing: ExtractResult["timing"] }>(50, 5 * 60_000);

  function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const asset = assets.get(path);
    if (!asset) return false;
    const accept = String(req.headers["accept-encoding"] ?? "");
    let body = asset.body;
    let enc: string | null = null;
    if (asset.br && /\bbr\b/.test(accept)) [body, enc] = [asset.br, "br"];
    else if (asset.gz && /\bgzip\b/.test(accept)) [body, enc] = [asset.gz, "gzip"];
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Content-Length": body.length,
      "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
      ...(enc ? { "Content-Encoding": enc } : {}),
      ...(asset.type.startsWith("text/html") ? { "Content-Security-Policy": CSP } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  async function handleExtract(req: IncomingMessage, res: ServerResponse, params: URLSearchParams) {
    const started = performance.now();
    const pretty = params.has("pretty") && params.get("pretty") !== "0";
    const input = params.get("url");
    if (!input) {
      return sendError(res, 400, "missing_url", "Add a ?url= parameter with the page to extract.", {}, pretty);
    }

    let only: Set<string> | null = null;
    if (params.get("only")) {
      only = new Set(params.get("only")!.split(",").map((s) => s.trim()));
      const unknown = [...only].filter((s) => !(SECTIONS as readonly string[]).includes(s));
      if (unknown.length) {
        return sendError(res, 400, "bad_only", `Unknown section "${unknown[0]}". Use any of: ${SECTIONS.join(", ")}.`, {}, pretty);
      }
    }
    const shape = (r: Omit<ExtractResult, "cached">, cached: boolean): ExtractResult => {
      const data = only
        ? (Object.fromEntries(Object.entries(r.data).filter(([k]) => only!.has(k) || k === "counts")) as Partial<Extracted>)
        : r.data;
      return { ...r, cached, data, timing: { ...r.timing, totalMs: Math.round(performance.now() - started) } };
    };

    let key: string;
    try {
      key = checkUrl(input).url.toString();
    } catch (err) {
      if (err instanceof GuardError) return sendError(res, 400, err.code, err.message, {}, pretty);
      throw err;
    }

    const hit = cache.get(key);
    if (hit) return sendJson(res, 200, shape(hit, true), pretty);

    const wait = bucket.take(clientIp(req));
    if (wait > 0) {
      return sendError(
        res,
        429,
        "rate_limited",
        `Easy there — this demo allows ${opts.perMinute ?? 10} fresh extractions a minute per visitor. Try again in ${wait} s (recent pages are cached and don't count).`,
        { "Retry-After": String(wait) },
        pretty,
      );
    }
    const release = gate.tryAcquire();
    if (!release) {
      return sendError(res, 503, "busy", "The extractor is busy with other visitors' pages. Try again in a few seconds.", { "Retry-After": "3" }, pretty);
    }

    try {
      const t0 = performance.now();
      const page = await fetchPage(input, opts.fetchOptions);
      const t1 = performance.now();
      const data = extract(page.html, page.finalUrl);
      const t2 = performance.now();
      const result: Omit<ExtractResult, "cached"> = {
        ok: true,
        url: key,
        finalUrl: page.finalUrl,
        status: page.status,
        contentType: page.contentType,
        fetchedAt: new Date().toISOString(),
        redirects: page.redirects,
        bytes: { wire: page.bytesOnWire, html: page.bytes },
        timing: { fetchMs: Math.round(t1 - t0), parseMs: Math.round(t2 - t1), totalMs: 0 },
        data,
      };
      cache.set(key, result);
      sendJson(res, 200, shape(result, false), pretty);
    } catch (err) {
      if (err instanceof GuardError) return sendError(res, 400, err.code, err.message, {}, pretty);
      if (err instanceof FetchError) return sendError(res, err.httpStatus, err.code, err.message, {}, pretty);
      console.error("extract failed", input, err);
      sendError(res, 500, "internal", "Something went wrong on our side while reading that page.", {}, pretty);
    } finally {
      release();
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    baseHeaders(res);
    try {
      const rawUrl = req.url ?? "/";
      if (rawUrl.length > MAX_URL) return sendError(res, 414, "uri_too_long", "That request address is too long.");
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendError(res, 405, "method_not_allowed", "Only GET is supported.", { Allow: "GET, HEAD" });
      }
      // GET needs no body. Refuse one outright rather than read it.
      const len = Number(req.headers["content-length"] ?? 0);
      if (len > 0 || req.headers["transfer-encoding"]) {
        return sendError(res, 413, "body_not_allowed", "This endpoint doesn't accept a request body.", { Connection: "close" });
      }

      const u = new URL(rawUrl, "http://local");
      const path = u.pathname;

      if (path === "/" || path === BASE) {
        res.writeHead(302, { Location: `${BASE}/` });
        return res.end();
      }
      if (path === `${BASE}/healthz`) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end("ok");
      }
      if (path === `${BASE}/api/extract`) return await handleExtract(req, res, u.searchParams);
      if (path === `${BASE}/api` || path === `${BASE}/api/`) {
        return sendJson(res, 200, {
          endpoint: `${BASE}/api/extract`,
          params: {
            url: "required — the http(s) page to extract",
            only: `optional — comma-separated subset of: ${SECTIONS.join(", ")}`,
            pretty: "optional — 1 to indent the JSON",
          },
          limits: { perMinutePerIp: opts.perMinute ?? 10, timeoutSeconds: 8, maxPageBytes: 2 * 1024 * 1024, maxRedirects: 3, cacheSeconds: 300 },
        }, true);
      }
      if (path.startsWith(`${BASE}/`)) {
        const rel = path.slice(BASE.length);
        if (rel === "/" && serveAsset(req, res, "/index.html")) return;
        if (!rel.includes("..") && serveAsset(req, res, rel)) return;
      }
      if (path.startsWith(`${BASE}/api/`)) return sendError(res, 404, "not_found", "No such API route.");
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      console.error("request failed", err);
      if (!res.headersSent) sendError(res, 500, "internal", "Something went wrong on our side.");
      else res.end();
    }
  };
}
