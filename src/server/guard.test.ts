import { describe, expect, it } from "vitest";
import { checkUrl, GuardError, isPublicAddress, resolveHost, systemResolver, vet, type Resolver } from "./guard.js";

const fakeDns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const addrs = table[host];
    if (!addrs) throw new Error("ENOTFOUND");
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

async function blocked(input: string, resolver?: Resolver): Promise<string> {
  try {
    await vet(input, resolver ?? fakeDns({ "example.com": ["93.184.215.14"] }));
  } catch (err) {
    expect(err).toBeInstanceOf(GuardError);
    return (err as GuardError).code;
  }
  throw new Error(`${input} was allowed`);
}

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.100.100.200",
    "169.254.169.254",
    "224.0.0.1",
    "255.255.255.255",
    "240.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "fec0::1",
    "not-an-ip",
    "",
  ])("refuses %s", (addr) => {
    expect(isPublicAddress(addr)).toBe(false);
  });

  it.each(["93.184.215.14", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"])("allows %s", (addr) => {
    expect(isPublicAddress(addr)).toBe(true);
  });
});

describe("checkUrl — syntax", () => {
  it("assumes https for a bare host", () => {
    expect(checkUrl("example.com/path").url.toString()).toBe("https://example.com/path");
  });

  it("drops the fragment", () => {
    expect(checkUrl("https://example.com/a#frag").url.toString()).toBe("https://example.com/a");
  });

  it.each([
    ["file:///etc/passwd", "bad_scheme"],
    ["gopher://example.com/", "bad_scheme"],
    ["ftp://example.com/", "bad_scheme"],
    ["javascript:alert(1)", "bad_scheme"],
    ["data:text/html,hi", "bad_scheme"],
    ["http://example.com:8080/", "bad_port"],
    ["example.com:8080", "bad_port"],
    ["https://example.com:22/", "bad_port"],
    ["http://user:pass@example.com/", "credentials"],
    ["http://user@example.com/", "credentials"],
    ["http://localhost/", "private_host"],
    ["http://LOCALHOST./", "private_host"],
    ["http://app.localhost/", "private_host"],
    ["http://metadata.google.internal/", "private_host"],
    ["http://printer.local/", "private_host"],
    ["http://metadata/", "private_host"],
    ["", "empty"],
    ["http://", "invalid_url"],
  ])("refuses %s (%s)", (input, code) => {
    expect(() => checkUrl(input)).toThrowError(expect.objectContaining({ code }));
  });

  it("allows explicit standard ports", () => {
    expect(() => checkUrl("http://example.com:80/")).not.toThrow();
    expect(() => checkUrl("https://example.com:443/")).not.toThrow();
  });
});

describe("vet — the full pre-connect check", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://0.0.0.0/",
    "http://0/",
    "http://[::1]/",
    "http://[::]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://100.64.0.1/",
    // Alternative IPv4 spellings, normalised by the WHATWG URL parser before the check
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://017700000001/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fd00:ec2::254]/",
  ])("blocks %s", async (input) => {
    expect(await blocked(input)).toBe("private_address");
  });

  it("blocks a host name that resolves to loopback", async () => {
    expect(await blocked("http://evil.example/", fakeDns({ "evil.example": ["127.0.0.1"] }))).toBe("private_address");
  });

  it("blocks a name with one public and one private record (no picking the safe one)", async () => {
    const dns = fakeDns({ "mixed.example": ["93.184.215.14", "10.0.0.7"] });
    expect(await blocked("http://mixed.example/", dns)).toBe("private_address");
  });

  it("blocks a name resolving to an IPv4-mapped loopback", async () => {
    expect(await blocked("http://m.example/", fakeDns({ "m.example": ["::ffff:127.0.0.1"] }))).toBe("private_address");
  });

  it("blocks localtest.me via real DNS (it resolves to 127.0.0.1 / ::1)", async () => {
    // If DNS is unavailable this is still refused, just with a different code.
    expect(["private_address", "dns_failed"]).toContain(await blocked("http://localtest.me/", systemResolver));
  });

  it("returns the pinned public address, preferring IPv4", async () => {
    const dns = fakeDns({ "ok.example": ["2606:4700::1", "93.184.215.14"] });
    const pinned = await resolveHost(checkUrl("https://ok.example/"), dns);
    expect(pinned).toEqual({ address: "93.184.215.14", family: 4 });
  });

  it("reports a name that does not resolve", async () => {
    expect(await blocked("http://nope.example/", fakeDns({}))).toBe("dns_failed");
  });
});
