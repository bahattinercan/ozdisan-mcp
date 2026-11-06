import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { UserInputError } from "./http.js";

/**
 * İstem enjeksiyonu yoluyla yerel makineye / iç ağa istek atılmasını (SSRF) önleyen denetimler.
 * Kullanıcının verdiği ve Özdisan dışındaki her adres, her yönlendirme adımında buradan geçer.
 */

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToNumber(ip);
  if (n === undefined) return true;
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToNumber(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) ||
    inRange("240.0.0.0", 4)
  );
}

/** IPv6 adresini 8 adet 16 bitlik gruba açar. */
function expandIpv6(ip: string): number[] | undefined {
  let addr = ip.toLowerCase().split("%")[0]!;
  // Sonda gömülü IPv4 (ör. ::ffff:127.0.0.1)
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToNumber(v4[1]!);
    if (n === undefined) return undefined;
    addr = addr.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined && h.length !== 8) return undefined;
  if (missing < 0) return undefined;
  const groups = [...h, ...Array(tail !== undefined ? missing : 0).fill("0"), ...t].map((g) => Number.parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;
  const embeddedV4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: ve ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateIpv4(embeddedV4); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIpv4(embeddedV4); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

/** Yalnızca ada bakarak yerel/özel ağ adresini tespit eder (DNS çözümlemeden). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) {
    return true;
  }
  if (isIP(h)) return isPrivateAddress(h);
  return false;
}

/** Adresin internette, herkese açık bir sunucuya gittiğini (DNS çözümlemesi dahil) doğrular. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserInputError(`Geçersiz URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UserInputError("Yalnızca http(s) adresleri desteklenir.");
  if (url.username || url.password) throw new UserInputError("Kullanıcı adı/parola içeren adresler desteklenmez.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const blocked = () =>
    new UserInputError("Yerel ağ / localhost adresleri okunamaz; yalnızca internetteki datasheet adresleri desteklenir.");
  if (isPrivateHost(host)) throw blocked();
  if (!isIP(host)) {
    let addrs: Array<{ address: string }>;
    try {
      addrs = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new UserInputError(`Alan adı çözümlenemedi: ${host}`);
    }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw blocked();
  }
  return url;
}
