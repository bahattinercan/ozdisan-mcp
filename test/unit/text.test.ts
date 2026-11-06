import { describe, expect, it } from "vitest";
import { compact, fold, levenshtein, similarity, stripHtml, tokens, truncate } from "../../src/text.js";

describe("fold / compact", () => {
  it("Türkçe karakterleri sadeleştirir", () => {
    expect(fold("Kılıf / Kasa")).toBe("kilif / kasa");
    expect(fold("Mikroİşlemciler")).toBe("mikroislemciler");
    expect(fold("  ÇIKIŞ   Akımı ")).toBe("cikis akimi");
    expect(fold("Güç Yarı İletkenleri")).toBe("guc yari iletkenleri");
  });

  it("µ işaretini u olarak ele alır", () => {
    expect(fold("10µF")).toBe("10uf");
  });

  it("compact yalnızca harf ve rakam bırakır", () => {
    expect(compact("SOT-23 (3)")).toBe("sot233");
    expect(compact("stm32f103c8t6")).toBe(compact("STM32F103C8T6"));
    expect(compact("LM317 T")).toBe("lm317t");
  });

  it("tokens kelimelere böler", () => {
    expect(tokens("Lineer Voltaj Regülatörleri")).toEqual(["lineer", "voltaj", "regulatorleri"]);
  });
});

describe("similarity", () => {
  it("tam eşleşmeye 1 verir", () => {
    expect(similarity("Mikroişlemciler", "Mikroislemciler")).toBe(1);
  });

  it("önek eşleşmesini yüksek puanlar", () => {
    expect(similarity("Mikro", "Mikroişlemciler")).toBeGreaterThanOrEqual(0.9);
  });

  it("tüm kelimeleri içeren metni yüksek puanlar", () => {
    expect(similarity("voltaj regülatör", "Lineer Voltaj Regülatörleri")).toBeGreaterThan(0.7);
  });

  it("küçük yazım farklarını tolere eder", () => {
    expect(similarity("Entegre Devreler (IC lar)", "Entegre Devreler (IC'ler)")).toBeGreaterThanOrEqual(0.7);
  });

  it("alakasız metne düşük puan verir", () => {
    expect(similarity("kondansatör", "Mikroişlemciler")).toBeLessThan(0.4);
  });
});

describe("yardımcılar", () => {
  it("levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("truncate", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("stripHtml", () => {
    expect(stripHtml("<p>Merhaba&nbsp;<strong>dünya</strong></p><p>2</p>")).toBe("Merhaba dünya\n2");
  });
});
