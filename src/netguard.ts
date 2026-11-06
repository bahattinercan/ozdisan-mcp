import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
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

/**
 * IPv6 için izin listesi yaklaşımı: yalnızca küresel tek noktaya yayın (2000::/3) adresleri herkese açık sayılır;
 * IPv4 gömen biçimlerde (eşlemeli, uyumlu, NAT64, 6to4) gömülü IPv4 adresi ayrıca denetlenir.
 */
function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIpv4(v4(g[6]!, g[7]!)); // ::ffff:a.b.c.d (eşlemeli)
  if (zeros(0, 6)) return true; // ::, ::1 ve kullanımdan kalkmış IPv4-uyumlu ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // 64:ff9b::/96 (NAT64) gömülü IPv4'e bakılır; 64:ff9b:1::/48 (yerel NAT64) her zaman engellenir.
    return zeros(2, 6) ? isPrivateIpv4(v4(g[6]!, g[7]!)) : true;
  }
  if ((g[0]! & 0xe000) !== 0x2000) return true; // 2000::/3 dışı: ULA, link-local, multicast, ayrılmış alanlar
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 (Teredo 2001::/32 dahil özel amaçlı)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 (dokümantasyon)
  if (g[0] === 0x2002) return isPrivateIpv4(v4(g[1]!, g[2]!)); // 6to4: gömülü IPv4
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

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * Bağlantı anında kullanılan DNS çözümleyici: bağlanılacak her adres burada denetlenir.
 * Böylece "önce kontrol et, sonra ayrıca çözümle" arasındaki DNS rebinding açığı kapanır.
 */
export function safeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const blocked: NodeJS.ErrnoException = new Error(`${hostname} yerel/özel bir ağ adresine çözümleniyor; erişim engellendi.`);
      blocked.code = "EPRIVATEADDR";
      return callback(blocked);
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

/**
 * Özdisan dışı bir adrese, bağlantı anında adres denetimi yapan (safeLookup) tek bir GET isteği atar.
 * Yönlendirmeleri takip etmez; çağıran her adımı ayrıca denetler. Sonucu standart Response olarak döndürür.
 */
export function externalGet(
  url: URL,
  opts: { headers: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", headers: opts.headers, lookup: safeLookup as never, signal: opts.signal, timeout: opts.timeoutMs },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const item of v) headers.append(k, item);
          else if (v !== undefined) headers.set(k, String(v));
        }
        const nullBody = [101, 103, 204, 205, 304].includes(status) || (status >= 300 && status < 400);
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("Sunucu zamanında yanıt vermedi."), { name: "TimeoutError" })));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPRIVATEADDR") {
        reject(new UserInputError("Yerel ağ / localhost adresleri okunamaz; yalnızca internetteki datasheet adresleri desteklenir."));
      } else reject(err);
    });
    req.end();
  });
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
