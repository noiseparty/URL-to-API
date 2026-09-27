import "@fontsource/anton/latin-400.css";
import "@fontsource/barlow-condensed/latin-500.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "./style.css";

import { copyText, download, extLink, formatBytes, h } from "./dom";
import { listToCsv, toCsv } from "./csv";
import { highlightJson } from "./json-view";
import type { ApiError, ExtractResult, ListOut, TableOut } from "./types";

const BASE = import.meta.env.BASE_URL; // "/"
const API = `${BASE}api/extract`;

const SAMPLES = [
  { label: "Wikipedia · largest cities", hint: "a rowspan-heavy table", url: "https://en.wikipedia.org/wiki/List_of_largest_cities" },
  { label: "Hacker News", hint: "30 ranked stories", url: "https://news.ycombinator.com/" },
  { label: "Books to Scrape", hint: "product cards + images", url: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html" },
  { label: "Hockey stats", hint: "a plain data table", url: "https://www.scrapethissite.com/pages/forms/" },
  { label: "Quotes to Scrape", hint: "repeated quote blocks", url: "https://quotes.toscrape.com/" },
];

const ATTACKS = [
  { label: "169.254.169.254", hint: "cloud metadata", url: "http://169.254.169.254/latest/meta-data/" },
  { label: "localtest.me", hint: "DNS that points home", url: "http://localtest.me/" },
  { label: "0x7f.1", hint: "hex loopback", url: "http://0x7f.1/" },
  { label: "[::ffff:127.0.0.1]", hint: "IPv4-mapped IPv6", url: "http://[::ffff:127.0.0.1]/" },
  { label: ":8080", hint: "non-web port", url: "http://example.com:8080/" },
  { label: "file://", hint: "local files", url: "file:///etc/passwd" },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const input = $<HTMLInputElement>("url");
const go = $<HTMLButtonElement>("go");
const results = $<HTMLElement>("results");
const endpointEl = $<HTMLElement>("endpoint");
const curlEl = $<HTMLElement>("curl");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------- endpoint box ----

function endpointFor(url: string): string {
  const q = url.trim() || "https://example.com/";
  // encodeURIComponent leaves ' alone, which would end the shell quote in the curl line.
  return `${location.origin}${API}?url=${encodeURIComponent(q).replace(/'/g, "%27")}`;
}

function renderEndpoint() {
  const ep = endpointFor(input.value);
  endpointEl.textContent = ep;
  curlEl.textContent = `curl -s '${ep}&pretty=1'`;
}

// --------------------------------------------------------------------- chips ----

function chip(s: { label: string; hint: string; url: string }, kind: "sample" | "attack") {
  return h(
    "button",
    {
      type: "button",
      class: `chip chip-${kind}`,
      title: s.url,
      "aria-label": `${kind === "attack" ? "Try blocked address" : "Try sample"}: ${s.label}, ${s.hint}`,
      onclick: () => {
        input.value = s.url;
        renderEndpoint();
        void run(s.url);
      },
    },
    h("span", { class: "chip-t" }, s.label),
    h("span", { class: "chip-h" }, s.hint),
  );
}
$("samples").append(...SAMPLES.map((s) => chip(s, "sample")));
$("attacks").append(...ATTACKS.map((s) => chip(s, "attack")));

// ------------------------------------------------------------------ states ----

function setBusy(busy: boolean) {
  results.setAttribute("aria-busy", String(busy));
  go.disabled = busy;
  go.classList.toggle("is-busy", busy);
}

function renderEmpty() {
  results.replaceChildren(
    h(
      "div",
      { class: "state state-empty" },
      h("p", { class: "label state-k" }, "Nothing extracted yet"),
      h("p", { class: "state-msg" }, "Pick a sample above, or paste any public page. Tables, repeated lists and metadata will show up here — and the same JSON is at the endpoint."),
    ),
  );
}

let tick: number | undefined;
function renderLoading(url: string) {
  let host = url;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host || url;
  } catch {
    /* show raw */
  }
  const elapsed = h("span", { class: "state-elapsed mono" }, "0.0 s");
  const start = performance.now();
  window.clearInterval(tick);
  tick = window.setInterval(() => {
    elapsed.textContent = `${((performance.now() - start) / 1000).toFixed(1)} s`;
  }, 100);
  results.replaceChildren(
    h(
      "div",
      { class: "state state-loading", role: "status" },
      h("div", { class: "bar", "aria-hidden": "true" }, h("i")),
      h("p", { class: "label state-k" }, "Fetching ", h("span", { class: "amber" }, host), " ", elapsed),
      h("p", { class: "state-msg" }, "Vetting the address, fetching the page, parsing the HTML. Big pages take a second or two."),
    ),
  );
}

const FRIENDLY_TITLES: Record<string, string> = {
  private_address: "Blocked by the guard",
  private_host: "Blocked by the guard",
  bad_scheme: "Blocked by the guard",
  bad_port: "Blocked by the guard",
  credentials: "Blocked by the guard",
  rate_limited: "Slow down a little",
  busy: "Busy right now",
  timeout: "The site was too slow",
  too_large: "That page is too big",
  not_html: "Not a web page",
  upstream_status: "The site said no",
  dns_failed: "Site not found",
  connect_failed: "Couldn't connect",
  too_many_redirects: "Too many redirects",
  invalid_url: "Check the address",
  empty: "Check the address",
};

function renderError(code: string, message: string) {
  window.clearInterval(tick);
  const guarded = FRIENDLY_TITLES[code] === "Blocked by the guard";
  results.replaceChildren(
    h(
      "div",
      { class: `state state-error${guarded ? " state-guard" : ""}`, role: "alert" },
      h("p", { class: "label state-k" }, FRIENDLY_TITLES[code] ?? "Something went wrong", h("span", { class: "code mono" }, code)),
      h("p", { class: "state-msg" }, message),
      guarded
        ? h("p", { class: "state-sub" }, "This is the SSRF protection doing its job: the server refuses to reach anything that isn't on the public internet. See “How it works” below.")
        : null,
    ),
  );
}

// ------------------------------------------------------------------- fetch ----

let inflight: AbortController | null = null;

async function run(raw: string) {
  const url = raw.trim();
  if (!url) {
    renderError("empty", "Enter a web address first — or pick one of the samples.");
    input.focus();
    return;
  }
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;

  const qs = new URLSearchParams({ url });
  history.replaceState(null, "", `${BASE}?${qs}`);
  renderLoading(url);
  setBusy(true);

  try {
    const res = await fetch(`${API}?${qs}`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    let body: ExtractResult | ApiError;
    try {
      body = (await res.json()) as ExtractResult | ApiError;
    } catch {
      throw new Error(res.status >= 500 ? "The demo server is having trouble. Try again in a moment." : `Unexpected response (HTTP ${res.status}).`);
    }
    if (ctrl !== inflight) return;
    if (!body.ok) return renderError(body.error.code, body.error.message);
    renderResult(body);
  } catch (err) {
    if (ctrl.signal.aborted) return;
    renderError("network", err instanceof TypeError ? "Couldn't reach the demo server. Check your connection and try again." : (err as Error).message);
  } finally {
    if (ctrl === inflight) {
      setBusy(false);
      window.clearInterval(tick);
      inflight = null;
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void run(input.value);
});
input.addEventListener("input", renderEndpoint);

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  btn.addEventListener("click", async () => {
    const src = document.getElementById(btn.dataset.copy!);
    if (src) flash(btn, (await copyText(src.textContent ?? "")) ? "Copied" : "Copy failed");
  });
}

function flash(btn: HTMLElement, text: string) {
  const prev = btn.dataset.label ?? btn.textContent ?? "";
  btn.dataset.label = prev;
  btn.textContent = text;
  btn.classList.add("is-flashed");
  window.setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("is-flashed");
  }, 1400);
}

// ----------------------------------------------------------------- results ----

type TabId = "tables" | "lists" | "meta" | "raw";

function slugFor(url: string) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
  } catch {
    return "page";
  }
}

function actionBtn(label: string, onClick: (btn: HTMLButtonElement) => void, aria?: string) {
  const b = h("button", { type: "button", class: "btn btn-small", "aria-label": aria ?? label }, label);
  b.addEventListener("click", () => onClick(b));
  return b;
}

function copyJsonBtn(value: () => unknown, aria: string) {
  return actionBtn("Copy JSON", async (b) => flash(b, (await copyText(JSON.stringify(value(), null, 2))) ? "Copied" : "Copy failed"), aria);
}

function renderResult(r: ExtractResult) {
  const d = r.data;
  const slug = slugFor(r.finalUrl);

  const stat = (k: string, v: Node | string) => h("div", { class: "stat" }, h("dt", { class: "label" }, k), h("dd", { class: "mono" }, v));
  const stats = h(
    "dl",
    { class: "stats" },
    stat("Status", `${r.status}${r.cached ? " · cached" : ""}`),
    stat("Time", r.cached ? `${r.timing.totalMs} ms (cached)` : `${r.timing.fetchMs + r.timing.parseMs} ms`),
    stat("Fetched", `${formatBytes(r.bytes.wire)}${r.bytes.wire !== r.bytes.html ? ` → ${formatBytes(r.bytes.html)} html` : ""}`),
    stat("Found", [plural(d.counts.tables, "table"), plural(d.counts.lists, "list"), plural(d.counts.links, "link")].join(" · ")),
  );

  const titleRow = h(
    "div",
    { class: "result-head" },
    h("h2", { class: "result-title" }, d.title || "Untitled page"),
    h("p", { class: "result-url mono" }, extLink(r.finalUrl), r.redirects.length ? h("span", { class: "dim" }, ` · after ${r.redirects.length} redirect${r.redirects.length > 1 ? "s" : ""}`) : null),
  );

  const tabs: Array<{ id: TabId; label: string; count?: number; render: () => Node }> = [
    { id: "tables", label: "Tables", count: d.tables.length, render: () => tablesView(d.tables, slug) },
    { id: "lists", label: "Lists", count: d.lists.length, render: () => listsView(d.lists, slug) },
    { id: "meta", label: "Metadata", render: () => metaView(r) },
    { id: "raw", label: "Raw JSON", render: () => rawView(r, slug) },
  ];
  const initial: TabId = d.tables.length ? "tables" : d.lists.length ? "lists" : "meta";

  const tablist = h("div", { class: "tabs", role: "tablist", "aria-label": "Extracted data" });
  const panel = h("div", { class: "tabpanel", role: "tabpanel", tabindex: "0" });
  const buttons = tabs.map((t) =>
    h(
      "button",
      { type: "button", role: "tab", id: `tab-${t.id}`, class: "tab label", "aria-controls": "tabpanel" },
      t.label,
      t.count != null ? h("span", { class: "tab-n mono" }, t.count) : null,
    ),
  );
  panel.id = "tabpanel";
  const select = (i: number, focus = false) => {
    buttons.forEach((b, j) => {
      b.setAttribute("aria-selected", String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", buttons[i]!.id);
    panel.replaceChildren(tabs[i]!.render());
    if (focus) buttons[i]!.focus();
  };
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => select(i));
    b.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      const n = buttons.length;
      if (k === "ArrowRight") select((i + 1) % n, true);
      else if (k === "ArrowLeft") select((i - 1 + n) % n, true);
      else if (k === "Home") select(0, true);
      else if (k === "End") select(n - 1, true);
      else return;
      e.preventDefault();
    });
  });
  tablist.append(...buttons);
  select(tabs.findIndex((t) => t.id === initial));

  results.replaceChildren(h("div", { class: "result" + (reducedMotion ? "" : " enter") }, titleRow, stats, tablist, panel));
}

// ---- tables

const PREVIEW_ROWS = 100;

function tablesView(tables: TableOut[], slug: string): Node {
  if (!tables.length) {
    return emptyTab("No data tables on this page.", "Layout and navigation tables are skipped. Try the Lists tab — many sites put their records in repeated cards instead.");
  }
  const wrap = h("div", { class: "split" });
  const nav = h("div", { class: "picker", role: "listbox", "aria-label": "Tables on this page" });
  const view = h("div", { class: "picker-view" });

  const show = (t: TableOut, btn: HTMLElement) => {
    nav.querySelectorAll("[aria-selected]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    view.replaceChildren(tableCard(t, slug));
  };
  const items = tables.map((t) => {
    const b = h(
      "button",
      { type: "button", role: "option", class: "pick", "aria-selected": "false" },
      h("span", { class: "pick-n mono" }, String(t.index + 1).padStart(2, "0")),
      h("span", { class: "pick-t" }, t.caption || t.headers.slice(0, 3).join(" · ")),
      h("span", { class: "pick-c mono" }, `${t.rowCount} × ${t.headers.length}`),
    );
    b.addEventListener("click", () => show(t, b));
    return b;
  });
  nav.append(...items);
  if (tables.length > 1) wrap.append(nav);
  wrap.append(view);
  show(tables[0]!, items[0]!);
  return wrap;
}

function tableCard(t: TableOut, slug: string): Node {
  const scroller = h("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": `Table ${t.index + 1} preview` });
  const table = h("table", { class: "data" });
  table.append(h("thead", {}, h("tr", {}, ...t.headers.map((hd) => h("th", { scope: "col" }, hd)))));
  const tbody = h("tbody");
  for (const row of t.rows.slice(0, PREVIEW_ROWS)) {
    tbody.append(h("tr", {}, ...t.headers.map((hd) => h("td", {}, row[hd] ?? ""))));
  }
  table.append(tbody);
  scroller.append(table);
  const shown = Math.min(PREVIEW_ROWS, t.rows.length);
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("p", { class: "card-t" }, t.caption || `Table ${t.index + 1}`, h("span", { class: "dim mono" }, ` · ${t.rowCount} rows × ${t.headers.length} columns`)),
      h(
        "div",
        { class: "actions" },
        copyJsonBtn(() => t.rows, `Copy table ${t.index + 1} as JSON`),
        actionBtn("CSV ↓", () => download(`${slug}-table-${t.index + 1}.csv`, toCsv(t.headers, t.rows), "text/csv;charset=utf-8"), `Download table ${t.index + 1} as CSV`),
      ),
    ),
    scroller,
    shown < t.rowCount || t.truncated
      ? h("p", { class: "note" }, `Showing ${shown} of ${t.rowCount} rows here${t.truncated ? " (the API caps a table at 1,000 rows)" : ""}. Copy and CSV include ${t.truncated ? "all 1,000" : "every row"}.`)
      : null,
  );
}

// ---- lists

const PREVIEW_RECORDS = 8;

function listsView(lists: ListOut[], slug: string): Node {
  if (!lists.length) return emptyTab("No repeated structures found.", "A list needs three or more sibling elements with the same tag and classes.");
  return h(
    "div",
    { class: "lists" },
    h("p", { class: "note" }, "Ranked by how much content each group carries. Page chrome — menus, footers — ranks lowest."),
    ...lists.map((l) => listCard(l, slug)),
  );
}

function listCard(l: ListOut, slug: string): Node {
  const ol = h("ol", { class: "records" });
  let expanded = false;
  const more = l.records.length > PREVIEW_RECORDS ? h("button", { type: "button", class: "btn btn-small btn-ghost" }) : null;
  const draw = () => {
    const recs = expanded ? l.records : l.records.slice(0, PREVIEW_RECORDS);
    ol.replaceChildren(
      ...recs.map((rec) =>
        h(
          "li",
          { class: "record" },
          h("p", { class: "record-text" }, rec.text || "(no text)"),
          rec.links.length || rec.images.length
            ? h(
                "p",
                { class: "record-meta mono" },
                rec.links[0] ? extLink(rec.links[0].href, truncate(rec.links[0].text || rec.links[0].href, 60)) : null,
                rec.links.length > 1 ? h("span", { class: "dim" }, ` +${rec.links.length - 1} link${rec.links.length > 2 ? "s" : ""}`) : null,
                rec.images.length ? h("span", { class: "dim" }, ` · ${rec.images.length} image${rec.images.length > 1 ? "s" : ""}`) : null,
              )
            : null,
        ),
      ),
    );
    if (more) more.textContent = expanded ? "Show fewer" : `Show all ${l.records.length}`;
  };
  more?.addEventListener("click", () => {
    expanded = !expanded;
    draw();
  });
  draw();
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("p", { class: "card-t" }, h("code", { class: "sel" }, l.selector), h("span", { class: "dim mono" }, ` · ${l.count} records`)),
      h(
        "div",
        { class: "actions" },
        copyJsonBtn(() => l.records, `Copy list ${l.index + 1} as JSON`),
        actionBtn("CSV ↓", () => download(`${slug}-list-${l.index + 1}.csv`, listToCsv(l.records), "text/csv;charset=utf-8"), `Download list ${l.index + 1} as CSV`),
      ),
    ),
    ol,
    more,
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- metadata

function metaView(r: ExtractResult): Node {
  const d = r.data;
  const rows = (obj: Record<string, string | null>) =>
    Object.entries(obj)
      .filter(([, v]) => v)
      .map(([k, v]) => h("div", { class: "kv" }, h("dt", { class: "label" }, k), h("dd", { class: "mono" }, /^https?:\/\//.test(v!) ? extLink(v!) : v!)));

  const basics = rows({ title: d.title, description: d.meta.description, canonical: d.meta.canonical, lang: d.meta.lang, robots: d.meta.robots, "content-type": r.contentType });
  const og = rows(d.meta.openGraph);
  const tw = rows(d.meta.twitter);

  const outline = h("ol", { class: "outline" });
  for (const hd of d.headings.slice(0, 80)) {
    outline.append(h("li", { class: `lvl-${hd.level}` }, h("span", { class: "mono dim" }, `h${hd.level}`), " ", hd.text));
  }
  const internal = d.links.filter((l) => l.internal).length;
  const links = h("ol", { class: "link-list" }, ...d.links.slice(0, 40).map((l) => h("li", {}, extLink(l.href, truncate(l.text || l.href, 80)))));

  const block = (title: string, count: string | null, ...body: Array<Node | null>) =>
    h("section", { class: "meta-block" }, h("h3", { class: "label block-t" }, title, count ? h("span", { class: "mono dim" }, ` ${count}`) : null), ...body);

  return h(
    "div",
    { class: "meta-grid" },
    block("Page", null, h("dl", { class: "kvs" }, ...basics)),
    block("OpenGraph", String(og.length), og.length ? h("dl", { class: "kvs" }, ...og) : h("p", { class: "dim" }, "No og: tags.")),
    tw.length ? block("Twitter card", String(tw.length), h("dl", { class: "kvs" }, ...tw)) : null,
    block(
      "JSON-LD",
      String(d.jsonLd.length),
      d.jsonLd.length ? h("pre", { class: "json small", tabindex: "0" }, highlightJson(JSON.stringify(d.jsonLd, null, 2), 40_000)) : h("p", { class: "dim" }, "No structured data blocks."),
    ),
    block("Headings", String(d.headings.length), d.headings.length ? outline : h("p", { class: "dim" }, "No headings.")),
    block(
      "Links",
      `${d.links.length}${d.links.length >= 500 ? "+" : ""} · ${internal} internal`,
      links,
      d.links.length > 40 ? h("p", { class: "note" }, `First 40 shown. All ${d.links.length} are in the JSON.`) : null,
    ),
  );
}

// ---- raw

function rawView(r: ExtractResult, slug: string): Node {
  const text = JSON.stringify(r, null, 2);
  const LIMIT = 150_000;
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("p", { class: "card-t" }, "The full API response", h("span", { class: "dim mono" }, ` · ${formatBytes(new Blob([text]).size)}`)),
      h(
        "div",
        { class: "actions" },
        actionBtn("Copy JSON", async (b) => flash(b, (await copyText(text)) ? "Copied" : "Copy failed"), "Copy the full response as JSON"),
        actionBtn("JSON ↓", () => download(`${slug}.json`, text, "application/json"), "Download the full response as JSON"),
      ),
    ),
    h("pre", { class: "json", tabindex: "0", "aria-label": "Raw JSON response" }, highlightJson(text, LIMIT)),
    text.length > LIMIT ? h("p", { class: "note" }, `Preview cut at ${formatBytes(LIMIT)}. Copy and download give the whole thing.`) : null,
  );
}

function emptyTab(title: string, msg: string): Node {
  return h("div", { class: "state state-empty inline" }, h("p", { class: "label state-k" }, title), h("p", { class: "state-msg" }, msg));
}

// -------------------------------------------------------------------- boot ----

const initialUrl = new URLSearchParams(location.search).get("url");
if (initialUrl) {
  input.value = initialUrl;
  renderEndpoint();
  void run(initialUrl);
} else {
  renderEndpoint();
  renderEmpty();
}
