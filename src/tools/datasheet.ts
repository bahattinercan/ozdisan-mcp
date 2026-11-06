import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeDecode, type OzdisanClient } from "../api.js";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { expandPath, type Language } from "../config.js";
import { isOzdisanHost, UserInputError } from "../http.js";
import { extractPdfText, parsePageRange, searchPages } from "../pdf.js";
import { truncate } from "../text.js";
import { handle, languageSchema, productInputSchema, readOnlyAnnotations, type ToolContext } from "./shared.js";

interface DatasheetTarget {
  product?: string;
  partNumber?: string;
  manufacturer?: string;
  url: string;
  fileName: string;
  isExternal: boolean;
}

async function resolveDatasheet(client: OzdisanClient, product: string, lang: Language): Promise<DatasheetTarget> {
  const { page } = await client.loadProduct(product, lang);
  const d = page.data;
  const media = d.medias?.find((m) => m.field === "Datasheet")?.path;
  if (!media) {
    throw new UserInputError(`${d.sku} (${d.manufacturer?.name ?? ""}) için Özdisan'da datasheet bulunmuyor.`, {
      product: d.erpRefId,
      url: page.url,
    });
  }
  const ds = await client.resolveDatasheetUrl(d.sku, media);
  if (!ds) throw new UserInputError(`${d.sku} datasheet adresi çözümlenemedi.`, { product: d.erpRefId, url: page.url });
  const safeSku = d.sku.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return {
    product: d.erpRefId,
    partNumber: d.sku,
    manufacturer: d.manufacturer?.name,
    url: ds.url,
    // Aynı datasheet farklı ürünlerde ortak olabildiğinden dosya adına parça numarası eklenir.
    fileName: `${safeSku}__${ds.fileName}`,
    isExternal: ds.isExternal,
  };
}

function targetFromUrl(url: string): DatasheetTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserInputError(`Geçersiz URL: ${url}`);
  }
  // Ağ denetimi (yerel/özel adres, DNS, yönlendirmeler) indirme sırasında her adımda yapılır.
  const name = safeDecode(parsed.pathname.split("/").pop() || "datasheet.pdf");
  return { url: parsed.toString(), fileName: name, isExternal: !isOzdisanHost(parsed.toString()) };
}

/** Var olan en derin üst klasörün gerçek yolunu (sembolik bağlantılar çözülmüş) bulur ve kalan parçaları ekler. */
export function realpathDeepest(p: string): string {
  let current = resolve(p);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) return join(realpathSync.native(current), ...rest.reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(p);
    rest.push(basename(current));
    current = parent;
  }
}

/** macOS ve Windows'ta dosya sistemi varsayılan olarak büyük/küçük harf duyarsızdır. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";
const BLOCKED_SEGMENTS = new Set(["library", "appdata", "application data", "system32", "windows"]);

/**
 * Model tarafından verilen indirme klasörünü denetler: ev dizini (veya yapılandırılmış indirme klasörü) altında
 * olmalı ve gizli/sistem klasörlerine (".ssh", ".config", "Library" vb.) yazmaya izin verilmez.
 * Denetim, sembolik bağlantılar çözüldükten sonraki gerçek yol üzerinde ve harf duyarsız yapılır;
 * böylece istem enjeksiyonuyla hassas klasörlere dosya yazdırılamaz. Gerçek yol döndürülür.
 */
export function checkDownloadDirectory(input: string, configured: string): string {
  let requested: string;
  try {
    requested = resolve(expandPath(input, "directory"));
  } catch (err) {
    throw new UserInputError((err as Error).message);
  }
  const dir = realpathDeepest(requested);
  const home = realpathDeepest(homedir());
  const base = realpathDeepest(configured);
  const norm = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  const within = (root: string) => {
    const d = norm(dir);
    const r = norm(root);
    return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep);
  };
  const inBase = within(base);
  if (!inBase && !within(home)) {
    throw new UserInputError(`İndirme klasörü ev dizininiz (${home}) altında olmalı. Farklı bir yer için OZDISAN_DOWNLOAD_DIR ayarlayın.`);
  }
  const rel = relative(inBase ? base : home, dir);
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some((seg) => seg.startsWith(".") || BLOCKED_SEGMENTS.has(seg.toLowerCase()))) {
    throw new UserInputError("Gizli veya sistem klasörlerine indirme yapılamaz; ör. ~/Downloads ya da proje klasörünüzü kullanın.");
  }
  return dir;
}

export function registerDatasheetTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;

  server.registerTool(
    "download_datasheet",
    {
      title: "Datasheet indir",
      description:
        "Download a product's datasheet PDF to the local disk and return the file path. Default folder: " +
        "~/Downloads/ozdisan-datasheets (configurable with OZDISAN_DOWNLOAD_DIR or the 'directory' argument). " +
        "Already downloaded files are reused unless overwrite=true. To read the content use read_datasheet.",
      inputSchema: {
        product: productInputSchema,
        directory: z
          .string()
          .optional()
          .describe(
            "Target folder as an absolute path inside the user's home folder ('~/' is expanded), e.g. '~/Projects/board/datasheets'. " +
              "Hidden/system folders are not allowed. Created if missing.",
          ),
        overwrite: z.boolean().optional().describe("Download again even if the file already exists (default false)."),
        language: languageSchema,
      },
      annotations: { ...readOnlyAnnotations, readOnlyHint: false, destructiveHint: false },
    },
    handle(async ({ product, directory, overwrite, language }) => {
      const lang = client.lang(language);
      const target = await resolveDatasheet(client, product, lang);
      const dir = directory?.trim() ? checkDownloadDirectory(directory, client.config.downloadDir) : client.config.downloadDir;
      const file = await client.downloadFile(target.url, dir, target.fileName, { overwrite });
      return {
        product: target.product,
        part_number: target.partNumber,
        manufacturer: target.manufacturer,
        file_path: file.path,
        size_kb: Math.round(file.bytes / 1024),
        already_downloaded: file.cached || undefined,
        source_url: target.url,
      };
    }),
  );

  server.registerTool(
    "read_datasheet",
    {
      title: "Datasheet oku",
      description:
        "Extract text from a product's datasheet PDF so you can read pinouts, absolute maximum ratings, electrical " +
        "characteristics, typical application circuits, package dimensions, etc. Use 'search' to find the relevant pages " +
        "first (e.g. 'pin configuration', 'absolute maximum', 'typical application', 'thermal'), then 'pages' to read them. " +
        "Tables are returned as plain text; figures/diagrams are not included.",
      inputSchema: {
        product: productInputSchema.optional(),
        url: z.string().url().optional().describe("Direct datasheet PDF URL (alternative to 'product')."),
        search: z
          .string()
          .optional()
          .describe("Keywords to locate pages (comma-separated for several terms). Returns matching pages with snippets plus the text of the best pages."),
        pages: z.string().optional().describe("Page range to read, e.g. '1-3,7' (default: from page 1 until max_chars)."),
        max_chars: z.number().int().min(1000).max(150_000).optional().describe("Maximum characters of text to return (default 25000)."),
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ product, url, search, pages, max_chars, language }) => {
      if (!product && !url) throw new UserInputError("'product' veya 'url' parametrelerinden biri gerekli.");
      const lang = client.lang(language);
      const target = product ? await resolveDatasheet(client, product, lang) : targetFromUrl(url!);
      const data = await client.fetchBinary(target.url);
      const pdf = await extractPdfText(data);
      const limit = max_chars ?? 25_000;

      let pageNumbers: number[];
      let matches: ReturnType<typeof searchPages> | undefined;
      if (search && !pages) {
        // En çok eşleşen sayfalar önce (içindekiler sayfası gibi tek geçişli sayfalar sona kalır).
        matches = searchPages(pdf.pages, search);
        pageNumbers = matches.slice(0, 4).map((m) => m.page);
      } else {
        pageNumbers = parsePageRange(pages, pdf.totalPages);
        if (search) matches = searchPages(pdf.pages, search).filter((m) => pageNumbers.includes(m.page));
      }

      const out: Array<{ page: number; text: string }> = [];
      let used = 0;
      let truncated = false;
      for (const n of pageNumbers) {
        const text = pdf.pages[n - 1] ?? "";
        if (used + text.length > limit) {
          const remaining = limit - used;
          if (remaining > 500) out.push({ page: n, text: truncate(text, remaining) });
          truncated = true;
          break;
        }
        out.push({ page: n, text });
        used += text.length;
      }
      const lastPage = out[out.length - 1]?.page;
      const emptyText = pdf.pages.every((p) => p.trim().length === 0);
      return {
        product: target.product,
        part_number: target.partNumber,
        manufacturer: target.manufacturer,
        source_url: target.url,
        total_pages: pdf.totalPages,
        search_results: matches?.slice(0, 10),
        pages: out,
        truncated: truncated || undefined,
        next:
          search && !pages
            ? "Pages are ordered by relevance. Read neighbouring pages with the 'pages' argument if a table continues."
            : truncated && lastPage
            ? `Text limit reached. Continue with pages="${lastPage + (out[out.length - 1]!.text.endsWith("…") ? 0 : 1)}-" or raise max_chars.`
            : !pages && !search && lastPage && lastPage < pdf.totalPages
              ? `Continue with pages="${lastPage + 1}-".`
              : undefined,
        warning: emptyText
          ? "PDF'te seçilebilir metin yok (taranmış görüntü olabilir). Dosyayı download_datasheet ile indirip görüntü olarak inceleyin."
          : search && matches && !matches.length
            ? "Aranan ifade bulunamadı; farklı/İngilizce terimler deneyin."
            : undefined,
      };
    }),
  );
}
