import { UserInputError } from "./http.js";

export interface PdfText {
  totalPages: number;
  pages: string[];
}

/** PDF'ten sayfa sayfa metin çıkarır (unpdf / pdf.js, tembel yükleme). */
export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  let mod: typeof import("unpdf");
  try {
    mod = await import("unpdf");
  } catch (err) {
    throw new UserInputError(
      `PDF okuma modülü yüklenemedi (${err instanceof Error ? err.message : String(err)}). Datasheet'i download_datasheet ile indirip açabilirsiniz.`,
    );
  }
  const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
  if (!head.includes("%PDF")) {
    throw new UserInputError("İndirilen dosya bir PDF değil (sunucu farklı bir içerik döndürdü).");
  }
  // pdf.js veriyi devralabildiği için kopyası verilir (önbellekteki tampon bozulmasın).
  // verbosity: 0 → pdf.js uyarıları console.log ile stdout'a (MCP kanalına) yazılmasın.
  const pdf = await mod.getDocumentProxy(new Uint8Array(data), { verbosity: 0, isEvalSupported: false });
  try {
    const { totalPages, text } = await mod.extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((t) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
    return { totalPages, pages };
  } catch (err) {
    throw new UserInputError(`PDF okunamadı (bozuk veya şifreli olabilir): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Belge kaynaklarını (sayfalar, sahte worker) serbest bırak.
    await pdf.destroy().catch(() => undefined);
  }
}

/** "1-3,7,10-" gibi sayfa aralığı ifadesini 1 tabanlı sayfa listesine çevirir. */
export function parsePageRange(spec: string | undefined, totalPages: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const start = m[1] ? Number(m[1]) : 1;
      const end = m[2] ? Number(m[2]) : totalPages;
      for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) pages.add(i);
    } else if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n >= 1 && n <= totalPages) pages.add(n);
    } else {
      throw new UserInputError(`Geçersiz sayfa aralığı: "${spec}". Örnek: "1-3,7".`);
    }
  }
  if (!pages.size) throw new UserInputError(`"${spec}" aralığında sayfa yok (toplam ${totalPages} sayfa).`);
  return [...pages].sort((a, b) => a - b);
}

/**
 * Metni karşılaştırma için sadeleştirir (küçük harf, aksansız, tek boşluk) ve
 * sadeleştirilmiş her karakterin orijinal metindeki konumunu döndürür.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    let f = c === "İ" || c === "I" || c === "ı" ? "i" : c.toLowerCase();
    f = f.normalize("NFD").charAt(0) || c;
    if (/\s/.test(f)) {
      if (prevSpace) continue;
      f = " ";
      prevSpace = true;
    } else {
      prevSpace = false;
    }
    folded += f.length === 1 ? f : c;
    map.push(i);
  }
  return { folded, map };
}

export interface PageHit {
  page: number;
  hits: number;
  snippets: string[];
}

/** Sayfalarda anahtar kelimeleri arar; her sayfa için eşleşme sayısı ve kısa alıntılar döndürür. */
export function searchPages(pages: string[], query: string, snippetRadius = 160): PageHit[] {
  const terms = query
    .split(/[,;|]/)
    .flatMap((t) => (t.trim().includes(" ") ? [t.trim()] : t.trim().split(/\s+/)))
    .map((t) => foldWithMap(t.trim()).folded)
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const out: PageHit[] = [];
  pages.forEach((text, i) => {
    const { folded, map } = foldWithMap(text);
    let hits = 0;
    const snippets: string[] = [];
    for (const term of terms) {
      let idx = folded.indexOf(term);
      while (idx !== -1) {
        hits++;
        if (snippets.length < 3) {
          const from = map[idx] ?? 0;
          const to = (map[idx + term.length - 1] ?? from) + 1;
          const start = Math.max(0, from - snippetRadius);
          const end = Math.min(text.length, to + snippetRadius);
          snippets.push(`…${text.slice(start, end).replace(/\s+/g, " ").trim()}…`);
        }
        idx = folded.indexOf(term, idx + term.length);
      }
    }
    if (hits) out.push({ page: i + 1, hits, snippets });
  });
  return out.sort((a, b) => b.hits - a.hits || a.page - b.page);
}
