/**
 * Türkçe karakterleri ve aksanları sadeleştirerek karşılaştırma anahtarı üretir.
 * "Kılıf / Kasa" -> "kilif / kasa", "Mikroişlemciler" -> "mikroislemciler"
 */
export function fold(input: string): string {
  return input
    .replace(/[İI]/g, "i")
    .replace(/ı/g, "i")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/µ/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

/** Karşılaştırma için yalnızca harf ve rakamları bırakır: "SOT-23 (3)" -> "sot233" */
export function compact(input: string): string {
  return fold(input).replace(/[^a-z0-9]+/g, "");
}

/** Bir arama ifadesini kelimelere böler (katlanmış). */
export function tokens(input: string): string[] {
  return fold(input)
    .split(/[^a-z0-9.+%-]+/)
    .filter((t) => t.length > 0);
}

/** Basit Levenshtein uzaklığı (kısa dizgiler için). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Bir sorgunun bir metne ne kadar benzediğini 0..1 arası puanlar.
 * Tam eşleşme > önek > tüm kelimeleri içerme > kısmi kelime > yazım benzerliği.
 */
export function similarity(query: string, text: string): number {
  const q = fold(query);
  const t = fold(text);
  if (!q || !t) return 0;
  if (q === t) return 1;
  const qc = compact(query);
  const tc = compact(text);
  if (qc && qc === tc) return 0.98;
  if (t.startsWith(q)) return 0.9;
  const qTokens = tokens(query);
  const tTokens = tokens(text);
  if (qTokens.length === 0) return 0;
  const hits = qTokens.filter((qt) => tTokens.some((tt) => tt.startsWith(qt) || (qt.length >= 4 && tt.includes(qt))));
  if (hits.length === qTokens.length) return 0.75 + 0.1 * Math.min(1, qTokens.length / Math.max(tTokens.length, 1));
  if (t.includes(q) || (qc.length >= 3 && tc.includes(qc))) return 0.7;
  // Küçük yazım farklarına (ör. "lar"/"ler", "regulator"/"regülatör") tolerans
  const fuzzyHits = qTokens.filter((qt) =>
    tTokens.some(
      (tt) =>
        tt.startsWith(qt) ||
        (qt.length >= 4 && tt.includes(qt)) ||
        (qt.length >= 3 && Math.abs(tt.length - qt.length) <= 1 && levenshtein(qt, tt) <= (qt.length >= 7 ? 2 : 1)),
    ),
  );
  if (fuzzyHits.length === qTokens.length) return 0.7 + 0.1 * Math.min(1, qTokens.length / Math.max(tTokens.length, 1));
  const partial = fuzzyHits.length / qTokens.length;
  let fuzzy = 0;
  for (const qt of qTokens) {
    if (qt.length < 4) continue;
    for (const tt of tTokens) {
      const d = levenshtein(qt, tt.slice(0, qt.length + 1));
      if (d <= Math.floor(qt.length / 4)) fuzzy = Math.max(fuzzy, 0.45);
    }
  }
  return Math.max(partial * 0.6, fuzzy);
}

/** Dizgiyi belirtilen uzunlukta keser. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** HTML etiketlerini kaldırıp düz metne çevirir. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
