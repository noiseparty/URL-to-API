/**
 * CSV for spreadsheet users. RFC 4180 quoting, CRLF line ends, and a guard against formula
 * injection: a scraped cell reading `=HYPERLINK(...)` would otherwise run when opened in
 * Excel or Sheets. Such cells get a leading apostrophe — unless they are plain numbers,
 * so "-35" in a stats table stays a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d[\d,]*)?(\.\d+)?%?$/;

export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** A list group's records flattened to fixed columns. */
export function listToCsv(records: Array<{ text: string; links: Array<{ text: string; href: string }>; images: Array<{ src: string; alt: string }> }>): string {
  const headers = ["text", "first_link_text", "first_link", "links", "first_image", "image_alt"];
  return toCsv(
    headers,
    records.map((r) => ({
      text: r.text,
      first_link_text: r.links[0]?.text ?? "",
      first_link: r.links[0]?.href ?? "",
      links: r.links.map((l) => l.href).join(" "),
      first_image: r.images[0]?.src ?? "",
      image_alt: r.images[0]?.alt ?? "",
    })),
  );
}
