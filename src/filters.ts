import { UserInputError } from "./http.js";
import { compact, fold, similarity } from "./text.js";
import type { RawCommonFilter, RawListResponse, RawMeasurementUnit, RawPropertyFilter } from "./types.js";

export interface ValueFilterSpec {
  property: string;
  values: string[];
  match?: "exact" | "contains";
}

export interface RangeFilterSpec {
  property: string;
  min?: number;
  max?: number;
  unit?: string;
}

export interface FlagSpec {
  in_stock?: boolean;
  has_upcoming_stock?: boolean;
  rohs?: boolean;
  has_datasheet?: boolean;
  has_image?: boolean;
  discounted?: boolean;
}

export interface ResolvedFilters {
  valueFilters: Array<{ propertyId: string; values: string[] }>;
  numericValueFilters: Array<Record<string, unknown>>;
  filterOptions: Array<{ code: string; value: string }>;
  /** İnsan tarafından okunabilir uygulanan filtre özeti. */
  applied: string[];
}

/** Sitenin özel (GUID olmayan) özellik kimlikleri ve kabul edilen takma adları. */
const SPECIAL_PROPERTIES: Record<string, string[]> = {
  Manufacturer: ["manufacturer", "uretici", "uretici firma", "marka", "brand", "maker"],
  ProductStatus: ["productstatus", "product status", "urun durumu", "durum", "status", "lifecycle"],
  VariantPackageType: ["variantpackagetype", "package type", "paket tipi", "paketleme", "packaging"],
};

/**
 * ASCII birim yazımları → sitedeki sembol. Büyük/küçük harf duyarlıdır: "mOhm" miliohm, "MOhm" megaohm'dur.
 */
const UNIT_ALIASES: Record<string, string> = {
  ohm: "Ω",
  Ohm: "Ω",
  ohms: "Ω",
  Ohms: "Ω",
  R: "Ω",
  kohm: "kΩ",
  kOhm: "kΩ",
  kR: "kΩ",
  K: "kΩ",
  mohm: "mΩ",
  mOhm: "mΩ",
  Mohm: "MΩ",
  MOhm: "MΩ",
  MR: "MΩ",
  "°c": "°C",
  C: "°C",
  degC: "°C",
  celsius: "°C",
  Celsius: "°C",
};

/** Değer karşılaştırma anahtarı: yalnızca boşlukları kaldırır, µ/μ/u ön ekini birleştirir. Nokta, işaret ve harf büyüklüğü korunur. */
export function valueKey(input: string): string {
  return input
    .normalize("NFC")
    .replace(/μ/g, "µ")
    .replace(/(^|[^A-Za-z])u(?=[A-Za-zΩ])/g, "$1µ")
    .replace(/\s+/g, "");
}

/** İlk karakter m/M ise onu koruyarak, geri kalanını büyük/küçük harf duyarsız karşılaştırır (milli ≠ mega). */
function caseInsensitiveSafe(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  if (/[mM]/.test(a[0]!) || /[mM]/.test(b[0]!)) {
    if (a[0] !== b[0]) return false;
    return a.slice(1).toLowerCase() === b.slice(1).toLowerCase();
  }
  return a.toLowerCase() === b.toLowerCase();
}

/** Sayısal sınırlara dikkat ederek içerme kontrolü: "5V" → "15V" veya "-5V" içinde sayılmaz. */
export function containsValue(haystack: string, needle: string, caseSensitive: boolean): boolean {
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  if (!n) return false;
  let idx = h.indexOf(n);
  while (idx !== -1) {
    const before = h[idx - 1];
    const after = h[idx + n.length];
    const startsNumeric = /[0-9.]/.test(n[0]!);
    const endsNumeric = /[0-9]/.test(n[n.length - 1]!);
    const leftOk = !startsNumeric || before === undefined || !/[0-9.+\-±]/.test(before);
    const rightOk = !endsNumeric || after === undefined || !(/[0-9]/.test(after) || (after === "." && /[0-9]/.test(h[idx + n.length + 1] ?? "")));
    if (leftOk && rightOk) return true;
    idx = h.indexOf(n, idx + 1);
  }
  return false;
}

export function propertyValues(p: RawPropertyFilter): string[] {
  const raw = p.values ?? (p as unknown as { options?: Array<{ value: string }> }).options ?? [];
  return raw.map((v) => v.value);
}

export function isNumericProperty(p: RawPropertyFilter): boolean {
  return !!p.meta?.propertyType?.isNumeric;
}

export function propertyUnits(p: RawPropertyFilter): RawMeasurementUnit[] {
  return p.meta?.measurement?.units ?? [];
}

/** Bir özelliği kimlik, ad veya takma adla bulur. */
export function findProperty(props: RawPropertyFilter[], query: string): RawPropertyFilter | undefined {
  const q = query.trim();
  const byId = props.find((p) => p.propertyId.toLowerCase() === q.toLowerCase());
  if (byId) return byId;
  const fq = fold(q);
  for (const [id, aliases] of Object.entries(SPECIAL_PROPERTIES)) {
    if (aliases.includes(fq)) {
      const found = props.find((p) => p.propertyId === id);
      if (found) return found;
    }
  }
  const byName = props.find((p) => fold(p.name) === fq);
  if (byName) return byName;
  const cq = compact(q);
  const byCompact = props.find((p) => compact(p.name) === cq);
  if (byCompact) return byCompact;
  const scored = props
    .map((p) => ({ p, s: similarity(q, p.name) }))
    .filter((x) => x.s >= 0.75)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 1 || (scored[0] && scored[1] && scored[0].s - scored[1].s >= 0.1)) return scored[0]?.p;
  return undefined;
}

function unknownProperty(props: RawPropertyFilter[], query: string): UserInputError {
  const ranked = props
    .map((p) => ({ name: p.name, id: p.propertyId, s: similarity(query, p.name) }))
    .sort((a, b) => b.s - a.s);
  return new UserInputError(
    `Bu kategoride "${query}" adlı bir filtre özelliği yok. Kullanılabilir özellikler 'available_properties' içinde (get_category_filters ile ayrıntı alın).`,
    { available_properties: ranked.map((r) => r.name) },
  );
}

/**
 * İstenen değerleri özelliğin mevcut seçenekleriyle eşleştirir.
 * Ondalık nokta, eksi işareti ve SI ön ekinin harf büyüklüğü (m/M) hiçbir zaman yok sayılmaz;
 * yanlış bir değeri sessizce seçmektense öneri listesiyle hata vermek tercih edilir.
 */
export function matchValues(
  property: RawPropertyFilter,
  wanted: string[],
  mode: "exact" | "contains" = "exact",
): string[] {
  const options = propertyValues(property);
  const keyed = options.map((o) => ({ o, k: valueKey(o) }));
  const out = new Set<string>();
  for (const w of wanted) {
    const kw = valueKey(w);
    let hits = keyed.filter((x) => x.o.trim() === w.trim()).map((x) => x.o);
    if (!hits.length) hits = keyed.filter((x) => x.k === kw).map((x) => x.o);
    if (!hits.length) {
      // Büyük/küçük harf farkı yalnızca tek ve m/M karışıklığı içermeyen bir eşleşme varsa kabul edilir.
      const ci = keyed.filter((x) => caseInsensitiveSafe(x.k, kw)).map((x) => x.o);
      if (ci.length === 1) hits = ci;
    }
    if (!hits.length && mode === "contains" && kw) {
      hits = keyed.filter((x) => containsValue(x.k, kw, true)).map((x) => x.o);
      if (!hits.length) hits = keyed.filter((x) => containsValue(x.k, kw, false)).map((x) => x.o);
    }
    if (!hits.length) {
      const cw = compact(w);
      const suggestions = options
        .map((o) => ({ o, s: Math.max(similarity(w, o), cw && compact(o).includes(cw) ? 0.8 : 0) }))
        .filter((x) => x.s > 0.3)
        .sort((a, b) => b.s - a.s)
        .slice(0, 15)
        .map((x) => x.o);
      throw new UserInputError(
        `"${property.name}" özelliğinde "${w}" değeri yok.` +
          (suggestions.length
            ? ` Benzer seçenekler 'suggestions' içinde; değeri aynen kopyalayın veya kısmi eşleşme için match: "contains" kullanın.`
            : ` Tüm seçenekler için get_category_filters aracını property parametresiyle çağırın.`) +
          (isNumericProperty(property) ? " Sayısal özelliklerde 'ranges' ile aralık filtresi daha güvenilirdir." : ""),
        { property: property.name, suggestions },
      );
    }
    for (const h of hits) out.add(h);
  }
  return [...out];
}

/** Birim sembolünü özelliğin birimleriyle eşleştirir; m (milli) ve M (mega) asla karıştırılmaz. */
export function findUnit(property: RawPropertyFilter, unit: string): RawMeasurementUnit | undefined {
  const units = propertyUnits(property);
  const u = unit.trim();
  const target = valueKey(UNIT_ALIASES[u] ?? u);
  const exact = units.find((x) => valueKey(x.unit.symbol) === target);
  if (exact) return exact;
  const ci = units.filter((x) => caseInsensitiveSafe(valueKey(x.unit.symbol), target));
  if (ci.length === 1) return ci[0];
  return units.find((x) => fold(x.unit.name) === fold(u));
}

/** Kullanıcı filtrelerini sitenin beklediği istek gövdesine dönüştürür. */
export function resolveFilters(
  meta: Pick<RawListResponse, "propertyFilters" | "commonFilters">,
  input: {
    filters?: ValueFilterSpec[];
    ranges?: RangeFilterSpec[];
    manufacturers?: string[];
    flags?: FlagSpec;
  },
): ResolvedFilters {
  const props = meta.propertyFilters ?? [];
  const result: ResolvedFilters = { valueFilters: [], numericValueFilters: [], filterOptions: [], applied: [] };
  const valueMap = new Map<string, Set<string>>();

  const addValues = (prop: RawPropertyFilter, values: string[]) => {
    const set = valueMap.get(prop.propertyId) ?? new Set<string>();
    for (const v of values) set.add(v);
    valueMap.set(prop.propertyId, set);
  };

  if (input.manufacturers?.length) {
    const prop = props.find((p) => p.propertyId === "Manufacturer");
    if (!prop) throw new UserInputError("Bu kategoride üretici filtresi bulunmuyor.");
    const values = matchValues(prop, input.manufacturers, "exact");
    addValues(prop, values);
    result.applied.push(`${prop.name}: ${values.join(", ")}`);
  }

  for (const spec of input.filters ?? []) {
    if (!spec.values?.length) continue;
    const prop = findProperty(props, spec.property);
    if (!prop) throw unknownProperty(props, spec.property);
    const values = matchValues(prop, spec.values, spec.match ?? "exact");
    addValues(prop, values);
    result.applied.push(`${prop.name}: ${values.join(", ")}`);
  }

  for (const [propertyId, values] of valueMap) {
    result.valueFilters.push({ propertyId, values: [...values] });
  }

  for (const range of input.ranges ?? []) {
    if (range.min === undefined && range.max === undefined) continue;
    const prop = findProperty(props, range.property);
    if (!prop) throw unknownProperty(props, range.property);
    if (!isNumericProperty(prop)) {
      throw new UserInputError(
        `"${prop.name}" sayısal bir özellik değil; aralık yerine 'filters' ile değer seçin.`,
        { property: prop.name, sample_values: propertyValues(prop).slice(0, 20) },
      );
    }
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
      throw new UserInputError(`"${prop.name}" için min (${range.min}) max'tan (${range.max}) büyük olamaz.`);
    }
    const entry: Record<string, unknown> = { propertyId: prop.propertyId };
    if (range.min !== undefined) entry.lower = range.min;
    if (range.max !== undefined) entry.upper = range.max;
    let unitLabel = "temel birim";
    if (range.unit) {
      const unit = findUnit(prop, range.unit);
      if (!unit) {
        throw new UserInputError(
          `"${prop.name}" için "${range.unit}" birimi tanınmadı.`,
          { property: prop.name, units: propertyUnits(prop).map((u) => u.unit.symbol) },
        );
      }
      entry.unitId = unit.unit.id;
      if (unit.isBase !== undefined) entry.isBase = unit.isBase;
      if (unit.isFormula !== undefined) entry.isFormula = unit.isFormula;
      if (unit.conversionFactor !== undefined) entry.conversionFactor = unit.conversionFactor;
      unitLabel = unit.unit.symbol;
    }
    result.numericValueFilters.push(entry);
    result.applied.push(
      `${prop.name}: ${range.min ?? "-∞"} … ${range.max ?? "+∞"} ${range.unit ? unitLabel : "(temel birim)"}`,
    );
  }

  const flags = input.flags ?? {};
  const common = meta.commonFilters ?? [];
  const pushOption = (code: string, value: string, label: string) => {
    const group = common.find((c) => c.code === code);
    // Grup sitede tanımlıysa ve seçenek varsa ekle; meta eksikse yine de dene.
    if (group && !group.options.some((o) => o.value === value)) return;
    result.filterOptions.push({ code, value });
    result.applied.push(label);
  };
  if (flags.in_stock) pushOption("stockingOptions", "InStock", "Stokta var");
  if (flags.has_upcoming_stock) pushOption("stockingOptions", "HasUpcomingStock", "Gelecek stok var");
  if (flags.rohs === true) pushOption("environmentalOptions", "Rohs", "RoHS uyumlu");
  if (flags.rohs === false) pushOption("environmentalOptions", "NonRohs", "RoHS belgesiz");
  if (flags.has_datasheet) pushOption("documentOptions", "Datasheet", "Datasheet mevcut");
  if (flags.has_image) pushOption("documentOptions", "Picture", "Fotoğraf mevcut");
  if (flags.discounted) pushOption("additionalOptions", "DiscountedProduct", "Kampanyalı ürün");

  return result;
}
