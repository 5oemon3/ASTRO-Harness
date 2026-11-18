import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, providerAccountRefFor, providerCredentialRefFor, updateConfigPermissionsMode, validateConfig } from "../src/core/config";
import { accountRefOf } from "../src/agent-lock";
import type { ModelConfig, ModelStatus } from "../src/core/config";
import type { PermissionMode } from "../src/permissions";
import { isKnownTag } from "../src/tags";

const valid = {
  providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }] as ModelConfig[],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["read_file", "write_file", "run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const validWithAgents = {
  ...valid,
  providers: {
    ...valid.providers,
    backup: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "BACKUP_API_KEY" },
  },
  agents: {
    planner: { model: "openai/gpt-4o-mini", maxSteps: 10, tools: ["read_file"], systemPrompt: "Planeje a tarefa" },
    coder: { model: "openai/gpt-4o-mini", maxSteps: 15, tools: ["read_file", "write_file", "run_command"] },
    reviewer: { model: "openai/gpt-4o-mini", maxSteps: 5, tools: ["read_file"] },
  },
};

describe("config", () => {
  test("config válida ganha defaults", () => {
    const cfg = validateConfig(structuredClone(valid));
    expect(cfg.models[0].status).toBe("active");
    expect(cfg.providers.openai.quotaDomain).toBe("default");
  });
  test("credentialRef aceita env nomeada e vault:<credentialId>; vault malformado é erro (#311)", () => {
    const withRef = (ref: string) => {
      const raw = structuredClone(valid);
      raw.providers.openai.credentialRef = ref;
      return validateConfig(raw);
    };
    expect((withRef("OPENAI_API_KEY").providers.openai as { credentialRef?: string }).credentialRef).toBe("OPENAI_API_KEY");
    expect((withRef("vault:cred-12345678-abcd").providers.openai as { credentialRef?: string }).credentialRef).toBe("vault:cred-12345678-abcd");
    expect(() => withRef("vault:../etc")).toThrow(/credentialRef/);
    // fora dos dois formatos: erro que nomeia o campo e não ecoa o valor (I-03)
    expect(() => withRef("openai key")).toThrow(/credentialRef/);
    const secretish = ["s", "k", "-"].join("") + "live-abcdef12345";
    let message = "";
    try { withRef(secretish); } catch (error) { message = String(error); }
    expect(message).toContain("credentialRef");
    expect(message).toContain("parece um segredo");
    expect(message).not.toContain(secretish);
    // segredo com forma de nome de env (AWS) também é recusado sem eco (I-03)
    const awsSentinel = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    let awsMessage = "";
    try { withRef(awsSentinel); } catch (error) { awsMessage = String(error); }
    expect(awsMessage).toContain("parece um segredo");
    expect(awsMessage).not.toContain(awsSentinel);
    // nome de env é maiúsculo (documentado em docs/providers.md)
    expect(() => withRef("my_key")).toThrow(/credentialRef/);
  });
  test("tag fora do vocabulário fechado → ConfigError", () => {
    const bad = structuredClone(valid);
    bad.models[0].tags.push("telepathy");
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });
  test("modelo apontando para provider inexistente → ConfigError", () => {
    const bad = structuredClone(valid);
    bad.models[0].provider = "ghost";
    expect(() => validateConfig(bad)).toThrow(/provider/);
  });
  test("agent.model precisa referenciar modelo declarado", () => {
    const bad = structuredClone(valid);
    bad.agent.model = "openai/ghost";
    expect(() => validateConfig(bad)).toThrow(/agent\.model/);
  });
});

describe("agents (F3-1)", () => {
  test("config com agents válida passa", () => {
    const cfg = validateConfig(structuredClone(validWithAgents));
    expect(cfg.agents).toBeDefined();
    expect(Object.keys(cfg.agents!)).toEqual(["planner", "coder", "reviewer"]);
    expect(cfg.agents!.planner.model).toBe("openai/gpt-4o-mini");
    expect(cfg.agents!.planner.maxSteps).toBe(10);
    expect(cfg.agents!.planner.tools).toEqual(["read_file"]);
    expect(cfg.agents!.planner.systemPrompt).toBe("Planeje a tarefa");
  });
  test("nomes aceitos com _ e . passam no checkpoint (#135)", () => {
    for (const name of ["code_reviewer", "review.v2"]) {
      const raw = structuredClone(validWithAgents) as unknown as { agents: Record<string, unknown> };
      raw.agents = { [name]: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["read_file"] } };
      expect(validateConfig(raw).agents![name]).toBeDefined();
    }
  });
  test("nome de agent que não vira segmento do checkpoint falha no load (#135)", () => {
    for (const name of ["review/security", "rev:sec", "..", "a".repeat(121), "rev\u202Esec"]) {
      const raw = structuredClone(validWithAgents) as unknown as { agents: Record<string, unknown> };
      raw.agents = { [name]: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["read_file"] } };
      expect(() => validateConfig(raw)).toThrow(/checkpoint/);
    }
  });
  test("entryAgent com nome inválido para o checkpoint falha no load (#135)", () => {
    const raw = structuredClone(validWithAgents) as unknown as { agent: { entryAgent?: string } };
    raw.agent.entryAgent = "review/security";
    expect(() => validateConfig(raw)).toThrow(/checkpoint/);
  });
  test("agent com model inexistente → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.agents!.planner.model = "openai/ghost";
    expect(() => validateConfig(bad)).toThrow(/agent.*referencia modelo.*não declarado/);
  });
  test("agent com model inativo (deprecated) → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.models = [...bad.models, { provider: "openai", id: "old-model", tags: ["fast"], context: 8192, status: "deprecated" as const }];
    bad.agents!.planner.model = "openai/old-model";
    expect(() => validateConfig(bad)).toThrow(/agent.*referencia modelo.*não está active/);
  });
  test("agent com tool fora da allowlist global → ConfigError", () => {
    const bad = structuredClone(validWithAgents);
    bad.agents!.planner.tools = ["read_file", "tool_inexistente"];
    expect(() => validateConfig(bad)).toThrow(/agent.*tool.*desconhecida/);
  });
  test("agent sem maxSteps usa default do agent principal", () => {
    const noMaxSteps = structuredClone(validWithAgents);
    (noMaxSteps.agents!.planner as any).maxSteps = undefined;
    const cfg = validateConfig(noMaxSteps);
    expect(cfg.agents!.planner.maxSteps).toBe(valid.agent.maxSteps);
  });
  test("agent sem tools herda do agent principal", () => {
    const noTools = structuredClone(validWithAgents);
    (noTools.agents!.planner as any).tools = undefined;
    const cfg = validateConfig(noTools);
    expect(cfg.agents!.planner.tools).toEqual(valid.agent.tools);
  });
});

describe("spawn (A11)", () => {
  test("paralelo é opt-in e o valor precisa ser booleano", () => {
    expect(validateConfig(structuredClone(valid)).spawn).toBeUndefined();
    const raw = structuredClone(valid) as typeof valid & { spawn?: { parallel?: unknown } };
    raw.spawn = { parallel: true };
    expect(validateConfig(raw).spawn?.parallel).toBe(true);
    raw.spawn = { parallel: "yes" };
    expect(() => validateConfig(raw)).toThrow(/spawn\.parallel/);
  });

  test("conta do provider casa com a chave do lock em plugin sem credencial", () => {
    const accountOfLock = (provider: Parameters<typeof providerAccountRefFor>[1]) =>
      accountRefOf({ credentialRef: providerCredentialRefFor(provider), provider: "plug" });
    for (const provider of [
      { kind: "custom", baseUrl: "http://x" },
      { kind: "custom", baseUrl: "http://x", credentialRef: "" },
    ]) {
      expect(providerAccountRefFor("plug", provider as never)).toBe(accountOfLock(provider as never));
    }
  });
});

describe("handoff (F-24)", () => {
  test("sem seção handoff o ackTimeoutMs default é 30000 (D-15)", () => {
    const cfg = validateConfig(structuredClone(valid));
    expect(cfg.handoff?.ackTimeoutMs).toBe(30_000);
  });
  test("ackTimeoutMs inválido → ConfigError", () => {
    const bad = structuredClone(valid) as typeof valid & { handoff?: { ackTimeoutMs?: unknown } };
    bad.handoff = { ackTimeoutMs: 0 };
    expect(() => validateConfig(bad)).toThrow(/handoff\.ackTimeoutMs/);
  });
  test("ackTimeoutMs válido é preservado", () => {
    const cfg = validateConfig({ ...structuredClone(valid), handoff: { ackTimeoutMs: 5_000 } });
    expect(cfg.handoff?.ackTimeoutMs).toBe(5_000);
  });
});

test("vocabulário de tags é fechado", () => {
  expect(isKnownTag("writing-code")).toBe(true);
  expect(isKnownTag("telepathy")).toBe(false);
});

describe("cross-provider same-model-id semantics (S-06, #123)", () => {
  test("mesmo id em providers diferentes é válido e distinto (composite identity provider/id)", () => {
    const cfg = validateConfig({
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", credentialRef: "NVIDIA_API_KEY" },
        openrouter: { kind: "openai-compat", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "OPENROUTER_API_KEY" },
      },
      models: [
        { provider: "nvidia", id: "llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
        { provider: "openrouter", id: "llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
      ],
      agent: { model: "nvidia/llama-3.3-70b-instruct", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });
    expect(cfg.models).toHaveLength(2);
    expect(cfg.models[0].provider).toBe("nvidia");
    expect(cfg.models[1].provider).toBe("openrouter");
    // Ambos selecionáveis via composite identity
    expect(cfg.models.find((m) => m.provider === "nvidia" && m.id === "llama-3.3-70b-instruct")).toBeDefined();
    expect(cfg.models.find((m) => m.provider === "openrouter" && m.id === "llama-3.3-70b-instruct")).toBeDefined();
  });

  test("duplicado exato provider/id ainda falha com mensagem existente", () => {
    const bad = {
      providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
      models: [
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 },
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 },
      ],
      agent: { model: "openai/gpt-4o-mini", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    };
    expect(() => validateConfig(bad)).toThrow(/modelo duplicado/);
  });

  test("modelo id existente em um provider não é resolvido implicitamente por outro provider", () => {
    const cfg = validateConfig({
      providers: {
        nvidia: { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", credentialRef: "NVIDIA_API_KEY" },
        openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" },
      },
      models: [
        { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", tags: ["writing-code"], context: 128000 },
        { provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 },
      ],
      agent: { model: "nvidia/meta/llama-3.3-70b-instruct", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });
    // openai/gpt-4o-mini NÃO resolve nvidia/meta/llama-3.3-70b-instruct
    // O registry lookup requer composite identity provider/id
    expect(cfg.models.find((m) => m.provider === "openai" && m.id === "meta/llama-3.3-70b-instruct")).toBeUndefined();
    expect(cfg.models.find((m) => m.provider === "nvidia" && m.id === "meta/llama-3.3-70b-instruct")).toBeDefined();
  });
});

describe("updateConfigPermissionsMode (#273)", () => {
  const minimal = {
    providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
    models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
    agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: [] },
    paths: { ledger: "l", audit: "a" },
  };

  test("grava só permissions.mode, mantém o resto, revalida e não deixa tmp órfão", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-mode-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, JSON.stringify(minimal));
    updateConfigPermissionsMode(path, "bypass");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw.permissions).toEqual({ mode: "bypass" });
    expect(raw.models).toEqual(minimal.models); // resto do arquivo intacto
    expect(loadConfig(path).permissions.mode).toBe("bypass"); // continua válido ao carregar
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("sobrescreve permissions.mode existente", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-mode-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, JSON.stringify({ ...minimal, permissions: { mode: "ask" } }));
    updateConfigPermissionsMode(path, "allow-edits");
    expect(loadConfig(path).permissions).toEqual({ mode: "allow-edits" });
  });

  test("modo inválido joga ConfigError e deixa o arquivo intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-mode-"));
    const path = join(dir, "astro.config.json");
    const original = JSON.stringify(minimal);
    writeFileSync(path, original);
    expect(() => updateConfigPermissionsMode(path, "yolo" as PermissionMode)).toThrow(ConfigError);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("arquivo que não é JSON válido joga ConfigError e não altera o arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-mode-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, "{ não é json");
    expect(() => updateConfigPermissionsMode(path, "ask")).toThrow(ConfigError);
    expect(readFileSync(path, "utf8")).toBe("{ não é json");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("erros distintos ao salvar a config via /config (#470)", () => {
  const minimal = {
    providers: { openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY" } },
    models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
    agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: [] },
    paths: { ledger: "l", audit: "a" },
  };
  const noTmp = (dir: string): void => {
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  };
  const capture = (fn: () => void): ConfigError & { code?: string } => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return error as ConfigError & { code?: string };
    }
    throw new Error("esperava ConfigError");
  };

  test("ENOENT: nomeia o caminho ausente e o próximo passo (--config), sem mensagem genérica", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json"); // não existe
    const err = capture(() => updateConfigPermissionsMode(path, "ask"));
    expect(err.code).toBe("config_not_found");
    expect(err.message).toContain(path);
    expect(err.message).toContain("--config");
    expect(err.message).not.toContain("leitura/JSON falhou");
    expect(err.message).not.toContain("não foi possível atualizar"); // mensagem genérica sumiu
    noTmp(dir);
  });

  test("EISDIR (caminho de diretório): leitura falhou, não é 'não encontrado'", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    // `dir` é um diretório: readFileSync falha com EISDIR
    const err = capture(() => updateConfigPermissionsMode(dir, "ask"));
    expect(err.code).toBe("config_read_failed");
    expect(err.message).toContain("não foi possível ler");
    expect(err.message).toContain(dir);
    expect(err.message).toContain("EISDIR");
    expect(err.message).not.toContain("não foi possível atualizar");
    noTmp(dir);
  });

  test("JSON inválido: a posição reportada fica dentro do arquivo, nunca no frame da pilha", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    const content = '{\n  "providers": {},\n  "models": [], "agent": {"model": "x", tokenAqui }\n}';
    writeFileSync(path, content);
    const err = capture(() => updateConfigPermissionsMode(path, "ask"));
    expect(err.code).toBe("config_invalid_json");
    expect(err.message).toMatch(/JSON inválido/);
    expect(err.message).toContain(path);
    expect(err.message).not.toContain("tokenAqui"); // conteúdo do arquivo nunca ecoa
    expect(err.message).toContain("não foi alterado");
    // Bun põe no erro o line/column do frame que chamou JSON.parse (config.ts), não o do
    // JSON; posição fora do arquivo nunca é reportada. Parser sem posição na mensagem
    // (Bun) => nenhuma linha/coluna é afirmada.
    const reported = /linha (\d+), coluna (\d+)/.exec(err.message);
    if (reported !== null) {
      const line = Number(reported[1]);
      expect(line).toBeGreaterThanOrEqual(1);
      expect(line).toBeLessThanOrEqual(content.split("\n").length);
      expect(Number(reported[2])).toBeGreaterThanOrEqual(1);
    }
    expect(readFileSync(path, "utf8")).toBe(content);
    noTmp(dir);
  });

  test("posição do JSON vem só da mensagem do parser (V8), com limites do arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    const content = '{\n  "a": 1,\n  "b": foo\n}\n';
    writeFileSync(path, content);
    const index = content.indexOf("foo"); // linha 3, coluna 8
    /** Joga o erro que o parser jogaria; Bun não põe posição na mensagem, V8 põe. */
    const withParseError = (error: unknown, run: () => void): void => {
      const original = JSON.parse;
      JSON.parse = () => { throw error; };
      try {
        run();
      } finally {
        JSON.parse = original;
      }
    };

    withParseError(new SyntaxError(`Unexpected token 'o', "..." is not valid JSON at position ${index}`), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).toContain("na linha 3, coluna 8"); // position -> linha/coluna
    });
    withParseError(new SyntaxError(`Expected property name or '}' in JSON at position ${index} (line 3 column 8)`), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).toContain("na linha 3, coluna 8"); // (line N column M) vence position
    });
    withParseError(new SyntaxError("Bad JSON at position 4 (line 99 column 2)"), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/); // fora do arquivo (4 linhas): descarta
    });
    // Offset bruto além do fim do arquivo: descartado, não realocado para o EOF
    // (realocar daria uma linha plausível e falsa).
    withParseError(new SyntaxError("Unexpected end of JSON input at position 9999"), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/);
    });
    // Offset com dígitos demais (Number -> Infinity) e offset não inteiro seguro (2^53).
    withParseError(new SyntaxError(`Bad JSON at position ${"9".repeat(400)}`), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/);
    });
    withParseError(new SyntaxError("Bad JSON at position 9007199254740992"), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/);
    });
    // Fim da entrada: continua válido, uma coluna depois do último caractere.
    withParseError(new SyntaxError(`Unexpected end of JSON input at position ${content.length}`), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).toContain("na linha 5, coluna 1");
    });
    // Coluna além do fim da linha citada: mesma régua do offset.
    withParseError(new SyntaxError("Bad JSON at position 4 (line 1 column 999)"), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/);
    });
    // Bun: line/column do frame da pilha (config.ts:1714), sem posição na mensagem.
    withParseError(Object.assign(new SyntaxError("JSON Parse error: Property name must be a string literal"), { line: 1714, column: 5 }), () => {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.message).not.toMatch(/linha \d+/);
    });
    expect(readFileSync(path, "utf8")).toBe(content);
    noTmp(dir);
  });

  test("ConfigError.code é opcional de verdade: sem código a propriedade não existe", () => {
    const legacy = new ConfigError("mensagem antiga");
    expect("code" in legacy).toBe(false); // consumidores gateiam por shape ("code" in error)
    expect(legacy.code).toBeUndefined();
    const coded = new ConfigError("falhou", "config_write_failed");
    expect("code" in coded).toBe(true);
    expect(coded.code).toBe("config_write_failed");
  });

  test("raiz que não é objeto: erro de schema nomeando o problema; arquivo intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, "[1, 2]");
    const err = capture(() => updateConfigPermissionsMode(path, "ask"));
    expect(err.code).toBe("config_invalid_schema");
    expect(err.message).toMatch(/raiz deve ser um objeto/);
    expect(err.message).toContain(path);
    expect(readFileSync(path, "utf8")).toBe("[1, 2]");
    noTmp(dir);
  });

  test("schema inválido (validateConfig): nomeia o campo e o esperado; arquivo intacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    const original = JSON.stringify({ ...minimal, agent: { model: "openai/gpt-4o-mini", maxSteps: -1, tools: [] } });
    writeFileSync(path, original);
    const err = capture(() => updateConfigPermissionsMode(path, "ask"));
    expect(err.code).toBe("config_invalid_schema");
    expect(err.message).toContain("agent.maxSteps");
    expect(err.message).toContain("inteiro positivo");
    expect(err.message).toContain("não foi alterado");
    expect(err.message).not.toContain("não foi possível atualizar");
    expect(readFileSync(path, "utf8")).toBe(original);
    noTmp(dir);
  });

  // Permissão só dá para expressar fora do Windows (ACL não mapeia para EACCES).
  const itPosix = process.platform === "win32" ? test.skip : test;

  itPosix("EACCES na leitura: nomeia caminho e operação negada", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, JSON.stringify(minimal));
    chmodSync(path, 0o000);
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.code).toBe("config_read_denied");
      expect(err.message).toContain(path);
      expect(err.message).toMatch(/permissão/i);
      expect(err.message).toContain("EACCES");
    } finally {
      chmodSync(path, 0o600);
    }
    noTmp(dir);
  });

  itPosix("EACCES na escrita: nomeia caminho e 'gravar'; original intacto e sem tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-470-"));
    const path = join(dir, "astro.config.json");
    const original = JSON.stringify(minimal);
    writeFileSync(path, original);
    chmodSync(dir, 0o555); // diretório sem escrita: o tmp+rename falha
    try {
      const err = capture(() => updateConfigPermissionsMode(path, "ask"));
      expect(err.code).toBe("config_write_denied");
      expect(err.message).toContain(path);
      expect(err.message).toMatch(/gravar/);
      expect(err.message).toContain("original não foi alterado");
      expect(readFileSync(path, "utf8")).toBe(original);
      noTmp(dir);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
