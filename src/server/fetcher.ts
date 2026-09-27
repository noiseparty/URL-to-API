/**
 * The only code in the app that opens an outbound connection. It uses node:http(s)
 * directly rather than fetch() because it needs two things fetch does not expose:
 *
 *  - a custom `lookup`, so the socket connects to the exact IP the guard vetted, whatever
 *    DNS says a millisecond later (DNS rebinding), and
 *  - the socket itself, so the remote address can be checked once more at connect time.
 *
 * Redirects are followed by hand, and every hop goes back through the guard.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction, Socket } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { checkUrl, GuardError, isPublicAddress, resolveHost, systemResolver, type Resolver } from "./guard.js";

export const USER_AGENT = "CosmicDemoBot/1.0 (+https://www.skabene.id.lv)";

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  timeoutMs: 8000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
};

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** Decoded HTML. */
  html: string;
  /** Bytes received on the wire (before decompression). */
  bytesOnWire: number;
  /** Bytes of HTML after decompression. */
  bytes: number;
  redirects: Array<{ status: number; from: string; to: string }>;
  remoteAddress: string;
}

export class FetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export interface FetchOptions {
  limits?: Partial<FetchLimits>;
  resolver?: Resolver;
  /** Test seam: lets the unit tests talk to a local server while keeping every other check. */
  allowAddress?: (address: string) => boolean;
  /** Test seam: open the socket on this port while the URL keeps a standard one. */
  connectPort?: number;
}

export async function fetchPage(input: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const allow = opts.allowAddress ?? isPublicAddress;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const redirects: FetchedPage["redirects"] = [];

  try {
    let current = input;
    for (let hop = 0; ; hop++) {
      let target: Awaited<ReturnType<typeof vetWith>>;
      try {
        target = await vetWith(current, opts.resolver, allow);
      } catch (err) {
        if (hop > 0 && err instanceof GuardError) {
          throw new GuardError(err.code, `The page redirected to ${current.slice(0, 200)}, which is blocked. ${err.message}`);
        }
        throw err;
      }
      const res = await request(target, controller.signal, allow, opts.connectPort);

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        res.body.destroy();
        if (hop >= limits.maxRedirects) {
          throw new FetchError("too_many_redirects", `The page redirected more than ${limits.maxRedirects} times.`);
        }
        let next: string;
        try {
          next = new URL(res.headers.location, target.url).toString();
        } catch {
          throw new FetchError("bad_redirect", "The page redirected to an invalid address.");
        }
        redirects.push({ status: res.status, from: target.url.toString(), to: next });
        current = next; // re-vetted from scratch at the top of the loop
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        res.body.destroy();
        throw new FetchError("upstream_status", `The site answered with HTTP ${res.status}.`, 502);
      }

      const contentType = String(res.headers["content-type"] ?? "");
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      if (mime && !HTML_TYPES.has(mime)) {
        res.body.destroy();
        throw new FetchError(
          "not_html",
          `That address returns ${mime}, not a web page. Only HTML pages can be extracted.`,
          415,
        );
      }

      const { buffer, wire } = await readCapped(res, limits.maxBytes, controller.signal);
      const html = decode(buffer, contentType);
      return {
        requestedUrl: input,
        finalUrl: target.url.toString(),
        status: res.status,
        contentType: contentType || "text/html",
        html,
        bytesOnWire: wire,
        bytes: buffer.length,
        redirects,
        remoteAddress: res.remoteAddress,
      };
    }
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof GuardError) && !(isCapError(err))) {
      throw new FetchError("timeout", `The site took longer than ${limits.timeoutMs / 1000} seconds to answer.`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isCapError(err: unknown) {
  return err instanceof FetchError && err.code === "too_large";
}

async function vetWith(input: string, resolver: Resolver | undefined, allow: (a: string) => boolean) {
  const checked = checkUrl(input);
  if (allow === isPublicAddress) return { ...checked, pinned: await resolveHost(checked, resolver) };
  // Test path only: every syntax check above still applied; the address check is the test's.
  const records = await (resolver ?? systemResolver)(checked.host);
  for (const r of records) {
    if (!allow(r.address)) throw new GuardError("private_address", `${checked.host} resolves to a blocked address.`);
  }
  return { ...checked, pinned: records[0]! };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  remoteAddress: string;
}

function request(
  target: Awaited<ReturnType<typeof vetWith>>,
  signal: AbortSignal,
  allow: (a: string) => boolean,
  connectPort?: number,
): Promise<RawResponse> {
  const { url, pinned } = target;
  const isHttps = url.protocol === "https:";

  // Pin: whatever name Node asks about, answer with the vetted address. Node calls this
  // with {all: true} when autoSelectFamily is on, and expects an array back in that case.
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: pinned.address, family: pinned.family },
      ]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: connectPort ?? (url.port ? Number(url.port) : isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      lookup,
      ...({ autoSelectFamily: false } as object), // passed through to net.connect; one pinned address, no racing
      agent: false, // no pooled sockets: every connection is freshly pinned and checked
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en;q=0.9,*;q=0.5",
      },
      // TLS: SNI and certificate checks use the real host name (the default for
      // `hostname`), so pinning the IP does not weaken certificate validation.
    };
    const onResponse = (res: http.IncomingMessage) => {
      const remote = res.socket?.remoteAddress ?? "";
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, remoteAddress: remote });
    };
    const req = isHttps ? https.request(options, onResponse) : http.request(options, onResponse);

    // Layer 3: the socket's actual peer must be the vetted, public address.
    req.on("socket", (socket: Socket) => {
      const check = () => {
        const remote = socket.remoteAddress ?? "";
        if (!allow(remote)) {
          req.destroy(new GuardError("private_address", "The connection landed on a private address and was dropped."));
        }
      };
      if (socket.remoteAddress) check();
      else socket.once("connect", check);
    });

    req.on("error", (err) => {
      if (err instanceof GuardError) return reject(err);
      if (signal.aborted) return reject(err);
      const code = (err as NodeJS.ErrnoException).code ?? "";
      reject(new FetchError("connect_failed", connectMessage(code, url.hostname)));
    });
    req.end();
  });
}

function connectMessage(code: string, host: string): string {
  switch (code) {
    case "ECONNREFUSED":
      return `${host} refused the connection.`;
    case "ECONNRESET":
      return `${host} dropped the connection.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Couldn't find a server called ${host}.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `${host} has an invalid HTTPS certificate.`;
    default:
      return `Couldn't connect to ${host}${code ? ` (${code})` : ""}.`;
  }
}

/** Streams the body, decompressing on the fly, and aborts the moment either count passes the cap. */
function readCapped(res: RawResponse, maxBytes: number, signal: AbortSignal): Promise<{ buffer: Buffer; wire: number }> {
  const declared = Number(res.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body.destroy();
    return Promise.reject(tooLarge(maxBytes));
  }

  const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  let stream: Readable = res.body;
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.body.pipe(createGunzip());
  else if (encoding === "deflate") stream = res.body.pipe(createInflate());
  else if (encoding === "br") stream = res.body.pipe(createBrotliDecompress());

  let wire = 0;
  res.body.on("data", (c: Buffer) => {
    wire += c.length;
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      res.body.destroy();
      if (stream !== res.body) stream.destroy();
      reject(err);
    };
    signal.addEventListener("abort", () => fail(new FetchError("timeout", "timeout", 504)), { once: true });
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes || wire > maxBytes) return fail(tooLarge(maxBytes));
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve({ buffer: Buffer.concat(chunks), wire });
    });
    stream.on("error", () => fail(new FetchError("bad_body", "The page's content couldn't be decoded.")));
    res.body.on("error", (e) => fail(signal.aborted ? new FetchError("timeout", "timeout", 504) : e));
  });
}

function tooLarge(maxBytes: number) {
  return new FetchError("too_large", `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, the limit for this demo.`, 413);
}

/** Charset from the header, else a <meta charset> in the first 2 KB, else UTF-8. */
export function decode(buffer: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buffer.subarray(0, 2048).toString("latin1");
    charset =
      /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head)?.[1] ?? undefined;
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}
