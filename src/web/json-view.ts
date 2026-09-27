/**
 * JSON syntax colouring built from text nodes only (no innerHTML), so a scraped string
 * containing markup renders as the characters it is.
 */
const TOKEN = /("(?:\.|[^"\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function highlightJson(text: string, limit = Infinity): DocumentFragment {
  const src = text.length > limit ? text.slice(0, limit) + "\n…" : text;
  const frag = document.createDocumentFragment();
  let last = 0;
  const span = (cls: string, s: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = s;
    frag.append(el);
  };
  for (const m of src.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) frag.append(src.slice(last, i));
    if (m[1]) {
      span(m[2] ? "j-key" : "j-str", m[1]);
      if (m[2]) frag.append(m[2]);
    } else if (m[3]) span("j-lit", m[3]);
    else if (m[4]) span("j-num", m[4]);
    last = i + m[0].length;
  }
  if (last < src.length) frag.append(src.slice(last));
  return frag;
}
