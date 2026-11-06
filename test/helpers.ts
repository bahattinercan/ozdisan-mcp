import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export function tempDir(prefix = "ozdisan-mcp-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Ağ beklemesi olmadan, disk önbelleği kapalı test yapılandırması. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    diskCache: false,
    minIntervalMs: 0,
    timeoutMs: 5_000,
    cacheDir: tempDir("ozdisan-cache-"),
    downloadDir: tempDir("ozdisan-dl-"),
    ...overrides,
  });
}

export interface MockRoute {
  match: (url: string, init: RequestInit | undefined, body: any) => boolean;
  respond: (url: string, body: any) => Response | Promise<Response>;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

export function nextDataPage(pageProps: unknown): string {
  return `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps },
  })}</script></body></html>`;
}

/** global fetch yerine geçen, istekleri kaydeden sahte uygulama. */
export function mockFetch(routes: MockRoute[]) {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find((r) => r.match(url, init, body));
    if (!route) return new Response(`no mock for ${url}`, { status: 404 });
    return route.respond(url, body);
  };
  return { impl, calls };
}
