import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type SendTurnOptions, type TurnResult } from "../src/chat/agent-session";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import { loadAttachment } from "../src/attachments/load";
import type { AttachmentMeta, LoadedAttachment } from "../src/attachments/model";
import { canonicalize } from "../src/tools/paths";
import { FAKE_PRIVATE_ACL } from "./setup";

class ScriptedIO implements ReplIO {
  readonly outputs: string[] = [];
  readonly prompts: string[] = [];
  constructor(private readonly lines: Array<string | null>) {}
  async read(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.lines.shift() ?? null;
  }
  write(text: string): void {
    this.outputs.push(text);
  }
}

class CaptureSession implements ChatSession {
  model = "p/m1";
  sent: Array<{ prompt: string; attachments?: readonly LoadedAttachment[] }> = [];
  async send(prompt: string, _signal?: AbortSignal, _onToken?: (text: string) => void, _attachments?: AttachmentMeta[], turn?: SendTurnOptions): Promise<TurnResult> {
    this.sent.push({ prompt, ...(turn?.attachments === undefined ? {} : { attachments: [...turn.attachments] }) });
    return {
      final: "ok", model: this.model, steps: 1, tokensIn: 1, tokensOut: 1, costUsd: 0,
      totalTokensIn: 1, totalTokensOut: 1, totalCostUsd: 0,
      contextTokens: 1, contextLimit: 100, contextRatio: 0.01, warning: false, trimmed: false,
    };
  }
  compact(): Promise<string> {
    return Promise.resolve("noop");
  }
  clear(): void {}
  resume(): void {}
  setModel(ref: string): string {
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [];
  }
  setProvider(): string {
    return this.model;
  }
  snapshot() {
    return {
      id: "s1", startedAt: "2026-11-08T12:00:00.000Z", model: this.model,
      messages: [], turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }
  close(): void {}
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-att-repl-"));
  dirs.push(dir);
  return dir;
}

describe("/attach e /paste no REPL (ADR-0026, #392)", () => {
  test("anexa arquivo, materializa no prompt e envia metadados", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
    const session = new CaptureSession();
    await runRepl(session, new ScriptedIO(["/attach a.txt", "resuma", "/exit"]), { cwd });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("resuma\n\n[anexo: a.txt]\num\ndois\n");
    expect(session.sent[0]?.attachments?.[0]).toMatchObject({ kind: "text", name: "a.txt", mediaType: "text/plain" });
  });

  test("/attach sem path lista pendentes e /detach all limpa", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "x");
    const io = new ScriptedIO(["/attach a.txt", "/attach", "/detach all", "/attach", "/exit"]);
    await runRepl(new CaptureSession(), io, { cwd });
    const text = io.outputs.join("\n");
    expect(text).toContain("1. a.txt");
    expect(text).toContain("anexos removidos");
    expect(text.match(/nenhum anexo pendente/g)?.length).toBe(1);
  });

  test("hard-block mostra erro e não envia o prompt", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, ".env"), "KEY=1");
    const session = new CaptureSession();
    const io = new ScriptedIO(["/attach .env", "oi", "/exit"]);
    await runRepl(session, io, { cwd });
    expect(session.sent[0]?.prompt).toBe("oi");
    expect(io.outputs.join("\n")).toContain("bloqueado");
  });

  test("/paste usa o leitor injetado e limpa após o turno", async () => {
    const cwd = sandbox();
    const session = new CaptureSession();
    const io = new ScriptedIO(["/paste", "leia", "outra", "/exit"]);
    await runRepl(session, io, { cwd, clipboard: () => "colado" });
    expect(session.sent[0]?.prompt).toBe("leia\n\n[anexo: clipboard]\ncolado");
    expect(session.sent[1]?.prompt).toBe("outra");
    expect(session.sent[1]?.attachments).toBeUndefined();
  });

  test("/paste repetido é recusado e materializa um bloco só (#392)", async () => {
    const cwd = sandbox();
    const session = new CaptureSession();
    const io = new ScriptedIO(["/paste", "/paste", "leia", "/exit"]);
    await runRepl(session, io, { cwd, clipboard: () => "colado" });
    expect(io.outputs.join("\n")).toContain("já adicionado: clipboard");
    expect(session.sent[0]?.prompt).toBe("leia\n\n[anexo: clipboard]\ncolado");
    expect(session.sent[0]?.attachments).toHaveLength(1);
  });

  test("mesmo anexo duas vezes é recusado e materializa um bloco só", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
    const session = new CaptureSession();
    const io = new ScriptedIO(["/attach a.txt", "/attach a.txt", "resuma", "/exit"]);
    await runRepl(session, io, { cwd });
    expect(io.outputs.join("\n")).toContain("já adicionado: a.txt");
    expect(session.sent[0]?.prompt).toBe("resuma\n\n[anexo: a.txt]\num\ndois\n");
    expect(session.sent[0]?.attachments).toHaveLength(1);
  });
});

/** PNG 1x1 real (70 bytes), o mesmo fixture do teste de turno. */
const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Texto comum de ~20 MiB; hex longo seria redigido e encolheria o anexo. */
const BIG_CHUNK = "lorem ipsum dolor sit amet\n";
const BIG_TEXT = BIG_CHUNK.repeat(Math.floor((20 * 1024 * 1024) / BIG_CHUNK.length));
interface CapturedBody { messages?: Array<{ role?: string; content?: unknown }> }

/** Sessão real + servidor local que captura o corpo: exercita o wire até o provider. */
function e2eSetup(context = 8192, extraConfig: Record<string, unknown> = {}) {
  const base = sandbox();
  const cwd = join(base, "work"), home = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, "a.png"), Buffer.from(pngData, "base64"));
  const bodies: CapturedBody[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push((await req.json()) as CapturedBody);
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    ...extraConfig,
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context, capabilities: { vision: true } }],
    agent: { model: "p/m1", maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  // Injeta ACL fake: no runner windows do CI o cold start do PowerShell passa de 15 s.
  const session = new AgentSession({
    configPath,
    cwd,
    env: { ASTRO_HOME: home, ASTRO_ALLOW_PRIVATE_URLS: "1", KEY: "k" },
    artifactCheckPrivate: () => true,
    artifactHardenPrivate: () => FAKE_PRIVATE_ACL,
  });
  return { cwd, home, bodies, session, stop: () => server.stop(true) };
}

describe("imagem no turno do REPL (ADR-0026, #392)", () => {
  test("imagem aprovada chega ao provider como image_url", async () => {
    const { cwd, bodies, session, stop } = e2eSetup();
    try {
      await runRepl(session, new ScriptedIO(["/attach a.png", "resuma", "s", "/exit"]), { cwd, interactive: true });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.messages?.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${pngData}` } });
    } finally { stop(); }
  });

  test("resposta 'sair' não aprova por prefixo e nega o turno", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup();
    const io = new ScriptedIO(["/attach a.png", "resuma", "sair", "/exit"]);
    try {
      await runRepl(session, io, { cwd, interactive: true });
      expect(bodies).toHaveLength(0);
      expect(io.outputs.join("\n")).toContain("não aprovado");
      expect(existsSync(join(home, "attachments"))).toBe(false);
      expect(existsSync(join(cwd, ".astro", "audit.jsonl")) ? readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8") : "").not.toContain("attachment.approved");
    } finally { stop(); }
  });
  test("sem TTY imagem é negada sem perguntar", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup();
    const io = new ScriptedIO(["/attach a.png", "resuma", "/exit"]);
    try {
      await runRepl(session, io, { cwd });
      expect(bodies).toHaveLength(0);
      expect(io.outputs.join("\n")).toContain("não aprovado");
      expect(io.prompts.join("\n")).not.toContain("aprovar envio?");
      expect(existsSync(join(home, "attachments"))).toBe(false);
    } finally { stop(); }
  });

  test("imagem maior que a janela é rejeitada antes do request e o anexo continua pendente", async () => {
    const { cwd, bodies, session, stop } = e2eSetup(16);
    const io = new ScriptedIO(["/attach a.png", "resuma", "s", "/attach", "/exit"]);
    try {
      await runRepl(session, io, { cwd, interactive: true });
      expect(bodies).toHaveLength(0);
      const text = io.outputs.join("\n");
      expect(text).toContain("janela de contexto");
      expect(text).toMatch(/~\d+ tokens \+ \d+ de saída > 16/);
      expect(text).not.toContain(pngData); // I-03: erro cita contagens, nunca conteúdo
      // Falha não consome o anexo: continua pendente para /detach ou novo turno.
      expect(text.slice(text.indexOf("janela de contexto"))).toContain("1. a.png");
    } finally { stop(); }
  });

  test("imagem recusada falha o turno, mantém o anexo e não grava nada (#392)", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup();
    try {
      const io = new ScriptedIO(["/attach a.png", "resuma", "n", "/attach", "/exit"]);
      await runRepl(session, io, { cwd, interactive: true });
      const out = io.outputs.join("\n");
      expect(out).toContain("não redigíveis");
      expect(out).toContain("erro: anexos do turno não aprovados pelo usuário");
      expect(io.outputs).toContain("1. a.png (4 bytes decodificados)"); // pendente mantido; 1x1 RGBA
      expect(bodies).toHaveLength(0);
      const root = join(home, "attachments");
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8")).not.toContain("attachment.approved");
    } finally {
      stop();
    }
  });
});

describe("turno acima da janela no REPL (ADR-0026, #392)", () => {
  test("20 MiB de texto estoura a janela e falha antes do request, sem compactar", async () => {
    const { cwd, bodies, session, stop } = e2eSetup(131072);
    writeFileSync(join(cwd, "big.txt"), BIG_TEXT);
    const io = new ScriptedIO(["/attach big.txt", "resuma", "/exit"]);
    try {
      await runRepl(session, io, { cwd });
      expect(bodies).toHaveLength(0);
      expect(io.outputs.join("\n")).toContain("janela de contexto");
      expect(session.snapshot().messages.map((message) => message.role)).toEqual(["system"]);
      const audit = join(cwd, ".astro", "audit.jsonl");
      expect(existsSync(audit) ? readFileSync(audit, "utf8") : "").not.toContain("chat.compact");
    } finally {
      stop();
    }
  }, 30_000);

  test("falha tipada attachment_turn_too_large, não trunca histórico e não envia", async () => {
    const { cwd, home, bodies, session, stop } = e2eSetup(131072);
    writeFileSync(join(cwd, "big.txt"), BIG_TEXT);
    try {
      // Histórico que o guard descartaria para caber; ele precisa sobreviver à rejeição.
      session.resume({
        id: "prev", startedAt: "2026-11-08T12:00:00.000Z", model: "p/m1",
        messages: [{ role: "user", content: "antigo" }, { role: "assistant", content: "ok" }],
        turns: 1, tokensIn: 1, tokensOut: 1, costUsd: 0,
      });
      const big = await loadAttachment({ path: "big.txt", cwd, astroHome: home });
      let thrown: unknown;
      try {
        // Mesma forma do REPL: o conteúdo já está no prompt e os metas acompanham o turno.
        await session.send(BIG_TEXT, undefined, undefined, undefined, { attachments: [big] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ name: "AttachmentError", code: "attachment_turn_too_large" });
      expect(bodies).toHaveLength(0);
      const messages = session.snapshot().messages;
      expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
      expect(messages[1]?.content).toBe("antigo");
    } finally {
      stop();
    }
  }, 30_000);
});

describe("@path é só menção (ADR-0026, #392)", () => {
  test("prompt com @path não lê o arquivo nem envia attachments", async () => {
    const cwd = sandbox();
    writeFileSync(join(cwd, "a.txt"), "conteudo-do-arquivo\n");
    const session = new CaptureSession();
    const io = new ScriptedIO(["veja @a.txt e @nao-existe.txt", "/exit"]);
    await runRepl(session, io, { cwd });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]?.prompt).toBe("veja @a.txt e @nao-existe.txt");
    expect(session.sent[0]?.attachments).toBeUndefined();
    const out = io.outputs.join("\n");
    expect(out).not.toContain("conteudo-do-arquivo");
    expect(out).not.toContain("erro");
  });
});

describe("protectedPaths da config no /attach (ADR-0026, #392)", () => {
  test("ledger e audit resolvidos entram no hard-block", async () => {
    const base = sandbox();
    const cwd = join(base, "work"), home = join(base, "home");
    mkdirSync(join(cwd, "state"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, "state", "ledger.jsonl"), "{}\n");
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 1, tools: [] },
      paths: { ledger: "state/ledger.jsonl", audit: "state/audit.jsonl" },
    }));
    const session = new AgentSession({ configPath, cwd, env: { ASTRO_HOME: home, KEY: "k" } });
    const io = new ScriptedIO(["/attach state/ledger.jsonl", "/exit"]);
    try {
      await runRepl(session, io, { cwd });
      expect(io.outputs.join("\n")).toContain("bloqueado");
      expect(io.outputs.join("\n")).not.toContain("anexo adicionado");
    } finally {
      session.close();
    }
  });

  test("attachmentProtectedPaths devolve caminhos canônicos", () => {
    const base = sandbox();
    const cwd = join(base, "work"), home = join(base, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const state = join(cwd, "real-state");
    mkdirSync(state);
    symlinkSync(state, join(cwd, "state-link"), process.platform === "win32" ? "junction" : "dir");
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", maxSteps: 1, tools: [] },
      paths: { ledger: "state-link/ledger.jsonl", audit: "state-link/audit.jsonl" },
    }));
    const session = new AgentSession({ configPath, cwd, env: { ASTRO_HOME: home, KEY: "k" } });
    try {
      const real = canonicalize(state);
      expect(session.attachmentProtectedPaths()).toEqual([
        join(real, "ledger.jsonl"),
        join(real, "audit.jsonl"),
      ]);
    } finally {
      session.close();
    }
  });
});

describe("showHidden da config no /attach (ADR-0026, #392)", () => {
  test("config true lista ocultos; false os esconde", async () => {
    for (const showHidden of [true, false]) {
      const { cwd, bodies, session, stop } = e2eSetup(8192, { attachments: { directory: { showHidden } } });
      mkdirSync(join(cwd, "d"));
      writeFileSync(join(cwd, "d", "visivel.txt"), "x");
      writeFileSync(join(cwd, "d", ".oculto"), "x");
      try {
        await runRepl(session, new ScriptedIO(["/attach d", "liste", "/exit"]), { cwd });
        expect(bodies).toHaveLength(1);
        expect(JSON.stringify(bodies[0]).includes(".oculto")).toBe(showHidden);
      } finally {
        stop();
      }
    }
  });
});
