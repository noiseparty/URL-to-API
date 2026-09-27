import { describe, expect, it } from "vitest";
import { extract, uniqueKeys } from "./extract.js";

const page = (body: string, head = "") => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe("tables", () => {
  it("keys rows by header and expands rowspan/colspan", () => {
    const html = page(`
      <table>
        <caption>Cities</caption>
        <thead>
          <tr><th rowspan="2">City</th><th colspan="2">Population</th></tr>
          <tr><th>2020</th><th>2025</th></tr>
        </thead>
        <tbody>
          <tr><td rowspan="2">Riga</td><td>614<sup class="reference">[1]</sup></td><td>605</td></tr>
          <tr><td>615</td><td>606</td></tr>
          <tr><td>Tallinn</td><td>437</td><td>461</td></tr>
        </tbody>
      </table>`);
    const [t] = extract(html, "https://example.com/").tables;
    expect(t!.caption).toBe("Cities");
    expect(t!.headers).toEqual(["City", "Population / 2020", "Population / 2025"]);
    expect(t!.rows).toEqual([
      { City: "Riga", "Population / 2020": "614", "Population / 2025": "605" },
      { City: "Riga", "Population / 2020": "615", "Population / 2025": "606" },
      { City: "Tallinn", "Population / 2020": "437", "Population / 2025": "461" },
    ]);
  });

  it("uses a plain first row as header only when it looks like one", () => {
    const withHeader = extract(page(`<table><tr><td>Name</td><td>Age</td></tr><tr><td>Ann</td><td>30</td></tr></table>`), "https://e.com/");
    expect(withHeader.tables[0]!.headers).toEqual(["Name", "Age"]);
    const without = extract(
      page(`<table><tr><td>1.</td><td></td><td>Story</td></tr><tr><td>2.</td><td></td><td>Other</td></tr></table>`),
      "https://e.com/",
    );
    expect(without.tables[0]!.headers).toEqual(["column_1", "column_2", "column_3"]);
    expect(without.tables[0]!.rows).toHaveLength(2);
  });

  it("skips navigation tables", () => {
    const html = page(`<div role="navigation"><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></div>`);
    expect(extract(html, "https://e.com/").tables).toHaveLength(0);
  });

  it("de-duplicates header names", () => {
    expect(uniqueKeys(["Name", "", "Name", "Name"])).toEqual(["Name", "column_2", "Name_2", "Name_3"]);
  });
});

describe("repeated structures", () => {
  it("turns 3+ same-signature siblings into records with absolute links and images", () => {
    const cards = [1, 2, 3, 4]
      .map(
        (i) =>
          `<article class="product_pod card-${i}000"><img src="/img/${i}.jpg" alt="Book ${i}"><h3><a href="book-${i}.html">Book ${i}</a></h3><p class="price">£${i}0.00</p></article>`,
      )
      .join("");
    const html = page(`<ol class="row">${cards}</ol><ul class="menu"><li>a</li><li>b</li></ul>`);
    const { lists } = extract(html, "https://shop.example/cat/index.html");
    expect(lists).toHaveLength(1);
    const [l] = lists;
    expect(l!.selector).toBe("ol.row > article.product_pod");
    expect(l!.count).toBe(4);
    expect(l!.records[0]).toEqual({
      text: "Book 1 £10.00",
      links: [{ text: "Book 1", href: "https://shop.example/cat/book-1.html" }],
      images: [{ src: "https://shop.example/img/1.jpg", alt: "Book 1" }],
    });
  });

  it("ranks content above page chrome", () => {
    const items = (n: number, t: string) =>
      Array.from({ length: n }, (_, i) => `<li><a href="/${t}${i}">${t} item number ${i} with a longer description</a></li>`).join("");
    const html = page(`<nav><ul>${items(6, "menu")}</ul></nav><main><ul>${items(6, "story")}</ul></main>`);
    const { lists } = extract(html, "https://e.com/");
    expect(lists[0]!.records[0]!.text).toContain("story");
  });

  it("finds classed table rows (Hacker News style)", () => {
    const rows = [1, 2, 3]
      .map((i) => `<tr class="athing"><td>${i}.</td><td><a href="item?id=${i}">Story ${i}</a></td></tr><tr><td></td><td>${i} points</td></tr>`)
      .join("");
    const { lists } = extract(page(`<table>${rows}</table>`), "https://news.example/");
    expect(lists.map((l) => l.selector)).toContain("tbody > tr.athing");
  });
});

describe("metadata", () => {
  it("collects title, description, OpenGraph, canonical, headings and JSON-LD", () => {
    const head = `<title> Hello  World </title>
      <meta name="description" content="A page">
      <meta property="og:title" content="OG Hello"><meta property="og:image" content="https://e.com/i.png">
      <link rel="canonical" href="/canon">
      <script type="application/ld+json">{"@type":"Organization","name":"Cosmic"}</script>
      <script type="application/ld+json">{broken</script>`;
    const d = extract(page("<h1>Top</h1><h2 id='s'>Sub</h2>", head), "https://e.com/x");
    expect(d.title).toBe("Hello World");
    expect(d.meta.description).toBe("A page");
    expect(d.meta.openGraph).toEqual({ title: "OG Hello", image: "https://e.com/i.png" });
    expect(d.meta.canonical).toBe("https://e.com/canon");
    expect(d.meta.lang).toBe("en");
    expect(d.jsonLd[0]).toEqual({ "@type": "Organization", name: "Cosmic" });
    expect(d.jsonLd[1]).toMatchObject({ _error: expect.any(String) });
    expect(d.headings).toEqual([
      { level: 1, text: "Top", id: null },
      { level: 2, text: "Sub", id: "s" },
    ]);
  });

  it("resolves links against <base>, drops javascript: and duplicates, marks internal", () => {
    const d = extract(
      page(
        `<a href="a">A</a><a href="a">A again</a><a href="javascript:alert(1)">x</a><a href="https://other.example/">O</a>`,
        `<base href="https://e.com/dir/">`,
      ),
      "https://e.com/page",
    );
    expect(d.links).toEqual([
      { text: "A", href: "https://e.com/dir/a", internal: true },
      { text: "O", href: "https://other.example/", internal: false },
    ]);
  });

  it("ignores script and style text", () => {
    const d = extract(
      page(`<table><tr><th>a</th><th>b</th></tr><tr><td>1<script>evil()</script></td><td><style>x{}</style>2</td></tr></table>`),
      "https://e.com/",
    );
    expect(d.tables[0]!.rows[0]).toEqual({ a: "1", b: "2" });
  });
});
