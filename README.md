# Site to API — Cosmic demo 03

Paste a URL and get a clean JSON API of what's on the page: every data `<table>` as an array of
row objects keyed by header, repeated card/list structures as `{text, links, images}` records,
title, meta, OpenGraph, JSON-LD, the headings outline and the links. The endpoint the page uses
is public, so you can call it yourself:

```bash
curl -s 'https://www.skabene.id.lv/demo/scrape/api/extract?url=https%3A%2F%2Fquotes.toscrape.com%2F&pretty=1'
```

Served at **https://www.skabene.id.lv/demo/scrape/**. It is deterministic: no AI, no analytics,
no third-party requests from the browser.

## API

`GET /demo/scrape/api/extract`

| param    | |
|----------|---|
| `url`    | required. The http(s) page to extract. A bare `example.com` is treated as https. |
| `only`   | optional. Comma-separated subset of `title,meta,jsonLd,tables,lists,headings,links`. |
| `pretty` | optional. `1` indents the JSON. |

Success returns `{ ok: true, url, finalUrl, status, redirects, bytes, timing, cached, data }`.
Failure returns `{ ok: false, error: { code, message } }` with a status that means something:
400 for a refused or invalid address, 415 for non-HTML, 413 for over 2 MB, 429 when rate
limited (with `Retry-After`), 502 for upstream errors, 503 when busy and 504 on timeout.
`GET /demo/scrape/api` describes the parameters and limits. `GET /demo/scrape/healthz` returns `ok`.

## The SSRF guard

This is a public server that fetches URLs strangers type, running on a box that also hosts
Postgres, loopback services and a metadata endpoint. `src/server/guard.ts` and
`src/server/fetcher.ts` are the most important code in the repo:

- **Syntax.** Only http and https, only ports 80 and 443, no credentials, no `localhost`,
  `*.internal`, `*.local` or single-label names. The WHATWG URL parser normalises
  `2130706433`, `0177.0.0.1` and `0x7f.1` to `127.0.0.1` *before* the check runs.
- **DNS.** The name is resolved on the server and **every** returned address must be public
  unicast according to ipaddr.js *and* an explicit CIDR blocklist. That covers loopback,
  RFC 1918, link-local and metadata, CGNAT, multicast, reserved, TEST-NETs, ULA, NAT64, 6to4,
  Teredo, and IPv4-mapped IPv6 (unwrapped and re-checked).
- **Pinning.** The socket connects to the vetted IP through a custom `lookup`, so a DNS answer
  that changes after the check (rebinding) is never used. Certificate validation still uses
  the real host name. The peer address is checked again once the socket connects.
- **Redirects.** These are followed by hand, at most 3, and every hop goes back through the full
  check.
- **Limits.** 8 s in total, 2 MB streamed and then aborted (counted *after* decompression, so
  a gzip bomb is caught), `text/html` and `application/xhtml+xml` only, and the honest
  User-Agent `CosmicDemoBot/1.0 (+https://www.skabene.id.lv)`.
- **Abuse.** Each IP gets a token bucket of 10 per minute, keyed on the first `X-Forwarded-For`
  entry. At most 4 fetches run at once, and a 50-entry LRU cache keeps results for 5 minutes.
  Cache hits don't count against the limit. The API accepts only GET, with no body.

## Develop

Needs Node 22 and pnpm 10.

```bash
pnpm install
pnpm build            # typecheck + vite build + server compile (the dev server reads dist/public for static files)
pnpm dev:server       # API on :3103 (tsx watch)
pnpm dev:web          # Vite on :5173 → http://localhost:5173/demo/scrape/
pnpm test             # vitest: guard, fetcher (against a local server), extractor, limits, CSV
```

In dev, Vite proxies `/demo/scrape/api` to `:3103`, and `/theme.css` to the live site so the page
picks up the shell's tokens. The page's own CSS stands on its own when theme.css is missing.

Production locally:

```bash
pnpm build && PORT=3103 node dist/server/index.js   # → http://127.0.0.1:3103/demo/scrape/
```

## Deploy (VPS)

```bash
docker compose up -d --build        # builds cosmic-demo-scrape:latest, runs demo-scrape
```

The container publishes on **`127.0.0.1:3103` only**. Never use a bare `3103:3103`, because
Docker's DNAT bypasses ufw. It runs as `node`, with a read-only root filesystem, a `/tmp` tmpfs,
`no-new-privileges` and a 256 MB memory limit. Caddy must pass the full path through without
stripping the prefix:

```caddy
handle /demo/scrape/* {
    reverse_proxy 127.0.0.1:3103
}
```

Caddy has to put the real client address in `X-Forwarded-For`. That is its default when the
client is not in `trusted_proxies`. The per-IP limit depends on it.

## Layout

```
src/server/guard.ts      SSRF checks: URL syntax, IP classification, DNS vetting
src/server/fetcher.ts    pinned node:http(s) client, manual redirects, caps, decoding
src/server/extract.ts    cheerio → tables (rowspan/colspan), repeated structures, meta, links
src/server/limits.ts     token bucket, concurrency gate, LRU, client IP
src/server/app.ts        routes, static files (pre-compressed in memory), security headers
src/web/                 vanilla TS frontend: main.ts, style.css, csv.ts, dom.ts
```
