import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_ENTROPY_THRESHOLD,
  ENTROPY_THRESHOLD_ENV,
  MAX_ENTROPY_THRESHOLD,
  resolveEntropyThreshold,
  validateConfig,
} from "../src/core/config";
import { shannonEntropyBitsPerChar } from "../src/entropy";

/** base64 sintética gerada em runtime (gate G6: sem literal de segredo no diff). */
const randomBase64 = (chars: number): string =>
  randomBytes(Math.ceil((chars * 3) / 4)).toString("base64").slice(0, chars);

const validConfig = {
  providers: {
    openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" },
  },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128_000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("shannonEntropyBitsPerChar (ADR-0027, #391 slice 3b)", () => {
  test("string vazia retorna 0 (definido, não lança)", () => {
    expect(shannonEntropyBitsPerChar("")).toBe(0);
  });

  test("texto de um só caractere repetido tem entropia 0", () => {
    expect(shannonEntropyBitsPerChar("a")).toBe(0);
    expect(shannonEntropyBitsPerChar("a".repeat(1000))).toBe(0);
  });

  test("dois caracteres igualmente frequentes dão 1 bit/char", () => {
    expect(shannonEntropyBitsPerChar("ab".repeat(500))).toBeCloseTo(1, 10);
    expect(shannonEntropyBitsPerChar("aä")).toBeCloseTo(1, 10);
  });

  test("base64 aleatória sintética tem entropia acima do default (4.5)", () => {
    const h = shannonEntropyBitsPerChar(randomBase64(4096));
    expect(h).toBeGreaterThan(DEFAULT_ENTROPY_THRESHOLD);
    expect(h).toBeLessThanOrEqual(6); // alfabeto base64: máximo 6 bits/char
  });

  test("texto repetitivo de baixa entropia fica abaixo do default", () => {
    const low = "FOO=bar\nBAZ=qux\n".repeat(200);
    expect(shannonEntropyBitsPerChar(low)).toBeLessThan(DEFAULT_ENTROPY_THRESHOLD);
  });

  test("é determinística e não lança para textos curtos", () => {
    const s = randomBase64(64);
    expect(shannonEntropyBitsPerChar(s)).toBe(shannonEntropyBitsPerChar(s));
    expect(shannonEntropyBitsPerChar("x")).toBe(0);
  });
});

describe("resolveEntropyThreshold (ADR-0027, #391 slice 3b)", () => {
  test("sem config e sem env usa o default conservador documentado", () => {
    expect(resolveEntropyThreshold()).toBe(DEFAULT_ENTROPY_THRESHOLD);
    expect(resolveEntropyThreshold({})).toBe(DEFAULT_ENTROPY_THRESHOLD);
    expect(resolveEntropyThreshold({ env: {} })).toBe(DEFAULT_ENTROPY_THRESHOLD);
    expect(DEFAULT_ENTROPY_THRESHOLD).toBe(4.5);
  });

  test("config security.entropyThreshold válida é usada", () => {
    expect(resolveEntropyThreshold({ config: { entropyThreshold: 5 } })).toBe(5);
  });

  test("env ASTRO_ENTROPY_THRESHOLD vence a config", () => {
    expect(
      resolveEntropyThreshold({ config: { entropyThreshold: 5 }, env: { [ENTROPY_THRESHOLD_ENV]: "6" } }),
    ).toBe(6);
    expect(resolveEntropyThreshold({ env: { [ENTROPY_THRESHOLD_ENV]: " 6.5 " } })).toBe(6.5);
  });

  test("env vazia cai para config/default; teto máximo é aceito", () => {
    expect(
      resolveEntropyThreshold({ env: { [ENTROPY_THRESHOLD_ENV]: "   " }, config: { entropyThreshold: 5 } }),
    ).toBe(5);
    expect(resolveEntropyThreshold({ env: { [ENTROPY_THRESHOLD_ENV]: String(MAX_ENTROPY_THRESHOLD) } })).toBe(
      MAX_ENTROPY_THRESHOLD,
    );
  });

  test("valor inválido falha fechado (null), sem cair para valor mais frouxo", () => {
    for (const bad of ["banana", "0", "-1", "8.1", "99", "NaN", "Infinity"]) {
      expect(
        resolveEntropyThreshold({ env: { [ENTROPY_THRESHOLD_ENV]: bad }, config: { entropyThreshold: 3 } }),
      ).toBeNull();
    }
    expect(resolveEntropyThreshold({ config: { entropyThreshold: 99 } })).toBeNull();
    expect(resolveEntropyThreshold({ config: { entropyThreshold: Number.NaN } })).toBeNull();
  });
});

describe("validateConfig — seção security (ADR-0027, #391 slice 3b)", () => {
  test("security.entropyThreshold válida é preservada; ausente vira undefined", () => {
    const cfg = validateConfig({ ...structuredClone(validConfig), security: { entropyThreshold: 5 } });
    expect(cfg.security?.entropyThreshold).toBe(5);
    expect(validateConfig(structuredClone(validConfig)).security).toBeUndefined();
    expect(validateConfig({ ...structuredClone(validConfig), security: {} }).security).toEqual({});
  });

  test("security.entropyThreshold inválido é erro de config (fail-closed no load)", () => {
    for (const bad of [0, -1, 8.1, 99, "5", Number.NaN, null]) {
      expect(() => validateConfig({ ...structuredClone(validConfig), security: { entropyThreshold: bad } })).toThrow(
        /security\.entropyThreshold/,
      );
    }
  });

  test("chave desconhecida em security é rejeitada", () => {
    expect(() => validateConfig({ ...structuredClone(validConfig), security: { foo: 1 } })).toThrow(/security\.foo/);
  });
});
