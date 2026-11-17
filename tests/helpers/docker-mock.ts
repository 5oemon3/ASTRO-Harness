/**
 * Mock de `Bun.spawn`/`Bun.spawnSync` para testes do sandbox (ADR-0027, #391): intercepta
 * SOMENTE `docker`; o resto cai no spawn original e fica em `calls` (nada roda fora do docker).
 */
import { expect } from "bun:test";
import type { ToolResult } from "../../src/tools/types";

/** Resposta de um `docker run`: string vira stdout com exit 0. */
export type DockerRunReply = string | { code?: number; stdout?: string; stderr?: string; hang?: boolean };

export interface DockerMock {
  readonly calls: string[][]; // todo cmd passado a `Bun.spawn`, de qualquer origem
  readonly runCalls: string[][]; // só os argv de `docker run`
  restore(): void;
}

export type RunCommandModule = typeof import("../../src/tools/run-command");

let seq = 0;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text.length > 0) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

/** Processo fake com a superfície que `runInDocker` usa. */
function fakeProc(reply: { code: number; stdout: string; stderr: string; hang?: boolean }) {
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExited = resolve; });
  if (!reply.hang) queueMicrotask(() => resolveExited(reply.code));
  return { pid: 424_242, exited, stdout: streamOf(reply.stdout), stderr: streamOf(reply.stderr),
    kill() { resolveExited(137); } };
}

const cmdOf = (arg: unknown, maybeOpts?: unknown): { cmd: string[]; opts: Record<string, unknown> | undefined } => {
  const isObj = typeof arg === "object" && arg !== null && !Array.isArray(arg);
  return { cmd: (isObj ? (arg as { cmd: string[] }).cmd : (arg as string[])) as string[],
    opts: (isObj ? arg : maybeOpts) as Record<string, unknown> | undefined };
};

/** Instala o mock global de docker. Sem `run`, o `docker run` passa o comando interno ao spawn original (env mínima `{PATH, SYSTEMROOT}`). */
export function installDockerSpawnMock(run?: (argv: string[]) => DockerRunReply): DockerMock {
  const origSpawn = Bun.spawn as unknown as (arg: unknown, opts?: unknown) => unknown;
  const origSpawnSync = Bun.spawnSync as unknown as (arg: unknown, opts?: unknown) => unknown;
  const calls: string[][] = [];
  const runCalls: string[][] = [];

  const passthrough = (argv: string[], opts: Record<string, unknown> | undefined): unknown => {
    const at = argv.indexOf("-c");
    const command = at >= 0 ? String(argv[at + 1]) : "";
    const shell = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command];
    const env: Record<string, string> = {};
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
    if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT;
    return origSpawn({ cmd: shell, cwd: opts?.cwd, env, stdout: "pipe", stderr: "pipe", detached: opts?.detached === true });
  };

  const spawnMock = (arg: unknown, maybeOpts?: unknown): unknown => {
    const { cmd, opts } = cmdOf(arg, maybeOpts);
    calls.push(cmd);
    if (cmd[0] !== "docker") return origSpawn(arg, maybeOpts);
    if (cmd.includes("info")) return fakeProc({ code: 0, stdout: "27.3.1|linux\n", stderr: "" });
    if (cmd.includes("run")) {
      runCalls.push(cmd);
      if (run === undefined) return passthrough(cmd, opts);
      const reply = run(cmd);
      const r = typeof reply === "string"
        ? { code: 0, stdout: reply, stderr: "", hang: false }
        : { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", hang: reply.hang === true };
      return fakeProc(r);
    }
    return fakeProc({ code: 0, stdout: "", stderr: "" }); // docker rm -f etc.
  };

  const spawnSyncMock = (arg: unknown, maybeOpts?: unknown): unknown => {
    const { cmd } = cmdOf(arg, maybeOpts);
    calls.push(cmd);
    if (cmd[0] !== "docker") return origSpawnSync(arg, maybeOpts);
    return { exitCode: 0, success: true, pid: 424_242, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
  };

  (Bun as { spawn: unknown }).spawn = spawnMock;
  (Bun as { spawnSync: unknown }).spawnSync = spawnSyncMock;
  return { calls, runCalls, restore() {
    (Bun as { spawn: unknown }).spawn = origSpawn;
    (Bun as { spawnSync: unknown }).spawnSync = origSpawnSync;
  } };
}

/** Módulo fresco de run-command (query-string): estado do sandbox e o cache do probe ficam isolados. */
export async function isolatedRunCommand(tag: string): Promise<RunCommandModule> {
  return (await import("../../src/tools/run-command.ts?iso=" + encodeURIComponent(tag))) as RunCommandModule;
}

/** beforeEach pronto: mock de docker + módulo isolado com `sandbox: true` (chame `mock.restore()` no afterEach). */
export async function dockerSandboxModule(prefix: string): Promise<{ mod: RunCommandModule; mock: DockerMock }> {
  const mock = installDockerSpawnMock();
  const mod = await isolatedRunCommand(`${prefix}-${seq++}`);
  mod.configureRunCommand({ sandbox: true });
  return { mod, mock };
}

/** Slice 4b (I-19): `sandbox: false` recusa com o código e sem nenhum spawn fora do docker. */
export function expectSandboxRefusal(result: ToolResult, mock?: DockerMock): void {
  expect(result.isError).toBe(true);
  expect(result.code).toBe("sandbox_required_for_shell");
  expect(result.output).toContain("sandbox_required_for_shell");
  if (mock !== undefined) expect(mock.calls.filter((cmd) => cmd[0] !== "docker")).toHaveLength(0);
}
