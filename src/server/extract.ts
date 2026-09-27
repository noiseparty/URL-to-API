/**
 * HTML → structured JSON. Pure: takes a string and a base URL, touches no network.
 *
 * Parsed with cheerio's parse5 backend, i.e. the same HTML5 tree-construction algorithm a
 * browser uses — implied <tbody>, mis-nested tags and unclosed <li>s all come out the way
 * the page's author saw them rendered.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

type $ = cheerio.CheerioAPI;

export interface LinkRef {
  text: string;
  href: string;
}
export interface ImageRef {
  src: string;
  alt: string;
}
export interface TableOut {
  index: number;
  caption: string | null;
  headers: string[];
  rows: Array<Record<string, string>>;
  rowCount: number;
  truncated: boolean;
}
export interface ListRecord {
  text: string;
  links: LinkRef[];
  images: ImageRef[];
}
export interface ListOut {
  index: number;
  selector: string;
  count: number;
  records: ListRecord[];
  truncated: boolean;
}
export interface Extracted {
  title: string | null;
  meta: {
    description: string | null;
    canonical: string | null;
    lang: string | null;
    robots: string | null;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
    other: Record<string, string>;
  };
  jsonLd: unknown[];
  tables: TableOut[];
  lists: ListOut[];
  headings: Array<{ level: number; text: string; id: string | null }>;
  links: Array<LinkRef & { internal: boolean }>;
  counts: { tables: number; lists: number; headings: number; links: number; jsonLd: number };
}

export const LIMITS = {
  tables: 40,
  tableRows: 1000,
  tableCols: 60,
  lists: 15,
  listRecords: 200,
  recordText: 400,
  recordLinks: 10,
  headings: 300,
  links: 500,
  cellText: 1000,
};

export function extract(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);

  // Resolve relative URLs the way the browser would: <base href> first, then the page URL.
  let base = pageUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).toString();
    } catch {
      /* keep page URL */
    }
  }
  // Nothing in these is page content, and footnote markers ("[12]") pollute table cells.
  $("script:not([type='application/ld+json']), style, noscript, template, sup.reference, .mw-editsection").remove();

  const tables = extractTables($);
  const lists = extractLists($, base);
  const headings = extractHeadings($);
  const links = extractLinks($, base, pageUrl);
  const jsonLd = extractJsonLd($);

  return {
    title: clean($("head > title").first().text()) || metaContent($, "og:title") || null,
    meta: extractMeta($, base),
    jsonLd,
    tables,
    lists,
    headings,
    links,
    counts: {
      tables: tables.length,
      lists: lists.length,
      headings: headings.length,
      links: links.length,
      jsonLd: jsonLd.length,
    },
  };
}

// ------------------------------------------------------------------ helpers ----

export function clean(s: string | undefined | null, max = Infinity): string {
  if (!s) return "";
  const out = s.replace(/[\s ​]+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript|data|vbscript):/i.test(h)) return null;
  try {
    return new URL(h, base).toString();
  } catch {
    return null;
  }
}

/** Text of a node with block boundaries turned into spaces, so "<td>a<br>b</td>" is "a b". */
function textOf($: $, el: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === "text") parts.push((n as unknown as { data: string }).data);
    else if (n.type === "tag") {
      const tag = (n as Element).tagName;
      if (tag === "br" || tag === "p" || tag === "div" || tag === "li") parts.push(" ");
      for (const c of (n as Element).children) walk(c);
      if (tag === "p" || tag === "div" || tag === "li" || tag === "td" || tag === "th") parts.push(" ");
    }
  };
  walk(el);
  void $;
  return parts.join("");
}

function metaContent($: $, key: string): string | null {
  const v = $(`meta[property="${key}"], meta[name="${key}"]`).first().attr("content");
  return v ? clean(v) : null;
}

// ------------------------------------------------------------------- meta ----

function extractMeta($: $, base: string): Extracted["meta"] {
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const other: Record<string, string> = {};
  $("meta").each((_, el) => {
    const key = ($(el).attr("property") ?? $(el).attr("name") ?? "").trim().toLowerCase();
    const content = clean($(el).attr("content"), 2000);
    if (!key || !content) return;
    if (key.startsWith("og:")) openGraph[key.slice(3)] ??= content;
    else if (key.startsWith("twitter:")) twitter[key.slice(8)] ??= content;
    else if (Object.keys(other).length < 50) other[key] ??= content;
  });
  const canonical = absolute($('link[rel="canonical"]').first().attr("href"), base);
  return {
    description: metaContent($, "description") ?? openGraph.description ?? null,
    canonical,
    lang: $("html").attr("lang")?.trim() || null,
    robots: metaContent($, "robots"),
    openGraph,
    twitter,
    other,
  };
}

function extractJsonLd($: $): unknown[] {
  const out: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out.length >= 20) return;
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push({ _error: "Invalid JSON in this block", _raw: raw.slice(0, 500) });
    }
  });
  return out;
}

// ----------------------------------------------------------------- tables ----

/**
 * Expands a table into a rectangular grid, honouring rowspan and colspan, so every data
 * row lines up with its header. Wikipedia tables lean on rowspan heavily; without this,
 * cells shift left one column for every spanned row above them.
 */
export function tableGrid($: $, table: Element): { grid: string[][]; isHeader: boolean[] } {
  const rows = $(table).find("> tr, > thead > tr, > tbody > tr, > tfoot > tr").toArray();
  const grid: string[][] = [];
  const isHeader: boolean[] = [];
  const pending: Array<{ text: string; left: number } | undefined> = []; // rowspan carry per column

  rows.slice(0, LIMITS.tableRows + 5).forEach((tr, r) => {
    const row: string[] = [];
    const cells = $(tr).children("th, td").toArray();
    const inThead = $(tr).parent().is("thead");
    isHeader[r] = inThead || (cells.length > 0 && cells.every((c) => c.tagName === "th"));
    let col = 0;
    const fillCarried = () => {
      while (pending[col] && pending[col]!.left > 0) {
        row[col] = pending[col]!.text;
        pending[col]!.left--;
        col++;
      }
    };
    for (const cell of cells) {
      fillCarried();
      const text = clean(textOf($, cell), LIMITS.cellText);
      const colspan = Math.min(Math.max(parseInt($(cell).attr("colspan") ?? "1", 10) || 1, 1), LIMITS.tableCols);
      const rowspan = Math.min(Math.max(parseInt($(cell).attr("rowspan") ?? "1", 10) || 1, 1), 1000);
      for (let k = 0; k < colspan && col < LIMITS.tableCols; k++, col++) {
        row[col] = text;
        pending[col] = rowspan > 1 ? { text, left: rowspan - 1 } : undefined;
      }
    }
    fillCarried();
    grid.push(Array.from(row, (v) => v ?? ""));
  });
  return { grid, isHeader };
}

function extractTables($: $): TableOut[] {
  const out: TableOut[] = [];
  $("table").each((_, table) => {
    if (out.length >= LIMITS.tables) return false;
    // Navigation boxes (Wikipedia's "v t e" navboxes, mega-menus) are link grids, not data.
    if ($(table).closest("nav, [role=navigation], .navbox, .vertical-navbox, .sidebar").length) return;
    // Layout tables that only wrap other tables carry no data of their own.
    if ($(table).find("table").length > 0 && $(table).find("> tbody > tr > th, > thead > tr > th").length === 0) {
      return;
    }
    const { grid, isHeader } = tableGrid($, table);
    if (grid.length < 2) return;
    const width = Math.max(...grid.map((r) => r.length));
    if (width < 2) return;

    // Header = the leading run of header rows; when there are several (grouped headings),
    // join them per column: "Population / 2023".
    let headerRows = 0;
    while (headerRows < grid.length && isHeader[headerRows]) headerRows++;
    // No <th> at all: old-style tables often put headers in a plain first row. Trust that
    // only when it looks like one — every cell filled, all short — else number the columns.
    const first = grid[0] ?? [];
    const firstLooksLikeHeader =
      first.length === width && first.every((v) => v !== "" && v.length <= 60 && !/^[\d.,%\s-]+$/.test(v));
    const dataStart = headerRows > 0 ? headerRows : firstLooksLikeHeader ? 1 : 0;
    const headSource = grid.slice(0, dataStart);
    const raw = Array.from({ length: width }, (_, c) => {
      const parts: string[] = [];
      for (const hr of headSource) {
        const v = hr[c] ?? "";
        if (v && parts[parts.length - 1] !== v) parts.push(v);
      }
      return parts.join(" / ");
    });
    const headers = uniqueKeys(raw);

    const dataRows = grid.slice(dataStart).filter((r) => r.some((v) => v !== ""));
    const rows = dataRows.slice(0, LIMITS.tableRows).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, c) => (obj[h] = r[c] ?? ""));
      return obj;
    });
    if (rows.length === 0) return;
    const caption = clean($(table).children("caption").first().text()) || null;
    out.push({
      index: out.length,
      caption,
      headers,
      rows,
      rowCount: dataRows.length,
      truncated: dataRows.length > LIMITS.tableRows,
    });
  });
  return out;
}

export function uniqueKeys(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

// ------------------------------------------------------------------ lists ----

/** Classes that describe state or position rather than kind, and so vary between siblings. */
const NOISE_CLASS = /^(active|selected|current|open|closed|hidden|visible|odd|even|first|last|is-.*|has-.*|js-.*)$|\d{3,}/i;
/** Never a record themselves. (tbody is a fine *parent* — Hacker News rows live in one.) */
const SKIP_ITEMS = new Set(["script", "style", "head", "option", "br", "hr", "meta", "link", "td", "th", "thead", "tbody", "tfoot", "col", "colgroup", "source", "path", "svg", "g"]);
const SKIP_PARENTS = new Set(["script", "style", "head", "select", "svg", "g", "tr", "colgroup"]);
/** Page chrome. Lists inside it are real but rarely what anyone came for, so they rank lower. */
const CHROME = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]";
/** Scholarly apparatus: reference lists, navboxes, tables of contents. Long and text-heavy, so
 *  they would otherwise outrank the article content they annotate. Ranked lower still. */
const APPARATUS = ".references, .reflist, .refbegin, .mw-references-wrap, .navbox, .catlinks, .toc, #toc, .sidebar, .footnotes, [role=doc-endnotes]";

export function signature(el: Element): string {
  const classes = (el.attribs.class ?? "")
    .split(/\s+/)
    .filter((c) => c && !NOISE_CLASS.test(c))
    .sort();
  return classes.length ? `${el.tagName}.${classes.join(".")}` : el.tagName;
}

function shortSelector(el: Element): string {
  const id = el.attribs.id;
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `${el.tagName}#${id}`;
  return signature(el);
}

/**
 * Repeated structures: siblings that share a tag+class signature, three or more of them,
 * are almost always the page's records — product cards, search results, comment threads.
 * Each is flattened to {text, links, images}, and the groups are ranked by how much
 * content they carry, so a 30-row result list outranks a 5-item footer menu.
 */
function extractLists($: $, base: string): ListOut[] {
  type Group = { parent: Element; sig: string; items: Element[] };
  const groups: Group[] = [];

  $("body *").each((_, parent) => {
    const el = parent as Element;
    if (SKIP_PARENTS.has(el.tagName)) return;
    const bySig = new Map<string, Element[]>();
    for (const child of el.children) {
      if (child.type !== "tag") continue;
      const c = child as Element;
      if (SKIP_ITEMS.has(c.tagName)) continue;
      // Table rows count only when classed: a bare <tr> run is already covered by Tables,
      // but classed rows (Hacker News's tr.athing) are a list wearing a table.
      if (c.tagName === "tr" && !c.attribs.class) continue;
      const sig = signature(c);
      const list = bySig.get(sig);
      if (list) list.push(c);
      else bySig.set(sig, [c]);
    }
    for (const [sig, items] of bySig) if (items.length >= 3) groups.push({ parent: el, sig, items });
  });

  const scored = groups
    .map((g) => {
      const records = g.items.slice(0, LIMITS.listRecords).map((item) => toRecord($, item, base));
      const filled = records.filter((r) => r.text || r.links.length || r.images.length);
      const textLen = filled.reduce((n, r) => n + Math.min(r.text.length, 200), 0);
      const distinct = new Set(filled.map((r) => r.text)).size;
      // Content volume, damped for groups whose records are all the same text, and for
      // groups whose records are single bare links (menus) rather than composite cards.
      const composite = filled.filter((r) => r.links.length + r.images.length > 1 || r.text.length > 60).length;
      const chrome = $(g.parent).closest(CHROME).length > 0 ? 0.25 : 1;
      // Apparatus sorts after everything else regardless of size.
      const tier = $(g.parent).closest(APPARATUS).length > 0 ? 1 : 0;
      const score = chrome * textLen * (distinct / Math.max(filled.length, 1)) * (1 + composite / Math.max(filled.length, 1));
      return { g, records: filled, score, tier };
    })
    .filter((s) => s.records.length >= 3 && s.score > 0);

  scored.sort((a, b) => a.tier - b.tier || b.score - a.score);

  // Drop a group nested inside an already-chosen group's items: the outer records
  // already contain its text, so it would be the same data twice.
  const chosen: typeof scored = [];
  for (const s of scored) {
    if (chosen.length >= LIMITS.lists) break;
    const inside = chosen.some((c) => c.g.items.some((it) => contains(it, s.g.parent)));
    if (!inside) chosen.push(s);
  }

  return chosen.map((s, index) => ({
    index,
    selector: `${shortSelector(s.g.parent)} > ${s.g.sig}`,
    count: s.g.items.length,
    records: s.records,
    truncated: s.g.items.length > LIMITS.listRecords,
  }));
}

function contains(ancestor: Element, node: Element): boolean {
  for (let n: Element | null = node; n; n = n.parent as Element | null) if (n === ancestor) return true;
  return false;
}

function toRecord($: $, item: Element, base: string): ListRecord {
  const links: LinkRef[] = [];
  const seen = new Set<string>();
  $(item)
    .find("a[href]")
    .addBack("a[href]")
    .each((_, a) => {
      if (links.length >= LIMITS.recordLinks) return false;
      const href = absolute($(a).attr("href"), base);
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push({ text: clean($(a).text(), 200) || clean($(a).attr("title"), 200), href });
    });
  const images: ImageRef[] = [];
  $(item)
    .find("img")
    .addBack("img")
    .each((_, img) => {
      if (images.length >= 5) return false;
      const src = absolute($(img).attr("src") ?? $(img).attr("data-src"), base);
      if (src) images.push({ src, alt: clean($(img).attr("alt"), 200) });
    });
  return { text: clean(textOf($, item), LIMITS.recordText), links, images };
}

// --------------------------------------------------------- headings, links ----

function extractHeadings($: $): Extracted["headings"] {
  const out: Extracted["headings"] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (out.length >= LIMITS.headings) return false;
    const text = clean($(el).text(), 300);
    if (text) out.push({ level: Number(el.tagName[1]), text, id: $(el).attr("id") ?? null });
  });
  return out;
}

function extractLinks($: $, base: string, pageUrl: string): Extracted["links"] {
  const host = new URL(pageUrl).host;
  const out: Extracted["links"] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    if (out.length >= LIMITS.links) return false;
    const href = absolute($(a).attr("href"), base);
    if (!href || seen.has(href)) return;
    seen.add(href);
    let internal = false;
    try {
      internal = new URL(href).host === host;
    } catch {
      /* mailto: etc. */
    }
    out.push({ text: clean($(a).text(), 200) || clean($(a).attr("title") ?? $(a).attr("aria-label"), 200), href, internal });
  });
  return out;
}
