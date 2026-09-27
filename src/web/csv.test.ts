import { describe, expect, it } from "vitest";
import { csvCell, listToCsv, toCsv } from "./csv";

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(null)).toBe("");
  });

  it("neutralises formulas but keeps signed numbers", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-35")).toBe("-35");
    expect(csvCell("+1.5")).toBe("+1.5");
    expect(csvCell("-cmd")).toBe("'-cmd");
  });

  it("writes a header and rows with CRLF", () => {
    expect(toCsv(["a", "b"], [{ a: "1", b: "x,y" }])).toBe('a,b\r\n1,"x,y"\r\n');
  });

  it("flattens list records", () => {
    const csv = listToCsv([{ text: "Book", links: [{ text: "Book", href: "https://e.com/b" }], images: [] }]);
    expect(csv.split("\r\n")[1]).toBe("Book,Book,https://e.com/b,https://e.com/b,,");
  });
});
