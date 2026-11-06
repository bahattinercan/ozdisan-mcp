import { describe, expect, it } from "vitest";
import {
  findProperty,
  findUnit,
  isNumericProperty,
  matchValues,
  propertyValues,
  resolveFilters,
} from "../../src/filters.js";
import { UserInputError } from "../../src/http.js";
import type { RawListResponse } from "../../src/types.js";
import { fixture } from "../helpers.js";

const meta = fixture<RawListResponse>("list-279.json");
const props = meta.propertyFilters!;

function byName(name: string) {
  const p = props.find((x) => x.name === name);
  if (!p) throw new Error(`fixture'da ${name} yok`);
  return p;
}

describe("findProperty", () => {
  it("Türkçe adla bulur (büyük/küçük harf ve aksan duyarsız)", () => {
    expect(findProperty(props, "kilif / kasa")?.name).toBe("Kılıf / Kasa");
    expect(findProperty(props, "ÇIKIŞ AKIMI")?.name).toBe("Çıkış Akımı");
  });

  it("kimlikle bulur", () => {
    const p = byName("Montaj Tipi");
    expect(findProperty(props, p.propertyId)?.name).toBe("Montaj Tipi");
  });

  it("özel özellikleri takma adlarla bulur", () => {
    expect(findProperty(props, "manufacturer")?.propertyId).toBe("Manufacturer");
    expect(findProperty(props, "üretici")?.propertyId).toBe("Manufacturer");
  });

  it("noktalama farkını tolere eder", () => {
    expect(findProperty(props, "Kılıf/Kasa")?.name).toBe("Kılıf / Kasa");
  });

  it("bilinmeyen özellik için undefined döner", () => {
    expect(findProperty(props, "Uçuş Hızı")).toBeUndefined();
  });
});

describe("matchValues", () => {
  const pkg = byName("Kılıf / Kasa");

  it("tam değer eşleşmesi", () => {
    const first = propertyValues(pkg)[0]!;
    expect(matchValues(pkg, [first.toLowerCase()])).toEqual([first]);
  });

  it("contains modunda tüm içeren seçenekleri seçer", () => {
    const all = propertyValues(pkg);
    const wanted = all.find((v) => /DFN/i.test(v));
    expect(wanted).toBeDefined();
    const res = matchValues(pkg, ["dfn"], "contains");
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res.every((v) => /dfn/i.test(v))).toBe(true);
  });

  it("olmayan değerde öneri listesiyle hata verir", () => {
    try {
      matchValues(pkg, ["DFN"], "exact");
      // Bazı kategorilerde "DFN" tam seçenek olabilir; o durumda hata beklenmez.
    } catch (err) {
      expect(err).toBeInstanceOf(UserInputError);
      const details = (err as UserInputError).details as { suggestions: string[] };
      expect(details.suggestions.length).toBeGreaterThan(0);
    }
    expect(() => matchValues(pkg, ["KESINLIKLE-OLMAYAN-KILIF"])).toThrow(UserInputError);
  });
});

describe("findUnit", () => {
  it("birim sembolüyle bulur", () => {
    const current = byName("Çıkış Akımı");
    expect(isNumericProperty(current)).toBe(true);
    expect(findUnit(current, "mA")?.unit.symbol).toBe("mA");
    expect(findUnit(current, "ma")?.unit.symbol).toBe("mA");
    // "MA" (mega) asla "mA" (mili) olarak yorumlanmamalı
    expect(findUnit(current, "MA")).toBeUndefined();
    expect(findUnit(current, "parsek")).toBeUndefined();
  });
});

describe("resolveFilters", () => {
  it("değer, aralık, üretici ve bayrakları sitenin istek biçimine çevirir", () => {
    const res = resolveFilters(meta, {
      filters: [{ property: "Montaj Tipi", values: ["SMT"] }],
      ranges: [{ property: "Çıkış Akımı", min: 500, unit: "mA" }],
      manufacturers: [propertyValues(byName("Üretici Firma"))[0]!],
      flags: { in_stock: true, rohs: true, has_datasheet: true },
    });
    expect(res.valueFilters).toContainEqual({ propertyId: byName("Montaj Tipi").propertyId, values: ["SMT"] });
    expect(res.valueFilters.some((v) => v.propertyId === "Manufacturer")).toBe(true);
    const range = res.numericValueFilters[0]!;
    expect(range.propertyId).toBe(byName("Çıkış Akımı").propertyId);
    expect(range.lower).toBe(500);
    expect(range.upper).toBeUndefined();
    expect(range.unitId).toBe(findUnit(byName("Çıkış Akımı"), "mA")!.unit.id);
    expect(res.filterOptions).toEqual([
      { code: "stockingOptions", value: "InStock" },
      { code: "environmentalOptions", value: "Rohs" },
      { code: "documentOptions", value: "Datasheet" },
    ]);
    expect(res.applied.length).toBe(6);
  });

  it("aynı özelliğe ait değerleri tek filtrede birleştirir (VEYA)", () => {
    const res = resolveFilters(meta, {
      filters: [
        { property: "Montaj Tipi", values: ["SMT"] },
        { property: "montaj tipi", values: ["THT"] },
      ],
    });
    expect(res.valueFilters).toHaveLength(1);
    expect(res.valueFilters[0]!.values.sort()).toEqual(["SMT", "THT"]);
  });

  it("birimsiz aralık temel birimle gönderilir", () => {
    const res = resolveFilters(meta, { ranges: [{ property: "Çıkış Akımı", min: 0.5 }] });
    expect(res.numericValueFilters[0]).toEqual({ propertyId: byName("Çıkış Akımı").propertyId, lower: 0.5 });
  });

  it("sayısal olmayan özellikte aralık reddedilir", () => {
    expect(() => resolveFilters(meta, { ranges: [{ property: "Montaj Tipi", min: 1 }] })).toThrow(/sayısal/);
  });

  it("min > max reddedilir", () => {
    expect(() => resolveFilters(meta, { ranges: [{ property: "Çıkış Akımı", min: 5, max: 1 }] })).toThrow(UserInputError);
  });

  it("bilinmeyen özellik kullanılabilir özellikleri listeler", () => {
    try {
      resolveFilters(meta, { filters: [{ property: "Renk Sıcaklığı", values: ["3000K"] }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UserInputError);
      expect(((err as UserInputError).details as { available_properties: string[] }).available_properties).toContain("Kılıf / Kasa");
    }
  });

  it("tanınmayan birimde geçerli birimleri önerir", () => {
    try {
      resolveFilters(meta, { ranges: [{ property: "Çıkış Akımı", min: 1, unit: "kV" }] });
      expect.unreachable();
    } catch (err) {
      expect(((err as UserInputError).details as { units: string[] }).units).toContain("mA");
    }
  });
});

describe("değer eşleştirmede sessiz yanlış seçim olmaması", () => {
  const voltage = {
    propertyId: "v",
    name: "Çıkış Voltajı",
    values: ["-5 V", "5 V", "1.2 V", "12 V", "-12 V", "15 V", "1.5 V", "33 V", "10 mΩ", "10 MΩ"].map((value) => ({ value })),
    meta: { propertyType: { id: 1, isNumeric: true } },
  };

  it("boşluksuz yazımı doğru seçeneğe eşler; işaret ve ondalığı korur", () => {
    expect(matchValues(voltage, ["5V"])).toEqual(["5 V"]);
    expect(matchValues(voltage, ["12V"])).toEqual(["12 V"]);
    expect(matchValues(voltage, ["1.5V"])).toEqual(["1.5 V"]);
    expect(matchValues(voltage, ["-5V"])).toEqual(["-5 V"]);
  });

  it("olmayan değeri benzer bir sayıyla değiştirmez", () => {
    expect(() => matchValues(voltage, ["3.3V"])).toThrow(UserInputError);
  });

  it("milli ve mega ön eklerini karıştırmaz", () => {
    expect(matchValues(voltage, ["10mΩ"])).toEqual(["10 mΩ"]);
    expect(matchValues(voltage, ["10MΩ"])).toEqual(["10 MΩ"]);
  });

  it("contains modunda sayı sınırlarına uyar", () => {
    expect(matchValues(voltage, ["5 V"], "contains")).toEqual(["5 V"]);
    expect(matchValues(voltage, ["1.5"], "contains")).toEqual(["1.5 V"]);
  });

  it("µ/u yazımlarını eşdeğer sayar", () => {
    const cap = { propertyId: "c", name: "Kapasitans", values: [{ value: "10 µF" }, { value: "100 nF" }] };
    expect(matchValues(cap, ["10uF"])).toEqual(["10 µF"]);
  });

  it("miliohm birimini megaohm'a çevirmez", () => {
    const r = {
      propertyId: "r",
      name: "Direnç",
      values: [],
      meta: {
        propertyType: { id: 1, isNumeric: true },
        measurement: {
          id: "m",
          units: [
            { unit: { id: "1", name: "Ohm", symbol: "Ω" } },
            { unit: { id: "2", name: "Kilo Ohm", symbol: "kΩ" } },
            { unit: { id: "3", name: "Mega Ohm", symbol: "MΩ" } },
          ],
        },
      },
    };
    expect(findUnit(r, "mOhm")).toBeUndefined();
    expect(findUnit(r, "mΩ")).toBeUndefined();
    expect(findUnit(r, "MOhm")?.unit.symbol).toBe("MΩ");
    expect(findUnit(r, "kohm")?.unit.symbol).toBe("kΩ");
    expect(findUnit(r, "ohm")?.unit.symbol).toBe("Ω");
  });
});

