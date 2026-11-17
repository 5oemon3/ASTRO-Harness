import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/core/config";

const base = {
  providers: { p: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m", maxSteps: 4, tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const cfg = (extra: object) => validateConfig({ ...structuredClone(base), ...extra });

describe("config attachments", () => {
  test("defaults", () => {
    expect(cfg({}).attachments).toEqual({
      image: { autoResize: false },
      directory: { showHidden: false },
      artifactTtlDays: 7,
      artifactMaxBytes: 1024 ** 3,
    });
  });

  test("sobrescreve", () => {
    const attachments = cfg({
      attachments: {
        image: { autoResize: false },
        directory: { showHidden: true },
        artifactTtlDays: 3,
        artifactMaxBytes: 2048,
      },
    }).attachments;
    expect(attachments).toEqual({
      image: { autoResize: false },
      directory: { showHidden: true },
      artifactTtlDays: 3,
      artifactMaxBytes: 2048,
    });
  });

  test("autoResize true é rejeitado como não suportado", () => {
    expect(() => cfg({ attachments: { image: { autoResize: true } } })).toThrow(
      /"attachments\.image\.autoResize".*não.*suportad/i,
    );
  });

  test("chave desconhecida falha", () => {
    expect(() => cfg({ attachments: { artifactRoot: "/tmp" } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { image: { resize: true } } })).toThrow(ConfigError);
  });

  test("tipos e positivos", () => {
    expect(() => cfg({ attachments: { artifactTtlDays: 0 } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { artifactMaxBytes: -1 } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { image: { autoResize: "yes" } } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { directory: { showHidden: 1 } } })).toThrow(ConfigError);
  });
});
