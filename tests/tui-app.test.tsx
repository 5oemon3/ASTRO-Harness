import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiApp } from "../src/tui/app";
import { SessionStore } from "../src/chat/store";
import type { ChatSession } from "../src/chat/repl";
import type { SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import type { ConfigSummary } from "../src/chat/config-summary";
import { BudgetExceededError, type BudgetStatus } from "../src/budget";
import type { PermissionMode } from "../src/permissions";
import { createApprovalBridge } from "../src/tui/approvals";

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: string[] = [];
  cleared = 0;
  failNext = false;
  compact(): Promise<string> {
    return Promise.resolve("não usado");
  }
  async send(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
    this.sent.push(prompt);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    void signal;
    return {
      final: `eco:${prompt}`, model: this.model, steps: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
      totalTokensIn: 10 * this.sent.length, totalTokensOut: 5 * this.sent.length,
      totalCostUsd: 0.001 * this.sent.length, contextTokens: 10, contextLimit: 100, contextRatio: 0.1,
      warning: false, trimmed: false,
    };
  }
  clear(): void {
    this.cleared++;
  }
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
  healthCalls = 0;
  health() {
    this.healthCalls++;
    return Promise.resolve({
      status: "degraded" as const,
      checks: [{ name: "provider:p", status: "ok" as const, latencyMs: 5 }],
    });
  }
  providerName(): string {
    return this.model.split("/")[0]!;
  }
  resumed: string[] = [];
  resumedFrom: { id: string; startedAt: string } | undefined;
  resume(snapshot: SessionSnapshot): void {
    this.resumed.push(snapshot.id);
    this.resumedFrom = { id: snapshot.id, startedAt: snapshot.startedAt };
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-10-28T12:00:00.000Z", model: this.model,
      messages: [{ role: "user", content: "x" }], turns: this.sent.length,
      tokensIn: 10 * this.sent.length, tokensOut: 5 * this.sent.length, costUsd: 0.001,
      ...(this.resumedFrom === undefined ? {} : { resumedFrom: this.resumedFrom }),
    };
  }
  close(): void {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

/** A status bar quebra linha em terminais estreitos; normaliza antes de procurar. */
function frameHas(instance: ReturnType<typeof render>, text: string): boolean {
  return (instance.lastFrame() ?? "").replace(/\s+/g, " ").includes(text);
}

test("banner no topo mostra versão, provider, modelo, endpoint e estado (#274)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-banner-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "ASTRO v"));
    const frame = (instance.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("ASTRO v");
    expect(frame).toMatch(/ASTRO v\d+\.\d+\.\d+/);
    expect(frame).toContain("p · p/m1");
    expect(frame).toContain("estado:");
  } finally {
    instance.unmount();
  }
});

class BypassSession extends FakeSession {
  permissionMode(): PermissionMode {
    return "bypass";
  }
}

test("footer e banner mostram o modo de permissão ativo; bypass aparece (#270)", async () => {
  const session = new BypassSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-mode-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "modo: bypass"));
    const frame = (instance.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("modo: bypass");
    // banner (topo) também traz o modo
    const topo = (instance.lastFrame() ?? "").split("\n").slice(0, 3).join(" ");
    expect(topo).toContain("modo: bypass");
  } finally {
    instance.unmount();
  }
});

test("sessão sem permissionMode cai no default ask no footer (#270)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-mode-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "modo: ask"));
    expect((instance.lastFrame() ?? "").replace(/\s+/g, " ")).toContain("modo: ask");
  } finally {
    instance.unmount();
  }
});

test("mostra boas-vindas, status e responde um turno", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" branch="main" />);
  try {
    expect(instance.lastFrame()).toContain("astro tui");
    expect(instance.lastFrame()).toContain("/tmp/astro (main)");
    expect(instance.lastFrame()).toContain("p/m1");

    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:olá") === true);
    expect(instance.lastFrame()).toContain("1 step(s)");
    expect(session.sent).toEqual(["olá"]);
    expect(instance.lastFrame()).toContain("1 turno(s)");
  } finally {
    instance.unmount();
  }
});

test("status bar mostra saúde n/d e atualiza após troca de provider", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-health-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "saúde: n/d"));
    expect(session.healthCalls).toBe(0);
    instance.stdin.write("/provider use p");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "saúde: ok"));
    expect(session.healthCalls).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("saúde de um provider não é reaproveitada por outro após /model", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-health-stale-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/provider use p");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "saúde: ok"));
    instance.stdin.write("/model p2/m2");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "saúde: n/d"));
    expect(session.healthCalls).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("comandos /help, /model e /clear aparecem no painel", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-help-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/help");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Comandos:") === true);

    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);

    instance.stdin.write("/clear");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("contexto limpo") === true);
    expect(session.cleared).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("falha ao gravar a config não derruba a TUI", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-bad-config-"));
  writeFileSync(join(cwd, ".astro"), "não é diretório", "utf8");
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    await waitFor(() => instance.lastFrame()?.includes("erro:") === true);
  } finally { instance.unmount(); }
});

test("ctrl+c durante o turno aborta e encerra depois", async () => {
  class Slow extends FakeSession {
    aborted = false;
    override async send(_prompt: string, signal?: AbortSignal): Promise<TurnResult> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener("abort", () => {
          this.aborted = true;
          clearTimeout(timer);
          reject(new Error("cancelado"));
        });
      });
      return { ...(await super.send("depois")) };
    }
  }
  const session = new Slow();
  let exits = 0;
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("demora");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    expect(exits).toBe(0);

    instance.stdin.write("\u0003");
    await waitFor(() => exits === 1);
    expect(session.aborted).toBe(true);
    expect(instance.lastFrame()).toContain("erro: cancelado");
  } finally {
    instance.unmount();
  }
});

test("erro fatal de sessão encerra a TUI", async () => {
  class Fatal extends FakeSession {
    override async send(): Promise<TurnResult> {
      throw new Error("budget", { cause: new BudgetExceededError("limit", {} as never) });
    }
  }
  let exits = 0;
  const instance = render(<TuiApp session={new Fatal()} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("x");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
    expect(instance.lastFrame()).toContain("erro: budget");
  } finally {
    instance.unmount();
  }
});

test("ignora Enter durante o turno e atualiza o status após /model", async () => {
  class Slow extends FakeSession {
    override async send(prompt: string, signal?: AbortSignal): Promise<TurnResult> {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return super.send(prompt, signal);
    }
  }
  const session = new Slow();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-busy-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("demora");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    instance.stdin.write("outra");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:demora") === true);
    expect(session.sent).toEqual(["demora"]);

    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    expect(instance.lastFrame()).toMatch(/p\/m2 · 1 turno\(s\)/);
  } finally {
    instance.unmount();
  }
});

test("falha de gravação limpa o caminho mostrado por /session", async () => {
  class Flaky extends SessionStore {
    calls = 0;
    override write(snapshot: Parameters<SessionStore["write"]>[0]): string {
      this.calls++;
      if (this.calls > 1) throw new Error("disco cheio");
      return super.write(snapshot);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-store-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" store={new Flaky(dir)} />);
  try {
    instance.stdin.write("/save");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sessão salva em") === true);

    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro: disco cheio") === true);

    instance.stdin.write("/session");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("ainda não salvo") === true);
  } finally {
    instance.unmount();
  }
});

test("/exit encerra e erro de turno não fecha a TUI", async () => {
  const session = new FakeSession();
  let exits = 0;
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    session.failNext = true;
    instance.stdin.write("falha");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro: boom") === true);
    expect(exits).toBe(0);

    instance.stdin.write("depois");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:depois") === true);

    instance.stdin.write("/exit");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
  } finally {
    instance.unmount();
  }
});

test("pergunta de aprovação aparece no painel e libera o turno", async () => {
  const bridge = createApprovalBridge();
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" approvals={bridge} />);
  try {
    const decision = bridge.approveSwap({
      run: "r", from: { provider: "a", model: "m1" }, to: { provider: "b", model: "m2" }, reason: "fallback",
    });
    await waitFor(() => instance.lastFrame()?.includes("aprovar? [s/N]") === true);
    instance.stdin.write("s");
    instance.stdin.write("\r");
    expect(await decision).toBe(true);
    expect(instance.lastFrame()?.includes("aprovar? [s/N]")).toBe(false);
  } finally {
    instance.unmount();
  }
});

test("pergunta de aprovação de edit abre o overlay de diff com tab e a resposta segue depois (#64 D2)", async () => {
  const bridge = createApprovalBridge();
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" approvals={bridge} />);
  try {
    const decision = bridge.approveTool({
      name: "edit", action: "edit", mode: "ask",
      diff: { path: "src/a.ts", content: "@@ -1 +1 @@\n-old\n+new\n" },
    });
    await waitFor(() => instance.lastFrame()?.includes("tab ver diff") === true);
    instance.stdin.write("\t");
    await waitFor(() => instance.lastFrame()?.includes("diff · src/a.ts") === true);
    expect(instance.lastFrame()).toContain("-old");
    expect(instance.lastFrame()).toContain("+new");
    instance.stdin.write("\u001b"); // esc volta para a pergunta
    await waitFor(() => {
      const frame = instance.lastFrame() ?? "";
      return frame.includes("tab ver diff") && !frame.includes("diff · src/a.ts");
    });
    instance.stdin.write("s");
    instance.stdin.write("\r");
    expect(await decision).toBe(true);
    await waitFor(() => instance.lastFrame()?.includes("tab ver diff") === false);
  } finally {
    instance.unmount();
  }
});

test("pergunta nova sem diff fecha o overlay e libera a entrada (#64 D2)", async () => {
  const bridge = createApprovalBridge();
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" approvals={bridge} />);
  try {
    // primeira pergunta com diff abre o overlay via tab
    void bridge.approveTool({
      name: "edit", action: "edit", mode: "ask",
      diff: { path: "src/a.ts", content: "@@ -1 +1 @@\n-old\n+new\n" },
    });
    await waitFor(() => instance.lastFrame()?.includes("tab ver diff") === true);
    instance.stdin.write("\t");
    await waitFor(() => instance.lastFrame()?.includes("diff · src/a.ts") === true);
    // ask sobrescreve pending sem passar por undefined: pergunta nova sem diff
    const second = bridge.askText("confiar nesta pasta?");
    await waitFor(() => {
      const frame = instance.lastFrame() ?? "";
      return frame.includes("confiar nesta pasta?") && !frame.includes("diff · src/a.ts");
    });
    instance.stdin.write("s");
    instance.stdin.write("\r");
    expect(await second).toBe("s");
    // entrada volta a funcionar (teclas não são mais engolidas pelo overlay)
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("eco:oi") === true);
  } finally {
    instance.unmount();
  }
});

test("/exit grava a sessão sanitizada antes de fechar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-exit-"));
  let exits = 0;
  const instance = render(
    <TuiApp session={new FakeSession()} cwd="/tmp/astro" store={new SessionStore(dir)} onExit={() => { exits++; }} />,
  );
  try {
    instance.stdin.write("/exit");
    instance.stdin.write("\r");
    await waitFor(() => exits === 1);
    expect(readdirSync(dir).some((name) => name.endsWith(".json"))).toBe(true);
  } finally {
    instance.unmount();
  }
});

test("segundo ctrl+c força a saída mesmo com o provider travado", async () => {
  class Stuck extends FakeSession {
    override send(): Promise<TurnResult> {
      return new Promise(() => {});
    }
  }
  let exits = 0;
  const instance = render(<TuiApp session={new Stuck()} cwd="/tmp/astro" onExit={() => { exits++; }} />);
  try {
    instance.stdin.write("trava");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("pensando…") === true);
    instance.stdin.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exits).toBe(0);
    instance.stdin.write("\u0003");
    await waitFor(() => exits === 1);
  } finally {
    instance.unmount();
  }
});
test("/sessions abre o painel e /resume por id retoma a sessão vista (#64)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-tui-panel-sessions-"));
  const store = new SessionStore(dir);
  store.write({
    id: "xyz", startedAt: "2026-10-02T10:00:00.000Z", model: "p/m1",
    messages: [{ role: "user", content: "guardado" }], turns: 2, tokensIn: 20, tokensOut: 10, costUsd: 0.002,
  });
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-resume-"));
  const instance = render(<TuiApp session={session} cwd={cwd} store={store} />);
  try {
    instance.stdin.write("/sessions");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("xyz") === true);
    await new Promise((resolve) => setTimeout(resolve, 50)); // assenta os hooks do modal
    instance.stdin.write("\u001b"); // esc fecha o painel
    await waitFor(() => (instance.lastFrame() ?? "").includes("Sessões") === false);
    await new Promise((resolve) => setTimeout(resolve, 50)); // assenta o handler do painel principal

    instance.stdin.write("/resume xyz");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sessão retomada: xyz") === true);
    expect(session.resumed).toEqual(["xyz"]);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { lastModel?: string };
    expect(config.lastModel).toBe("p/m1");

    instance.stdin.write("/session");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("retomada de xyz") === true);
  } finally {
    instance.unmount();
  }
});
test("Tab completa comando e @arquivo no painel", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-complete-"));
  writeFileSync(join(cwd, "notas.md"), "# notas", "utf8");
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/re");
    await waitFor(() => instance.lastFrame()?.includes("/resume") === true);
    instance.stdin.write("\t");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sem persistência configurada") === true);

    instance.stdin.write("leia @not");
    await waitFor(() => instance.lastFrame()?.includes("@notas.md") === true);
    instance.stdin.write("\t");
    await waitFor(() => instance.lastFrame()?.includes("leia @notas.md") === true);
    instance.stdin.write("\r");
    await waitFor(() => session.sent.includes("leia @notas.md") === true);
  } finally {
    instance.unmount();
  }
});

test("reindexa ao digitar @ e vê arquivo criado depois do mount", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-reindex-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    writeFileSync(join(cwd, "novo.md"), "x", "utf8");
    instance.stdin.write("leia @nov");
    await waitFor(() => instance.lastFrame()?.includes("@novo.md") === true);
  } finally {
    instance.unmount();
  }
});

test("!cmd roda pelo shell runner e não vira turno", async () => {
  const calls: string[] = [];
  const shell = {
    enabled: true,
    run: async (command: string) => {
      calls.push(command);
      return command === "falha"
        ? { output: "erro do shell", isError: true }
        : { output: `saida:${command}`, isError: false };
    },
  };
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" shell={shell} />);
  try {
    instance.stdin.write("!echo oi");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("saida:echo oi") === true);
    expect(calls).toEqual(["echo oi"]);
    expect(session.sent).toEqual([]);

    instance.stdin.write("!falha");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("erro do shell") === true);
  } finally {
    instance.unmount();
  }
});

test("ctrl+x c limpa o contexto e ctrl+x t alterna o tema persistido", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-keys-"));
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("\u0018");
    instance.stdin.write("c");
    await waitFor(() => instance.lastFrame()?.includes("contexto limpo") === true);
    expect(session.cleared).toBe(1);

    instance.stdin.write("\u0018");
    instance.stdin.write("t");
    await waitFor(() => instance.lastFrame()?.includes("tema: light") === true);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { theme?: string };
    expect(config.theme).toBe("light");
  } finally {
    instance.unmount();
  }
});

test("/model persiste o último modelo em .astro/tui.json", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-model-"));
  const instance = render(<TuiApp session={new FakeSession()} cwd={cwd} />);
  try {
    instance.stdin.write("/model p/m2");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("modelo: p/m2") === true);
    const config = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { lastModel?: string };
    expect(config.lastModel).toBe("p/m2");
  } finally {
    instance.unmount();
  }
});

test("mostra deltas e substitui pela resposta final", async () => {
  class Streamer extends FakeSession {
    override async send(prompt: string, signal?: AbortSignal, onToken?: (text: string) => void): Promise<TurnResult> {
      onToken?.("par");
      await new Promise((resolve) => setTimeout(resolve, 40));
      onToken?.("cial");
      await new Promise((resolve) => setTimeout(resolve, 60));
      return super.send(prompt, signal);
    }
  }
  const instance = render(<TuiApp session={new Streamer()} cwd="/tmp/astro" />);
  try {
    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("parcial") === true);
    await waitFor(() => instance.lastFrame()?.includes("eco:olá") === true);
    expect(instance.lastFrame()).not.toContain("parcial");
  } finally {
    instance.unmount();
  }
});

test("streaming com throttle longo: leading edge imediata e resto bufferizado na janela (#64)", async () => {
  class FastStreamer extends FakeSession {
    override async send(prompt: string, signal?: AbortSignal, onToken?: (text: string) => void): Promise<TurnResult> {
      onToken?.("par");
      await new Promise((resolve) => setTimeout(resolve, 20));
      onToken?.("cial");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return super.send(prompt, signal);
    }
  }
  const instance = render(<TuiApp session={new FastStreamer()} cwd="/tmp/astro" streamThrottleMs={1000} />);
  try {
    instance.stdin.write("olá");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("par") === true);
    // dentro da janela de 1000ms o resto fica bufferizado (não renderiza "parcial")
    expect(instance.lastFrame()).not.toContain("parcial");
    await waitFor(() => instance.lastFrame()?.includes("eco:olá") === true);
    expect(instance.lastFrame()).not.toContain("parcial");
  } finally {
    instance.unmount();
  }
});

test("histórico longo é virtualizado com marcador de mensagens anteriores (#64)", async () => {
  const instance = render(<TuiApp session={new FakeSession()} cwd="/tmp/astro" historyLimit={3} />);
  try {
    for (const msg of ["m1", "m2", "m3"]) {
      instance.stdin.write(msg);
      instance.stdin.write("\r");
      await waitFor(() => instance.lastFrame()?.includes(`eco:${msg}`) === true);
    }
    // 1 boas-vindas + 3 turnos × (user/assistant/info) = 10 entradas; janela = 3 → 7 ocultas
    await waitFor(() => frameHas(instance, "… 7 mensagens anteriores"));
    expect(frameHas(instance, "eco:m3")).toBe(true);
  } finally {
    instance.unmount();
  }
});

test("/config abre a tela de configuração e trocar o modo atualiza o footer (#273)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-config-"));
  class ConfigSession extends FakeSession {
    mode: PermissionMode = "ask";
    readonly saved: PermissionMode[] = [];
    permissionMode(): PermissionMode {
      return this.mode;
    }
    configSummary(): ConfigSummary {
      return {
        configPath: join(cwd, "astro.config.json"),
        maxTurns: "12",
        permissionMode: this.mode,
        costs: [{ ref: "p/m1", inputPerM: 1, outputPerM: 2 }],
        budget: "sem budget",
      };
    }
    savePermissionMode(mode: PermissionMode): PermissionMode {
      this.saved.push(mode);
      this.mode = mode;
      return this.mode;
    }
  }
  const session = new ConfigSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "modo: ask"));
    instance.stdin.write("/config");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("Configuração") === true);
    // a tela nova é montada por update: o useEffect que assina o input roda depois do
    // frame — assentamos antes da primeira tecla para não perdê-la
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.lastFrame()).toContain("run.maxTurns: 12");
    expect(instance.lastFrame()).toContain("permissions.mode: ask");
    instance.stdin.write("m"); // abre o seletor de modo dentro da tela
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b[A"); // ask -> allow-edits
    await waitFor(() => instance.lastFrame()?.includes("→ allow-edits") === true);
    instance.stdin.write("\r"); // aplica
    await waitFor(() => session.saved.length === 1);
    expect(session.saved).toEqual(["allow-edits"]);
    await waitFor(() => instance.lastFrame()?.includes("permissions.mode: allow-edits") === true);
    instance.stdin.write("\u001b"); // esc fecha a tela
    await waitFor(() => (instance.lastFrame() ?? "").includes("Configuração") === false);
    await waitFor(() => frameHas(instance, "modo: allow-edits")); // footer reflete o modo novo
  } finally {
    instance.unmount();
  }
});

test("/config sem configSummary na sessão mostra erro e não abre tela (#273)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-config-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/config");
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("configuração indisponível") === true);
  } finally {
    instance.unmount();
  }
});

class BudgetSession extends FakeSession {
  budgetStatus(): BudgetStatus {
    return {
      scope: "day", limitUsd: 5, spentUsd: 1, ratio: 0.2, warnAt: 0.8,
      warning: false, exhausted: false, ceilingHit: false,
      remainingUsd: 4, reservedUsd: 0, estimate: "US$ 1.000000",
    };
  }
}

test("footer mostra segmento de budget quando a sessão expõe budgetStatus (#63)", async () => {
  const session = new BudgetSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-budget-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "budget: 20% · US$ 1.000000/US$ 5.000000"));
  } finally {
    instance.unmount();
  }
});

test("footer sem budgetStatus não mostra segmento de budget (#63)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-nobudget-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    expect(frameHas(instance, "budget:")).toBe(false);
  } finally {
    instance.unmount();
  }
});

test("/usage na TUI imprime uso da sessão e budget no painel (#63)", async () => {
  const session = new BudgetSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-usage-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("/usage");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "uso da sessão:"));
    const frame = (instance.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("uso da sessão: 0 turno(s) · in 0 / out 0 tokens · custo US$ 0.001000");
    expect(frame).toContain("budget day: gasto US$ 1.000000 / limite US$ 5.000000 (20%) · restante US$ 4.000000 · aviso em 80%");
  } finally {
    instance.unmount();
  }
});

test("editor multi-linha: linefeed (\n) quebra linha, enter (\r) envia o texto inteiro (#63)", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    expect(frameHas(instance, "shift+enter")).toBe(true); // dica visível no editor
    instance.stdin.write("linha1");
    instance.stdin.write("\n"); // shift+enter em terminal legado
    instance.stdin.write("linha2");
    // as duas linhas aparecem no editor e nada foi enviado ainda
    await waitFor(() => {
      const frame = instance.lastFrame() ?? "";
      return frame.includes("linha1") && frame.includes("linha2");
    });
    expect(session.sent).toEqual([]);
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    expect(session.sent).toEqual(["linha1\nlinha2"]);
    await waitFor(() => frameHas(instance, "eco:linha1"));
  } finally {
    instance.unmount();
  }
});

test("editor multi-linha: shift+enter via protocolo kitty (CSI 13;2u) quebra linha (#63)", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("a");
    instance.stdin.write("\u001b[13;2u"); // shift+enter (kitty)
    instance.stdin.write("b");
    await new Promise((resolve) => setTimeout(resolve, 50)); // assenta o frame antes do enter
    expect(session.sent).toEqual([]);
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    expect(session.sent).toEqual(["a\nb"]);
  } finally {
    instance.unmount();
  }
});

test("texto multi-linha que começa com / vai como prompt, não como comando (#63)", async () => {
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd="/tmp/astro" />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("/usage");
    instance.stdin.write("\n");
    instance.stdin.write("pergunta");
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    // parseCommand quebraria em \n e rodaria /usage descartando "pergunta";
    // multi-linha é sempre prompt, nada é descartado silenciosamente
    expect(session.sent).toEqual(["/usage\npergunta"]);
  } finally {
    instance.unmount();
  }
});

test("toast de erro aparece, não bloqueia a entrada e expira (#64)", async () => {
  const session = new FakeSession();
  session.failNext = true;
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-toast-"));
  const instance = render(<TuiApp session={session} cwd={cwd} toastTtlMs={50} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "✖ erro: boom"));
    // não bloqueia: a próxima entrada continua funcionando com o toast na tela
    instance.stdin.write("depois");
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 2);
    expect(session.sent).toEqual(["oi", "depois"]);
    // expira (TTL 50ms), mas a entrada de erro continua no histórico
    await waitFor(() => frameHas(instance, "✖ erro: boom") === false);
    expect(frameHas(instance, "erro: boom")).toBe(true);
  } finally {
    instance.unmount();
  }
});

test("toast de conclusão aparece ao fim de um turno (#64)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-toast-ok-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "✔ turno concluído · 1 step(s)"));
  } finally {
    instance.unmount();
  }
});

class WarningBudgetSession extends FakeSession {
  warned = false;
  budgetStatus(): BudgetStatus {
    return {
      scope: "day", limitUsd: 5, spentUsd: 4.5, ratio: 0.9, warnAt: 0.8,
      warning: this.warned, exhausted: false, ceilingHit: false,
      remainingUsd: 0.5, reservedUsd: 0, estimate: "US$ 4.500000",
    };
  }
  async send(prompt: string): Promise<TurnResult> {
    const result = await super.send(prompt);
    this.warned = true; // o turno empurra o gasto para a faixa de aviso
    return result;
  }
}

test("toast de custo alto aparece quando o budget entra em aviso (#64)", async () => {
  const session = new WarningBudgetSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-toast-cost-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    expect(frameHas(instance, "⚠ custo alto")).toBe(false);
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "⚠ custo alto · budget: 90% · US$ 4.500000/US$ 5.000000"));
  } finally {
    instance.unmount();
  }
});

test("/theme contrast troca o tema ao vivo e persiste em .astro/tui.json (#64)", async () => {
  const session = new FakeSession();
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-theme-cmd-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("/theme contrast");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "tema: contrast"));
    const saved = JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")) as { theme: string };
    expect(saved.theme).toBe("contrast");
    // sem arg lista os três com o ativo marcado
    instance.stdin.write("/theme");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "ativo: contrast"));
  } finally {
    instance.unmount();
  }
});

test("/sessions abre o picker: r renomeia e enter retoma a sessão (#64)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-"));
  const store = new SessionStore(join(cwd, ".astro", "sessions"));
  store.write({
    id: "abc", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
    messages: [{ role: "user", content: "velho" }], turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
  });
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} store={store} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("/sessions");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "Sessões"));
    await new Promise((resolve) => setTimeout(resolve, 50)); // assenta os hooks do modal
    instance.stdin.write("r");
    await waitFor(() => frameHas(instance, "nome: _"));
    instance.stdin.write("nova");
    instance.stdin.write("\r");
    await waitFor(() => store.list()[0]?.name === "nova");
    await waitFor(() => frameHas(instance, "nova (abc)"));
    instance.stdin.write("\u001b"); // fecha o picker
    await waitFor(() => frameHas(instance, "Sessões") === false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.stdin.write("oi");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "eco:oi"));
    // (verificado abaixo em teste próprio: o picker retoma pelo path)
    // um turno novo persiste a sessão: o nome não pode sumir (coberto no store)
    expect(store.list().find((item) => item.id === "abc")?.name).toBe("nova");
  } finally {
    instance.unmount();
  }
});

test("picker: enter retoma a sessão selecionada pelo path (#64)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-tui-picker-enter-"));
  const store = new SessionStore(join(cwd, ".astro", "sessions"));
  const saved = { model: "p/m1", messages: [{ role: "user" as const, content: "x" }], turns: 1, tokensIn: 1, tokensOut: 1, costUsd: null };
  // id numérico: um resume por id o trataria como índice da lista
  store.write({ ...saved, id: "7", startedAt: "2026-10-01T10:00:00.000Z" });
  store.write({ ...saved, id: "abc", startedAt: "2026-10-03T10:00:00.000Z" });
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} store={store} />);
  try {
    await waitFor(() => frameHas(instance, "turno(s)"));
    instance.stdin.write("/sessions");
    instance.stdin.write("\r");
    await waitFor(() => frameHas(instance, "Sessões"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    instance.stdin.write("\u001b[B"); // segunda linha: id "7"
    instance.stdin.write("\r");
    await waitFor(() => session.resumed.length === 1);
    expect(session.resumed[0]).toBe("7");
    await waitFor(() => frameHas(instance, "sessão retomada: 7"));
    expect(JSON.parse(readFileSync(join(cwd, ".astro", "tui.json"), "utf8")).lastModel).toBe("p/m1");
    expect(frameHas(instance, "Sessões")).toBe(false);
  } finally { instance.unmount(); }
});