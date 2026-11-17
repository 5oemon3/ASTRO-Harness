import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeLocks } from "../../src/agent-lock";
import { runTask } from "../../src/app";
import { Ledger } from "../../src/ledger";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, startDownProvider, startMockProvider, writeConfig } from "./helpers";

test("provider-fallback: adapter retry do primário recupera sem acionar o backup", async () => {
  let attempts = 0;
  const primary = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      attempts += 1;
      if (attempts === 1) return new Response("boom", { status: 500 });
      const body = (await req.json()) as { model?: string };
      return Response.json({
        choices: [{ message: { content: `primário recuperou ${body.model ?? ""}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  const backup = startMockProvider([{ content: "backup não deveria atender" }]);
  const dir = newWorkspace("provider-retry");
  try {
    expect(primary.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: {
        primary: {
          kind: "openai-compat", baseUrl: `http://127.0.0.1:${primary.port}/v1`, credentialRef: "KEY_A",
          fallback: ["backup"], maxRetries: 1, retryBackoffMs: 1, priority: 1,
        },
        backup: { kind: "openai-compat", baseUrl: backup.baseUrl, credentialRef: "KEY_B", priority: 2 },
      },
      models: [
        { provider: "primary", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "backup", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agent: { model: "primary/m1", maxSteps: 2, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "sobreviva a um erro transitório",
      cwd: dir,
      env: testEnv({ KEY_A: "key-a-secret", KEY_B: "key-b-secret" }),
      approveSwap: () => true,
    });

    expect(report.final).toContain("primário recuperou");
    expect(attempts).toBe(2);
    expect(backup.state.calls).toBe(0);
    const audit = readAudit(dir);
    expect(audit.events.find((event) => event.tipo === "provider.complete")?.payload)
      .toMatchObject({ provider: "primary" });
    const usage = new Ledger(join(dir, ".astro", "ledger.jsonl")).readAll();
    expect(usage).toHaveLength(1);
    expect(usage.every((entry) => entry.provider === "primary")).toBe(true);
  } finally {
    primary.stop(true);
    backup.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);

test("provider-fallback: primário em outage e o run continua no provider de reserva", async () => {
  const down = startDownProvider();
  const backup = startMockProvider([
    { toolCalls: [{ name: "write_file", arguments: { path: "out/fallback.txt", content: "fallback served\n" } }] },
    { content: "fallback concluído" },
  ]);
  const dir = newWorkspace("provider-fallback");
  try {
    expect(backup.server.hostname).toBe("127.0.0.1");
    expect(down.hostname).toBe("127.0.0.1");
    const configPath = writeConfig(dir, {
      providers: {
        primary: {
          kind: "openai-compat", baseUrl: `http://127.0.0.1:${down.port}/v1`, credentialRef: "KEY_A",
          fallback: ["backup"], maxRetries: 0, retryBackoffMs: 1, priority: 1,
        },
        backup: { kind: "openai-compat", baseUrl: backup.baseUrl, credentialRef: "KEY_B", priority: 2 },
      },
      models: [
        { provider: "primary", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "backup", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agent: { model: "primary/m1", maxSteps: 6, tools: ["write_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "conclua mesmo com o primário fora",
      cwd: dir,
      env: testEnv({ KEY_A: "key-a-secret", KEY_B: "key-b-secret" }),
      approveTool: () => true,
      approveSwap: () => true,
    });

    expect(report.final).toBe("fallback concluído");
    expect(readFileSync(join(dir, "out", "fallback.txt"), "utf8")).toBe("fallback served\n");

    const usage = new Ledger(join(dir, ".astro", "ledger.jsonl")).readAll();
    expect(usage).toHaveLength(2);
    expect(usage.every((entry) => entry.provider === "backup")).toBe(true);

    const audit = readAudit(dir);
    expect(audit.events.some((event) => event.tipo === "provider.failure")).toBe(true);
    expect(audit.events.find((event) => event.tipo === "provider.complete")?.payload)
      .toMatchObject({ provider: "backup" });
    expect(audit.events.some((event) => event.tipo === "agent.lock.moved")).toBe(true);
    expect(audit.text.includes("key-a-secret")).toBe(false);
    expect(audit.text.includes("key-b-secret")).toBe(false);

    const ledger = new Ledger(join(dir, ".astro", "ledger.jsonl"));
    expect(activeLocks(ledger)).toEqual([]);
  } finally {
    backup.server.stop(true);
    down.stop(true);
    removeWorkspace(dir);
  }
}, 30000);
