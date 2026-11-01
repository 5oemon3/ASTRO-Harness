import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config";
import { outboundUrlProblem, urlProblem } from "../src/url-safety";

function baseConfig(): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://api.example.com/v1", credentialRef: "P_KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 3, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("url-safety: hosts privados (#249)", () => {
  test("metadados e link-local são recusados mesmo com allowPrivate", () => {
    for (const raw of [
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/",
      "http://metadata.google.internal/computeMetadata/v1",
    ]) {
      expect(urlProblem(raw)).toBeDefined();
      expect(outboundUrlProblem(raw, { allowPrivate: true })).toBeDefined();
    }
  });

  test("outbound recusa loopback e faixas privadas por padrão", () => {
    for (const raw of [
      "http://127.0.0.1:8080/x",
      "http://localhost/",
      "http://10.0.0.5/",
      "http://192.168.0.1/",
      "http://172.16.4.1/",
      "http://[::1]/",
      "http://[fc00::1]/",
    ]) {
      expect(outboundUrlProblem(raw, { allowPrivate: false })).toBeDefined();
    }
  });

  test("outbound aceita host público", () => {
    expect(outboundUrlProblem("https://api.example.com/v1", { allowPrivate: false })).toBeUndefined();
  });

  test("allowPrivate explícito libera loopback (dev local), nunca metadados", () => {
    expect(outboundUrlProblem("http://127.0.0.1:11434/v1", { allowPrivate: true })).toBeUndefined();
    expect(outboundUrlProblem("http://169.254.169.254/", { allowPrivate: true })).toBeDefined();
  });
});

describe("config: URLs de saída privadas (#249)", () => {
  test("provider baseUrl de metadados é recusado", () => {
    const raw = baseConfig();
    (raw.providers as Record<string, Record<string, unknown>>).p!.baseUrl = "http://169.254.169.254/v1";
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("MCP url de metadados é recusada", () => {
    const raw = baseConfig();
    raw.mcpServers = { api: { transport: "http", url: "http://169.254.169.254/mcp" } };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("auditWebhook de metadados é recusado", () => {
    const raw = baseConfig();
    raw.team = { auditWebhook: "http://169.254.169.254/hook" };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });

  test("telemetry.endpoint de metadados é recusado", () => {
    const raw = baseConfig();
    raw.telemetry = { enabled: true, endpoint: "http://169.254.169.254/v1/runs" };
    expect(() => validateConfig(raw)).toThrow(/metadados|privado|link-local/);
  });
});

describe("config: baseUrl privado/loopback (#249)", () => {
  const prev = process.env.ASTRO_ALLOW_PRIVATE_URLS;
  const withoutOptIn = (fn: () => void): void => {
    delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
      else process.env.ASTRO_ALLOW_PRIVATE_URLS = prev;
    }
  };
  const setBaseUrl = (raw: Record<string, unknown>, url: string): void => {
    (raw.providers as Record<string, Record<string, unknown>>).p!.baseUrl = url;
  };

  test("baseUrl loopback/RFC1918/ULA recusado sem opt-in (exfiltração via config clonada)", () => {
    withoutOptIn(() => {
      for (const url of [
        "http://127.0.0.1:8080/v1",
        "http://localhost:11434/v1",
        "http://10.0.0.5/v1",
        "http://192.168.0.1/v1",
        "http://172.16.4.1/v1",
        "http://[::1]/v1",
        "http://[fc00::1]/v1",
      ]) {
        const raw = baseConfig();
        setBaseUrl(raw, url);
        expect(() => validateConfig(raw)).toThrow(/privado|loopback/);
      }
    });
  });

  test("baseUrl público continua aceito sem opt-in", () => {
    withoutOptIn(() => {
      expect(() => validateConfig(baseConfig())).not.toThrow();
    });
  });

  test("opt-in ASTRO_ALLOW_PRIVATE_URLS=1 libera loopback, nunca metadados", () => {
    process.env.ASTRO_ALLOW_PRIVATE_URLS = "1";
    try {
      const raw = baseConfig();
      setBaseUrl(raw, "http://127.0.0.1:11434/v1");
      expect(() => validateConfig(raw)).not.toThrow();
      const meta = baseConfig();
      setBaseUrl(meta, "http://169.254.169.254/v1");
      expect(() => validateConfig(meta)).toThrow(/metadados|link-local/);
    } finally {
      if (prev === undefined) delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
      else process.env.ASTRO_ALLOW_PRIVATE_URLS = prev;
    }
  });
});
