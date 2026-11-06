import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OzdisanClient } from "../api.js";
import { CURRENCIES, LANGUAGES, type Currency, type Language } from "../config.js";
import { CancelledError, OzdisanError, runWithSignal, throwIfCancelled, UserInputError } from "../http.js";
import { clean } from "../normalize.js";

export interface ToolContext {
  client: OzdisanClient;
}

export const currencySchema = z
  .enum(CURRENCIES as [Currency, ...Currency[]])
  .optional()
  .describe("Price currency: TRY (default), USD or EUR. Prices are unit prices excluding VAT.");

export const languageSchema = z
  .enum(LANGUAGES as [Language, ...Language[]])
  .optional()
  .describe("Language of category/property names: 'tr' (Turkish, default) or 'en' (English).");

export const productInputSchema = z
  .string()
  .min(1)
  .describe(
    "Product identifier. Accepts the Özdisan product code (the numeric 'product' field returned by other tools, e.g. '368374'), " +
      "a product URL from ozdisan.com, or an exact manufacturer part number (e.g. 'STM32F103C8T6').",
  );

export const categoryInputSchema = z
  .string()
  .min(1)
  .describe(
    "Category identifier. Best: the 'category' slug returned by search_categories/browse_categories (e.g. 'mikroislemciler-218'). " +
      "Also accepts the numeric category id ('218'), a category URL, or a category name in Turkish or English ('Mikroişlemciler' / 'Microcontrollers').",
  );

export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(clean(data)) }] };
}

export function fail(error: unknown): CallToolResult {
  if (error instanceof UserInputError) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(clean({ error: error.message, ...(error.details as object | undefined) })) }],
    };
  }
  if (error instanceof CancelledError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error.message }) }] };
  }
  if (error instanceof OzdisanError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error.message,
            hint: "Özdisan sitesine erişimde sorun oluştu. Biraz sonra tekrar deneyin; sorun sürerse internet bağlantınızı kontrol edin.",
          }),
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `Beklenmeyen hata: ${message}` }) }] };
}

/** MCP SDK'nın araç işleyicisine verdiği ek bilgiler (iptal sinyali, ilerleme belirteci, bildirim gönderme). */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** İlerleme bildirimi gönderir (istemci progressToken verdiyse). Hatalar yok sayılır. */
export function reportProgress(extra: ToolExtra | undefined, progress: number, total: number, message?: string): void {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra) return;
  extra
    .sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })
    .catch(() => undefined);
}

/**
 * Araç işleyicilerini ortak hata yönetimiyle sarar. İstemcinin iptal sinyali tüm HTTP isteklerine aktarılır;
 * böylece iptal edilen/zaman aşımına uğrayan çağrılar arka planda siteyi meşgul etmeye devam etmez.
 */
export function handle<A>(fn: (args: A, extra: ToolExtra) => Promise<unknown>): (args: A, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args: A, extra: ToolExtra) => {
    try {
      return ok(await runWithSignal(extra?.signal, () => fn(args, extra)));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Bir dizi işi sırayı koruyarak, belirli eşzamanlılıkla çalıştırır; iptal edilirse yeni iş başlatmaz. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      throwIfCancelled();
      const i = next++;
      results[i] = await fn(items[i]!, i);
      completed++;
      onDone?.(completed, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}
