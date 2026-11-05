import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession } from "../src/chat/repl";
import type { SessionSnapshot } from "../src/chat/agent-session";
import type { PermissionMode } from "../src/permissions";
import type { BudgetStatus } from "../src/budget";
import { SessionStore } from "../src/chat/store";
import { SessionApi } from "../src/chat/session-api";
import { runCommand, type CommandState } from "../src/tui/commands";
import type { Theme } from "../src/tui/theme";

class FakeSession implements ChatSession {
  model = "p/m1";
  cleared = 0;
  forced: boolean | undefined;
  send(): Promise<never> {
    throw new Error("não usado");
  }
  compact(force?: boolean): Promise<string> {
    this.forced = force;
    return Promise.resolve("compactado");
  }
  clear(): void {
    this.cleared++;
    this.resumedFrom = undefined;
  }
  setModel(ref: string): string {
    if (ref === "ghost") throw new Error("modelo desconhecido");
    this.model = ref;
    return ref;
  }
  listModels(): string[] {
    return ["p/m1", "p/m2"];
  }
  listProviders() {
    return [{ name: "p", kind: "openai-compat", credentialRef: "KEY", quotaDomain: "default", models: ["m1"] }];
  }
  setProvider(name: string): string {
    if (name === "ghost") throw new Error('provider "ghost" não está configurado');
    return `${name}/m1`;
  }
  resumed: SessionSnapshot[] = [];
  resumedFrom: { id: string; startedAt: string } | undefined;
  resume(snapshot: SessionSnapshot): void {
    this.resumed.push(snapshot);
    this.resumedFrom = { id: snapshot.id, startedAt: snapshot.startedAt };
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.5,
      ...(this.resumedFrom === undefined ? {} : { resumedFrom: this.resumedFrom }),
    };
  }
  close(): void {}
}

describe("comandos da TUI (T2, #63)", () => {
  test("ajuda, clear, modelo e provider produzem entradas", async () => {
    const session = new FakeSession();
    const help = await runCommand({ kind: "help" }, session, {});
    expect(help.entries[0]!.text).toContain("Comandos:");

    expect((await runCommand({ kind: "clear" }, session, {})).entries[0]!.text).toBe("contexto limpo");
    expect(session.cleared).toBe(1);

    expect((await runCommand({ kind: "model", model: "p/m2" }, session, {})).entries[0]!.text).toBe("modelo: p/m2");
    const bad = await runCommand({ kind: "model", model: "ghost" }, session, {});
    expect(bad.entries[0]).toMatchObject({ kind: "error" });
    expect(bad.entries[0]!.text).toContain("modelo desconhecido");

    expect((await runCommand({ kind: "provider", action: "use", target: "p" }, session, {})).entries[0]!.text).toBe("provider: p/m1");
  });

  test("/providers abre a tela de providers na TUI, sem texto (#287)", async () => {
    const session = new FakeSession();
    const outcome = await runCommand({ kind: "providers" }, session, {});
    expect(outcome.openProviders).toEqual({ mode: "list" });
    expect(outcome.entries).toEqual([]);
  });

  test("session mostra o último arquivo; sem store avisa", async () => {
    const session = new FakeSession();
    const withFile = await runCommand({ kind: "session" }, session, { lastFile: "/tmp/s.json" }, { store: new SessionStore("/tmp") });
    expect(withFile.entries[0]!.text).toContain("arquivo: /tmp/s.json");
    expect(withFile.entries[0]!.text).toContain("turnos 2");
    const without = await runCommand({ kind: "session" }, session, {});
    expect(without.entries[0]!.text).toContain("arquivo: sem persistência");
  });

  test("save grava sanitizado e devolve o caminho; falha vira erro", async () => {
    const session = new FakeSession();
    const dir = mkdtempSync(join(tmpdir(), "astro-tui-save-"));
    const ok = await runCommand({ kind: "save" }, session, {}, { store: new SessionStore(dir) });
    expect(ok.entries[0]!.text).toMatch(/^sessão salva em /);
    expect(ok.lastFile).toBeDefined();

    const blocked = join(dir, "blocked");
    await Bun.write(blocked, "arquivo");
    const failed = await runCommand({ kind: "save" }, session, {}, { store: new SessionStore(blocked) });
    expect(failed.entries[0]).toMatchObject({ kind: "error" });
    expect(failed.entries[0]!.text).toMatch(/^erro: /);
    expect(failed.lastFile).toBeNull(); // limpa o caminho anterior
  });

  test("falha de save com segredo na mensagem não vaza", async () => {
    const session = new FakeSession();
    class Leaky extends SessionStore {
      override write(): string {
        throw new Error("falhou com sk-live-SEGREDO123");
      }
    }
    const outcome = await runCommand(
      { kind: "save" }, session, {}, { store: new Leaky(mkdtempSync(join(tmpdir(), "astro-tui-leak-"))) },
    );
    expect(outcome.entries[0]!.text).not.toContain("sk-live-SEGREDO123");
    expect(outcome.entries[0]!.text).toMatch(/^erro: /);
  });

  test("comando desconhecido sugere o mais próximo; exit encerra (#275)", async () => {
    const session = new FakeSession();
    const mod = await runCommand({ kind: "unknown", raw: "mod" }, session, {});
    expect(mod.entries[0]!.text).toBe("comando desconhecido: /mod — você quis dizer /mode?");
    const nope = await runCommand({ kind: "unknown", raw: "nope" }, session, {});
    expect(nope.entries[0]!.text).toBe("comando desconhecido: /nope — você quis dizer /mode?"); // dist 2 = threshold de "mode" (#271)
    expect((await runCommand({ kind: "exit" }, session, {})).exit).toBe(true);
  });

  test("sessions abre o picker e resume carrega a sessão pelo número (#64)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-tui-resume-"));
    const astroDir = join(dir, ".astro");
    const store = new SessionStore(join(astroDir, "sessions"));
    store.write({
      id: "abc", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "velho" }], turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
    });
    const api = new SessionApi(astroDir);
    const session = new FakeSession();
    const state: { lastFile?: string } = {};
    try {
      const list = await runCommand({ kind: "sessions" }, session, state as never, { store, sessionApi: api });
      // na TUI o /sessions abre o modal; a lista não vai mais como texto para o histórico
      expect(list).toMatchObject({ entries: [], openSessions: true });
      const resumed = await runCommand({ kind: "resume", ref: "1" }, session, state as never, { store, sessionApi: api });
      expect(resumed.entries[0]!.text).toBe("sessão retomada: abc (1 turnos)");
      expect(resumed.lastFile).toBeNull();
      expect(session.resumed[0]!.id).toBe("abc");
      const sessionInfo = await runCommand({ kind: "session" }, session, state as never, { store, sessionApi: api });
      expect(sessionInfo.entries[0]!.text).toContain("retomada de abc");

      await runCommand({ kind: "clear" }, session, state as never, { store, sessionApi: api });
      const afterClear = await runCommand({ kind: "session" }, session, state as never, { store, sessionApi: api });
      expect(afterClear.entries[0]!.text).not.toContain("retomada de");
    } finally {
      api.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("/resume da TUI carrega pelo resumo da SessionApi sem depender do caminho JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "astro-tui-resume-api-"));
    const api = new SessionApi(join(root, ".astro"));
    api.create({
      schemaVersion: 1, id: "older", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "old" }], turns: 1, tokensIn: 1, tokensOut: 1, costUsd: null,
    });
    api.create({
      schemaVersion: 1, id: "newer", startedAt: "2026-10-02T10:00:00.000Z", model: "p/m2",
      messages: [
        { role: "user", content: "new" },
        { role: "assistant", content: "", toolCalls: [{ id: "call", name: "tool", arguments: "{}" }] },
        { role: "tool", toolCallId: "call", content: "result" },
      ],
      turns: 2, tokensIn: 2, tokensOut: 2, costUsd: 0.1,
      resumedFrom: { id: "older", startedAt: "2026-10-01T10:00:00.000Z" },
    });
    const session = new FakeSession();
    try {
      expect(api.list().map(({ id }) => id)).toEqual(["newer", "older"]);
      const resumed = await runCommand(
        { kind: "resume", ref: "1" }, session, {},
        { store: new SessionStore(join(root, "empty-json-store")), sessionApi: api },
      );
      expect(resumed.entries[0]!.text).toBe("sessão retomada: newer (2 turnos)");
      expect(resumed.lastFile).toBeNull();
      expect(session.resumed[0]).toMatchObject({
        id: "newer",
        messages: [{ role: "user", content: "new" }, { role: "assistant", toolCalls: [{ id: "call" }] }, { role: "tool", content: "result" }],
        resumedFrom: { id: "older", startedAt: "2026-10-01T10:00:00.000Z" },
      });
    } finally {
      api.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("sem store, /session mantém a origem e avisa sobre a persistência", async () => {
    const session = new FakeSession();
    session.resumedFrom = { id: "abc", startedAt: "2026-10-01T10:00:00.000Z" };
    const out = await runCommand({ kind: "session" }, session, {});
    expect(out.entries[0]!.text).toContain("retomada de abc");
    expect(out.entries[0]!.text).toContain("arquivo: sem persistência");
  });

  test("/details partilha o formatter com /session", async () => {
    const session = new FakeSession();
    const state = { lastFile: "/tmp/s.json" };
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "astro-tui-details-")));
    const sessionOut = await runCommand({ kind: "session" }, session, state, { store });
    const detailsOut = await runCommand({ kind: "details" }, session, state, { store });
    expect(detailsOut.entries[0]!.text).toBe(sessionOut.entries[0]!.text);
    expect(detailsOut.entries[0]!.text).toContain("uptime");
    expect(detailsOut.entries[0]!.text).toContain("provider: p");
    expect(detailsOut.entries[0]!.text).toContain("modelo p/m1");
    expect(detailsOut.entries[0]!.text).toContain("turnos 2");
    expect(detailsOut.entries[0]!.text).toContain("tokens 20/10");
    expect(detailsOut.entries[0]!.text).toContain("custo US$ 0.500000");
    expect(detailsOut.entries[0]!.text).toContain("arquivo: /tmp/s.json");
  });

  test("/details sem store avisa e mantém retomada", async () => {
    const session = new FakeSession();
    session.resumedFrom = { id: "xyz", startedAt: "2026-10-27T10:00:00.000Z" };
    const out = await runCommand({ kind: "details" }, session, {});
    expect(out.entries[0]!.text).toContain("retomada de xyz");
    expect(out.entries[0]!.text).toContain("arquivo: sem persistência");
  });
  test("resume sem /sessions recarrega a lista e valida o índice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-tui-resume2-"));
    const astroDir = join(dir, ".astro");
    const store = new SessionStore(join(astroDir, "sessions"));
    store.write({
      id: "xyz", startedAt: "2026-10-02T10:00:00.000Z", model: "p/m1",
      messages: [{ role: "user", content: "guardado" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.002,
    });
    const api = new SessionApi(astroDir);
    const session = new FakeSession();
    const ok = await runCommand({ kind: "resume", ref: "1" }, session, {}, { store, sessionApi: api });
    expect(ok.entries[0]!.text).toBe("sessão retomada: xyz (2 turnos)");
    const bad = await runCommand({ kind: "resume", ref: "9" }, session, {}, { store, sessionApi: api });
    expect(bad.entries[0]!.text).toBe("índice fora da lista; use /sessions");
    expect(session.resumed).toHaveLength(1);
    api.close();
  });

  test("/compact force repassa force=true ao compactar (CMP-6)", async () => {
    const session = new FakeSession();
    const plain = await runCommand({ kind: "compact" }, session, {});
    expect(plain.entries[0]!.text).toBe("compactado");
    expect(session.forced).toBe(false);

    await runCommand({ kind: "compact", force: true }, session, {});
    expect(session.forced).toBe(true);
  });

  test("export e init gravam no cwd e recusam escape", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-tui-export-"));
    const session = new FakeSession();
    const exported = await runCommand({ kind: "export" }, session, {}, { cwd });
    expect(exported.entries[0]!.text).toContain("sessão exportada em");
    expect(existsSync(join(cwd, ".astro", "exports"))).toBe(true);

    const escape = await runCommand({ kind: "export", path: "../fora.md" }, session, {}, { cwd });
    expect(escape.entries[0]).toMatchObject({ kind: "error" });
    expect(escape.entries[0]!.text).toContain("fora do cwd");

    expect((await runCommand({ kind: "init" }, session, {}, { cwd })).entries[0]!.text).toContain("AGENTS.md criado");
    expect((await runCommand({ kind: "init" }, session, {}, { cwd })).entries[0]!.text).toContain("já existe");
  });
});

class ModeSession extends FakeSession {
  mode: PermissionMode = "ask";
  permissionMode(): PermissionMode {
    return this.mode;
  }
  setPermissionMode(mode: PermissionMode): PermissionMode {
    this.mode = mode;
    return this.mode;
  }
}

describe("/mode na TUI (#271)", () => {
  test("sem arg lista os modos e marca o ativo", async () => {
    const session = new ModeSession();
    const out = await runCommand({ kind: "mode" }, session, {});
    expect(out.entries[0]).toMatchObject({ kind: "info" });
    expect(out.entries[0]!.text).toBe("  bypass\n  allow-edits\n→ ask\nativo: ask");
  });

  test("modo válido troca e reflete na sessão", async () => {
    const session = new ModeSession();
    const out = await runCommand({ kind: "mode", mode: "allow-edits" }, session, {});
    expect(out.entries[0]).toMatchObject({ kind: "info", text: "modo: allow-edits" });
    expect(session.mode).toBe("allow-edits");
  });

  test("bypass sem confirm não troca e avisa; com confirm troca", async () => {
    const session = new ModeSession();
    const warn = await runCommand({ kind: "mode", mode: "bypass" }, session, {});
    expect(warn.entries[0]!.kind).toBe("error");
    expect(warn.entries[0]!.text).toContain("/mode bypass confirm");
    expect(session.mode).toBe("ask");
    const ok = await runCommand({ kind: "mode", mode: "bypass", confirm: true }, session, {});
    expect(ok.entries[0]).toMatchObject({ kind: "info", text: "modo: bypass" });
    expect(session.mode).toBe("bypass");
  });

  test("modo inválido lista os válidos; sessão sem setPermissionMode dá erro", async () => {
    const session = new ModeSession();
    const bad = await runCommand({ kind: "mode", mode: "yolo" }, session, {});
    expect(bad.entries[0]!.kind).toBe("error");
    expect(bad.entries[0]!.text).toContain("bypass, allow-edits, ask");
    expect(session.mode).toBe("ask");
    const plain = new FakeSession();
    const nope = await runCommand({ kind: "mode", mode: "ask" }, plain, {});
    expect(nope.entries[0]!.kind).toBe("error");
    expect(nope.entries[0]!.text).toContain("não aceita trocar");
  });
});

describe("/config na TUI (#273)", () => {
  test("/config pede para abrir a tela de configuração, sem texto (#273)", async () => {
    const session = new FakeSession();
    const outcome = await runCommand({ kind: "config" }, session, {});
    expect(outcome.openConfig).toBe(true);
    expect(outcome.entries).toEqual([]);
  });
});

describe("/usage na TUI (#63)", () => {
  class UsageSession extends FakeSession {
    budgetStatus(): BudgetStatus {
      return {
        scope: "day", limitUsd: 5, spentUsd: 1, ratio: 0.2, warnAt: 0.8,
        warning: false, exhausted: false, ceilingHit: false,
        remainingUsd: 4, reservedUsd: 0, estimate: "US$ 1.000000",
      };
    }
  }

  test("imprime uso da sessão + budget como entrada info", async () => {
    const session = new UsageSession();
    const out = await runCommand({ kind: "usage" }, session, {});
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ kind: "info" });
    expect(out.entries[0]!.text).toContain("uso da sessão: 2 turno(s) · in 20 / out 10 tokens · custo US$ 0.500000");
    expect(out.entries[0]!.text).toContain("budget day: gasto US$ 1.000000 / limite US$ 5.000000 (20%) · restante US$ 4.000000 · aviso em 80%");
  });

  test("sem budgetStatus imprime só a linha da sessão", async () => {
    const session = new FakeSession();
    const out = await runCommand({ kind: "usage" }, session, {});
    expect(out.entries[0]!.text).toBe("uso da sessão: 2 turno(s) · in 20 / out 10 tokens · custo US$ 0.500000");
  });
});

describe("/theme na TUI (#64)", () => {
  const state = (theme: Theme, setTheme?: (theme: Theme) => void): CommandState =>
    ({ theme, ...(setTheme === undefined ? {} : { setTheme }) });

  test("sem arg lista os três temas com o ativo marcado", async () => {
    const out = await runCommand({ kind: "theme" }, new FakeSession(), state("light"));
    expect(out.entries[0]).toMatchObject({ kind: "info" });
    expect(out.entries[0]!.text).toBe("  dark\n→ light\n  contrast\nativo: light");
  });

  test("tema válido aplica e confirma", async () => {
    const applied: Theme[] = [];
    const out = await runCommand({ kind: "theme", theme: "contrast" }, new FakeSession(), state("dark", (theme) => applied.push(theme)));
    expect(applied).toEqual(["contrast"]);
    expect(out.entries[0]).toMatchObject({ kind: "info", text: "tema: contrast" });
  });

  test("tema inválido lista os válidos e sessão sem setTheme avisa", async () => {
    const bad = await runCommand({ kind: "theme", theme: "neon" }, new FakeSession(), state("dark", () => {}));
    expect(bad.entries[0]!.kind).toBe("error");
    expect(bad.entries[0]!.text).toBe("tema inválido (use dark, light, contrast)");
    const plain = await runCommand({ kind: "theme", theme: "light" }, new FakeSession(), state("dark"));
    expect(plain.entries[0]!.kind).toBe("error");
    expect(plain.entries[0]!.text).toContain("tema indisponível");
  });

  test("argumento inválido com cara de segredo não é ecoado (I-03, #64)", async () => {
    const out = await runCommand({ kind: "theme", theme: "sk-ant-api03-segredo" }, new FakeSession(), state("dark", () => {}));
    expect(out.entries[0]!.kind).toBe("error");
    expect(out.entries[0]!.text).toBe("tema inválido (use dark, light, contrast)");
    expect(out.entries[0]!.text).not.toContain("sk-ant");
  });

  test("falha ao persistir vira erro redacted sem derrubar a TUI", async () => {
    const out = await runCommand({ kind: "theme", theme: "light" }, new FakeSession(), state("dark", () => {
      throw new Error("falha ao gravar .astro/tui.json");
    }));
    expect(out.entries[0]!.kind).toBe("error");
    expect(out.entries[0]!.text).toBe("erro: falha ao gravar .astro/tui.json");
  });
});