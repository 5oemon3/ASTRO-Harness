import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpointPath, saveCheckpoint, type CheckpointV1 } from "../src/loop-guard";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "astro-continue-cli-"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: unknown };
      requests.push(JSON.stringify(body.messages ?? []));
      return Response.json({
        choices: [{ message: { content: "continuado ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  const config = {
    providers: {
      mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" },
    },
    models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "mock/m1", maxSteps: 2, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { cwd, configPath, requests, server };
}

function seed(cwd: string, agent = "planner", summary = "resumo do checkpoint"): CheckpointV1 {
  const checkpoint: CheckpointV1 = {
    schema: "checkpoint/v1",
    summary,
    changedFiles: ["src/a.ts"],
    nextStep: "rodar os testes",
    createdAt: "2026-11-01T12:00:00.000Z",
  };
  saveCheckpoint(checkpoint, checkpointPath(cwd, "r1", agent));
  return checkpoint;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runCli(args: string[], cwd: string) {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, TEST_KEY: "x" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe("astro continue (#135 slice 1)", () => {
  test("carrega o checkpoint, inicia um novo run e usa o prompt gerado", async () => {
    const { cwd, configPath, requests, server } = setup();
    seed(cwd);
    try {
      const result = await runCli(["continue", "r1", "--config", configPath, "--cwd", cwd], cwd);
      expect(result.code).toBe(0);
      expect(result.out).toContain("continuado do run r1 (agente planner)");
      expect(result.out).toMatch(/em [0-9a-f-]{36}/);
      expect(result.out).toContain("continuado ok");
      expect(requests.join("\n")).toContain("Resumo: resumo do checkpoint");
      expect(requests.join("\n")).toContain("Próximo passo: rodar os testes");

      const ledger = readJsonl(join(cwd, ".astro", "ledger.jsonl"));
      expect(ledger.some((entry) => entry.run !== undefined && entry.run !== "r1")).toBe(true);
      const audit = readJsonl(join(cwd, ".astro", "audit.jsonl"));
      const started = audit.find((entry) => entry.tipo === "run.started");
      expect(started).toBeDefined();
      expect(typeof (started!.payload as Record<string, unknown>).taskHash).toBe("string");
      expect((started!.payload as Record<string, unknown>).continuedFrom).toEqual({
        run: "r1",
        agent: "planner",
      });
      expect(JSON.stringify({ audit, ledger })).not.toContain("resumo do checkpoint");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--task substitui o prompt gerado", async () => {
    const { cwd, configPath, requests, server } = setup();
    seed(cwd);
    try {
      const result = await runCli(
        ["continue", "r1", "--config", configPath, "--cwd", cwd, "--task", "tarefa nova"],
        cwd,
      );
      expect(result.code).toBe(0);
      expect(requests.join("\n")).toContain("tarefa nova");
      expect(requests.join("\n")).not.toContain("resumo do checkpoint");
      const persisted = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8")
        + readFileSync(join(cwd, ".astro", "ledger.jsonl"), "utf8");
      expect(persisted).not.toContain("tarefa nova");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("não vaza segredo no caminho descartado do checkpoint (I-03)", async () => {
    const { cwd, configPath, requests, server } = setup();
    const secret = ["ghp", "_", "continue", "secret", "123456"].join("");
    saveCheckpoint({
      schema: "checkpoint/v1",
      summary: "s",
      changedFiles: [`../${secret}.txt`],
      nextStep: "n",
      createdAt: "2026-11-01T12:00:00.000Z",
    }, checkpointPath(cwd, "r1", "planner"));
    try {
      const result = await runCli(["continue", "r1", "--config", configPath, "--cwd", cwd], cwd);
      expect(result.code).toBe(0);
      const persisted = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8")
        + readFileSync(join(cwd, ".astro", "ledger.jsonl"), "utf8");
      expect(result.out + result.err + persisted + requests.join("\n")).not.toContain(secret);
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("checkpoint ausente termina com erro claro", async () => {
    const { cwd, configPath, server } = setup();
    try {
      const result = await runCli(["continue", "run-ausente", "--config", configPath, "--cwd", cwd], cwd);
      expect(result.code).toBe(1);
      expect(result.err).toContain("checkpoint não encontrado");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("múltiplos agentes exigem --agent", async () => {
    const { cwd, configPath, requests, server } = setup();
    seed(cwd, "planner", "resumo planner");
    seed(cwd, "coder", "resumo coder");
    try {
      const ambiguous = await runCli(["continue", "r1", "--config", configPath, "--cwd", cwd], cwd);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.err).toContain("use --agent");

      const chosen = await runCli(
        ["continue", "r1", "--agent", "planner", "--config", configPath, "--cwd", cwd],
        cwd,
      );
      expect(chosen.code).toBe(0);
      expect(chosen.out).toContain("agente planner");
      expect(requests.join("\n")).toContain("resumo planner");
      expect(requests.join("\n")).not.toContain("resumo coder");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
