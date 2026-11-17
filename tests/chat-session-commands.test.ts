import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT, parseCommand } from "../src/chat/commands";
import { runRepl, type ChatSession, type ReplIO } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import { SessionApi } from "../src/chat/session-api";
import { SessionStore, type SessionRecord } from "../src/chat/store";
import { nodeReplOptions } from "../src/chat/node-io";

class ScriptedIO implements ReplIO {
  readonly outputs: string[] = [];
  constructor(private readonly lines: string[]) {}
  async read(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  write(text: string): void {
    this.outputs.push(text);
  }
}

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: string[] = [];
  compact(): Promise<string> {
    return Promise.resolve("não usado");
  }
  async send(prompt: string): Promise<TurnResult> {
    this.sent.push(prompt);
    return {
      final: `eco:${prompt}`, model: this.model, steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
      totalTokensIn: 10 * this.sent.length, totalTokensOut: 5 * this.sent.length,
      totalCostUsd: 0.001 * this.sent.length, contextTokens: 10, contextLimit: 100, contextRatio: 0.1,
      warning: false, trimmed: false,
    };
  }
  clear(): void {}
  setModel(ref: string): string {
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    return `${name}/m1`;
  }
  resumedFrom: SessionSnapshot["resumedFrom"];
  resume(snapshot: SessionSnapshot): void {
    this.resumedFrom = { id: snapshot.id, startedAt: snapshot.startedAt };
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }],
      turns: this.sent.length, tokensIn: 10 * this.sent.length, tokensOut: 5 * this.sent.length,
      costUsd: 0.001 * this.sent.length,
      ...(this.resumedFrom === undefined ? {} : { resumedFrom: this.resumedFrom }),
    };
  }
  close(): void {}
}

class CountingApi extends SessionApi {
  writes = 0;
  override save(value: Parameters<SessionApi["save"]>[0]): SessionRecord {
    this.writes++;
    return super.save(value);
  }
}

describe("comandos de sessão e estilo do chat (T1.5, #173)", () => {
  test("parser e ajuda incluem /session e /save", () => {
    expect(parseCommand("/session")).toEqual({ kind: "session" });
    expect(parseCommand("/save")).toEqual({ kind: "save" });
    expect(HELP_TEXT).toContain("/session");
    expect(HELP_TEXT).toContain("/save");
  });

  test("/session mostra id, início, modelo, turnos, tokens, custo e arquivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-session-"));
    const sessionApi = new SessionApi(join(dir, ".astro"));
    const io = new ScriptedIO(["olá", "/session", "/exit"]);
    await runRepl(new FakeSession(), io, { sessionApi });
    const line = io.outputs.find((item) => item.startsWith("sessão s1"))!;
    expect(line).toContain("início 2026-10-28T12:00:00.000Z");
    expect(line).toContain("modelo p/m1");
    expect(line).toContain("turnos 1");
    expect(line).toContain("tokens 10/5");
    expect(line).toContain("custo US$ 0.001000");
    expect(io.outputs.some((item) => item.includes("arquivo:") && item.includes(sessionApi.databasePath))).toBe(true);
    sessionApi.close();
  });

  test("/save força a gravação e imprime o caminho existente", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-save-"));
    const sessionApi = new CountingApi(join(dir, ".astro"));
    const io = new ScriptedIO(["/save", "/exit"]);
    await runRepl(new FakeSession(), io, { sessionApi });
    const saved = io.outputs.find((item) => item.startsWith("sessão salva em "))!;
    const path = saved.slice("sessão salva em ".length);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect(sessionApi.writes).toBe(2); // /save + fechamento
    sessionApi.close();
  });

  test("sem persistência, /save e /session avisam e não quebram", async () => {
    const io = new ScriptedIO(["/save", "/session", "/exit"]);
    await runRepl(new FakeSession(), io);
    expect(io.outputs).toContain("sem persistência configurada");
    expect(io.outputs.some((item) => item.startsWith("sessão s1"))).toBe(true);
  });

  test("cores ANSI só quando style está ligado", async () => {
    const plain = new ScriptedIO(["olá", "/exit"]);
    await runRepl(new FakeSession(), plain);
    expect(plain.outputs.some((item) => item.includes("\u001b["))).toBe(false);

    const colored = new ScriptedIO(["olá", "/exit"]);
    await runRepl(new FakeSession(), colored, { style: true });
    expect(colored.outputs.some((item) => item.includes("\u001b["))).toBe(true);
  });

  test("readline guarda histórico só em terminal", () => {
    expect(nodeReplOptions(true).historySize).toBeGreaterThanOrEqual(100);
    expect(nodeReplOptions(true).removeHistoryDuplicates).toBe(true);
    expect(nodeReplOptions(false).historySize).toBe(0);
  });

  test("falha de gravação vira erro e o REPL continua", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-savefail-"));
    class FailingApi extends SessionApi {
      override save(): SessionRecord {
        throw new Error("disco cheio");
      }
    }
    const sessionApi = new FailingApi(join(dir, ".astro"));
    const io = new ScriptedIO(["/save", "olá", "/exit"]);
    const session = new FakeSession();
    await runRepl(session, io, { sessionApi });
    const errors = io.outputs.filter((item) => item.startsWith("erro:"));
    expect(errors).toHaveLength(1); // mesma falha não vira spam
    expect(io.outputs.some((item) => item.startsWith("sessão salva em"))).toBe(false);
    expect(session.sent).toEqual(["olá"]); // não encerrou
    sessionApi.close();
  });

  test("falha depois de um save não deixa o caminho antigo como atual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-saveflaky-"));
    class Flaky extends SessionApi {
      calls = 0;
      override save(value: Parameters<SessionApi["save"]>[0]): SessionRecord {
        this.calls++;
        if (this.calls > 1) throw new Error("disco cheio");
        return super.save(value);
      }
    }
    const sessionApi = new Flaky(join(dir, ".astro"));
    const io = new ScriptedIO(["/save", "olá", "/session", "/exit"]);
    await runRepl(new FakeSession(), io, { sessionApi });
    expect(io.outputs.some((item) => item.includes("sessão salva em"))).toBe(true);
    const sessionLine = io.outputs.find((item) => item.startsWith("sessão s1"))!;
    expect(sessionLine).toContain("arquivo: ainda não salvo");
    sessionApi.close();
  });

  test("/save explícito responde mesmo repetindo a falha do turno", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-saveecho-"));
    class FailingApi extends SessionApi {
      override save(): SessionRecord {
        throw new Error("disco cheio");
      }
    }
    const sessionApi = new FailingApi(join(dir, ".astro"));
    const io = new ScriptedIO(["olá", "/save", "/exit"]);
    await runRepl(new FakeSession(), io, { sessionApi });
    expect(io.outputs.filter((item) => item.startsWith("erro:"))).toHaveLength(2);
    sessionApi.close();
  });
});

function savedRecord(id: string, startedAt: string, content = "conteúdo"): SessionRecord {
  return {
    schemaVersion: 1, id, startedAt, model: "p/m1",
    messages: [{ role: "user", content }], turns: 1, tokensIn: 10, tokensOut: 5, costUsd: null,
  };
}

describe("/sessions delete (#366)", () => {
  test("exclui por número e por id, purgando a cópia JSON legada e sem ecoar prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-"));
    const astroDir = join(dir, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(savedRecord("old", "2026-10-01T10:00:00.000Z", "prompt privado do old"));
    legacy.write(savedRecord("new", "2026-10-02T10:00:00.000Z", "prompt privado do new"));
    const sessionApi = new SessionApi(astroDir);
    const io = new ScriptedIO(["/sessions delete 2", "s", "/sessions delete new", "s", "/exit"]);
    try {
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("sessão excluída: old");
      expect(io.outputs).toContain("sessão excluída: new");
      expect(sessionApi.list().map(({ id }) => id)).not.toContain("old");
      expect(sessionApi.list().map(({ id }) => id)).not.toContain("new");
      expect(legacy.list()).toEqual([]);
      expect(io.outputs.join("\n")).not.toContain("prompt privado");
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolve o número exibido em /sessions mesmo após o auto-save deslocar a lista (#366)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-stale-"));
    const astroDir = join(dir, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(savedRecord("b", "2026-10-02T10:00:00.000Z", "prompt privado do b"));
    legacy.write(savedRecord("a", "2026-10-01T10:00:00.000Z", "prompt privado do a"));
    const sessionApi = new SessionApi(astroDir);
    // /sessions imprime 1. b e 2. a; o turno grava s1 (28/10) no topo e desloca os números
    const io = new ScriptedIO(["/sessions", "oi", "/sessions delete 2", "s", "/exit"]);
    try {
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("sessão excluída: a");
      expect(sessionApi.list().map(({ id }) => id)).toEqual(["s1", "b"]);
      expect(legacy.list().map(({ id }) => id)).toEqual(["b"]);

      // a lista é reimpressa já atualizada: s1 assume o número 1, b passa a 2 e a some
      const afterDelete = io.outputs.slice(io.outputs.indexOf("sessão excluída: a") + 1).join("\n");
      expect(afterDelete).toContain("1. 2026-10-28T12:00:00.000Z s1 p/m1");
      expect(afterDelete).toContain("2. 2026-10-02T10:00:00.000Z b p/m1");
      expect(afterDelete).not.toContain("2026-10-01T10:00:00.000Z");
      expect(io.outputs.join("\n")).not.toContain("prompt privado");
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolve número e id exibidos mesmo com inserções concorrentes (#366)", async () => {
    class InterleavingIO extends ScriptedIO {
      constructor(lines: string[], private readonly hooks: Record<string, () => void>) {
        super(lines);
      }
      override async read(): Promise<string | null> {
        const line = await super.read();
        if (line !== null) this.hooks[line]?.();
        return line;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-shift-"));
    const astroDir = join(dir, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(savedRecord("b", "2026-10-02T10:00:00.000Z"));
    legacy.write(savedRecord("a", "2026-10-01T10:00:00.000Z"));
    const sessionApi = new SessionApi(astroDir);
    const other = new SessionApi(astroDir);
    // /sessions imprime 1. b e 2. a; outra conexão grava c (01/11) antes do delete por número
    // e d (02/11) depois da lista refrescada, exercitando o id fora do que foi exibido
    const io = new InterleavingIO(
      ["/sessions", "/sessions delete 1", "s", "/sessions delete d", "s", "/exit"],
      {
        "/sessions delete 1": () => other.create(savedRecord("c", "2026-11-01T00:00:00.000Z")),
        "/sessions delete d": () => other.create(savedRecord("d", "2026-11-02T00:00:00.000Z")),
      },
    );
    try {
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("sessão excluída: b");
      expect(io.outputs).toContain("sessão excluída: d");
      // o fechamento do REPL autosalva a sessão atual (s1, 28/10) entre c e a
      expect(sessionApi.list().map(({ id }) => id)).toEqual(["c", "s1", "a"]);
    } finally {
      other.close();
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancelar a confirmação mantém a sessão e a cópia legada", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-cancel-"));
    const astroDir = join(dir, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(savedRecord("keep", "2026-10-01T10:00:00.000Z"));
    const sessionApi = new SessionApi(astroDir);
    const io = new ScriptedIO(["/sessions delete 1", "n", "/exit"]);
    try {
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("exclusão cancelada: keep");
      expect(sessionApi.load("keep").id).toBe("keep");
      expect(legacy.list().map(({ id }) => id)).toEqual(["keep"]);
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recusa excluir a sessão atual e valida uso e índice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-current-"));
    const sessionApi = new SessionApi(join(dir, ".astro"));
    const io = new ScriptedIO(["/sessions delete", "/sessions delete 9", "/sessions delete 1", "/exit"]);
    try {
      sessionApi.create(savedRecord("s1", "2026-10-28T12:00:00.000Z"));
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("uso: /sessions delete <número|id>");
      expect(io.outputs).toContain("índice fora da lista; use /sessions");
      expect(io.outputs).toContain("não é possível excluir a sessão atual");
      expect(sessionApi.list().map(({ id }) => id)).toEqual(["s1"]);
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recusa excluir a origem retomada, que segue viva na conversa (#366)", async () => {
    class ConfirmingIO extends ScriptedIO {
      async readFresh(prompt: string): Promise<string | null> {
        return prompt.includes("excluir a sessão") ? "s" : super.read();
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-resumed-"));
    const sessionApi = new SessionApi(join(dir, ".astro"));
    const session = new FakeSession();
    session.resumedFrom = { id: "origin", startedAt: "2026-10-01T10:00:00.000Z" };
    const io = new ConfirmingIO(["/sessions delete 1", "/exit"]);
    try {
      sessionApi.create(savedRecord("origin", "2026-10-01T10:00:00.000Z"));
      await runRepl(session, io, { sessionApi, interactive: true });

      expect(io.outputs).toContain("não é possível excluir a origem retomada (a conversa continua a partir dela)");
      expect(sessionApi.load("origin").id).toBe("origin");
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sem confirmação interativa, recusa a exclusão e preserva a sessão", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-notty-"));
    const astroDir = join(dir, ".astro");
    const legacy = new SessionStore(join(astroDir, "sessions"));
    legacy.write(savedRecord("keep", "2026-10-01T10:00:00.000Z"));
    const sessionApi = new SessionApi(astroDir);
    const io = new ScriptedIO(["/sessions delete 1", "/exit"]);
    try {
      await runRepl(new FakeSession(), io, { sessionApi });

      expect(io.outputs).toContain("exclusão exige confirmação interativa; use a TUI (/sessions, d)");
      expect(sessionApi.load("keep").id).toBe("keep");
      expect(legacy.list().map(({ id }) => id)).toEqual(["keep"]);
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falha da exclusão vira erro redigido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-chat-delete-error-"));
    const astroDir = join(dir, ".astro");
    new SessionStore(join(astroDir, "sessions")).write(savedRecord("other", "2026-10-01T10:00:00.000Z"));
    class FailingApi extends SessionApi {
      override delete(): boolean {
        throw new Error("falha apiKey=SEGREDO123");
      }
    }
    const sessionApi = new FailingApi(astroDir);
    const io = new ScriptedIO(["/sessions delete 1", "s", "/exit"]);
    try {
      await runRepl(new FakeSession(), io, { sessionApi, interactive: true });

      const error = io.outputs.find((item) => item.startsWith("erro:"))!;
      expect(error).toContain("falha");
      expect(error).not.toContain("SEGREDO123");
    } finally {
      sessionApi.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
