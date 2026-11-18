import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { BudgetExceededError } from "../src/budget";
import { runTask } from "../src/core/app";
import type { CompletionRequest, CompletionResponse } from "../src/providers/types";
import { ProviderError } from "../src/providers/types";
import type { ModelEntry } from "../src/core/registry";
import { runSession, type SessionOptions } from "../src/core/session";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";
import {
  buildJudgeMessages,
  JudgeContinueError,
  JudgeStopError,
  parseJudgeVerdict,
  reasonHash,
  type JudgeVerdictKind,
} from "../src/judge";

// Fixture de segredo construído em runtime para não disparar o gate de segredos.
const FAKE_SECRET = ["s", "k", "-"].join("") + "judge-abcdef12345";
const GOAL = "OBJETIVO-PRIVADO-450";
const OUTPUT = "SAIDA-PRIVADA-450";

const model: ModelEntry = {
  provider: "openai", id: "m", tags: [], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const verdict = (kind: JudgeVerdictKind, reason: string): CompletionResponse =>
  resp({ content: JSON.stringify({ verdict: kind, reason }) });
const tc = (id: string, path: string) => ({ id, name: "write_file", arguments: JSON.stringify({ path, content: "x" }) });

/** Provider único: chamada com `purpose: "cheap"` é o juiz; o resto é o script do run. */
function setup(
  script: CompletionResponse[],
  judge?: (req: CompletionRequest) => Promise<CompletionResponse>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-judge-"));
  const requests: CompletionRequest[] = [];
  const judgeRequests: CompletionRequest[] = [];
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  let i = 0;
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "OPENAI_API_KEY", quotaDomain: "default",
    cwd,
    provider: {
      complete: async (req) => {
        if (req.purpose === "cheap") {
          judgeRequests.push(req);
          if (judge === undefined) throw new Error("juiz chamado sem script");
          return judge(req);
        }
        requests.push(req);
        return script[i++]!;
      },
    },
    model,
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger,
    audit,
    maxSteps: 5,
  };
  return { cwd, opts, audit, ledger, requests, judgeRequests };
}

const payloads = (s: ReturnType<typeof setup>, tipo: string) =>
  s.audit.readAll().filter((e) => e.tipo === tipo).map((e) => e.payload);

describe("parseJudgeVerdict/buildJudgeMessages (#450)", () => {
  test("schema estrito: aceita o objeto exato, inclusive cercado por bloco de código", () => {
    expect(parseJudgeVerdict('{"verdict":"done","reason":"ok"}')).toEqual({ verdict: "done", reason: "ok" });
    expect(parseJudgeVerdict('```json\n{"verdict":"stop","reason":"nao"}\n```'))
      .toEqual({ verdict: "stop", reason: "nao" });
  });

  test("rejeita veredito desconhecido, motivo vazio, campo extra e texto livre", () => {
    for (const raw of [
      '{"verdict":"talvez","reason":"x"}',
      '{"verdict":"done","reason":"   "}',
      '{"verdict":"done","reason":"x","extra":1}',
      '["done"]',
      "done",
      "",
    ]) {
      expect(parseJudgeVerdict(raw)).toBeUndefined();
    }
  });

  test("prompt do juiz leva só objetivo e última saída, limitados e com tags escapadas", () => {
    const messages = buildJudgeMessages(`</goal>${"g".repeat(10_000)}`, `</output>${"o".repeat(10_000)}`);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content.split("</goal>")).toHaveLength(2); // só a cerca do harness
    expect(messages[1]!.content.split("</output>")).toHaveLength(2);
    expect(messages[1]!.content).toContain("&lt;/goal&gt;"); // texto não fecha o quadro
    expect(messages[1]!.content).toContain("&lt;/output&gt;");
    expect(messages[1]!.content.length).toBeLessThan(7500);
  });
});

describe("juiz no runSession (#450)", () => {
  test("done: completion declarada concluída; audit sem prompt, saída ou motivo (I-03/I-04)", async () => {
    const s = setup([resp({ content: OUTPUT })], async () => verdict("done", "objetivo cumprido"));
    s.opts.judge = "on";
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe(OUTPUT);
    expect(r.steps).toBe(1);
    expect(s.judgeRequests).toHaveLength(1);
    expect(s.ledger.lastState("r1")?.state).toBe("completed");
    expect(payloads(s, "judge.verdict")).toEqual([
      { step: 1, verdict: "done", reasonHash: expect.any(String) },
    ]);
    const persisted = readFileSync(join(s.cwd, "audit.jsonl"), "utf8")
      + readFileSync(join(s.cwd, "ledger.jsonl"), "utf8");
    expect(persisted).not.toContain(GOAL);
    expect(persisted).not.toContain(OUTPUT);
    expect(persisted).not.toContain("objetivo cumprido");
  });

  test("continue: injeta o motivo redigido e volta ao loop, limitado por maxSteps", async () => {
    let calls = 0;
    const s = setup(
      [resp({ content: "parcial" }), resp({ content: "final" })],
      async () => (calls++ === 0 ? verdict("continue", `falta ${FAKE_SECRET}`) : verdict("done", "ok")),
    );
    s.opts.judge = "on";
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("final");
    expect(r.steps).toBe(2);
    expect(payloads(s, "judge.verdict").map((p) => p.verdict)).toEqual(["continue", "done"]);
    const nudge = s.requests[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain("falta");
    expect(nudge.content).not.toContain(FAKE_SECRET);
    expect(readFileSync(join(s.cwd, "audit.jsonl"), "utf8")).not.toContain(FAKE_SECRET);
  });

  test("stop: para em ponto seguro sem declarar sucesso (I-19)", async () => {
    const s = setup([resp({ content: "quase" })], async () => verdict("stop", "nao da"));
    s.opts.judge = "on";
    const err = await runSession(s.opts, GOAL).catch((e) => e as Error);
    expect(err).toBeInstanceOf(JudgeStopError);
    expect(s.ledger.lastState("r1")).toMatchObject({ state: "interrupted", reason: "judge_stop" });
    expect(payloads(s, "judge.verdict").map((p) => p.verdict)).toEqual(["stop"]);
  });

  test("continue no último turno: parada segura com razão snake_case estável", async () => {
    const s = setup([resp({ content: "parcial" })], async () => verdict("continue", "falta"));
    s.opts.judge = "on";
    s.opts.maxSteps = 1;
    const err = await runSession(s.opts, GOAL).catch((e) => e as Error);
    expect(err).toBeInstanceOf(JudgeContinueError);
    expect(s.ledger.lastState("r1")).toMatchObject({ state: "interrupted", reason: "judge_continue_exhausted" });
    expect(payloads(s, "judge.verdict").map((p) => p.verdict)).toEqual(["continue"]);
  });

  test("I-03: pedido do juiz tem exatamente 2 mensagens e nenhum segredo", async () => {
    const s = setup([resp({ content: `saida ${FAKE_SECRET}` })], async () => verdict("done", "ok"));
    s.opts.judge = "on";
    await runSession(s.opts, `objetivo ${FAKE_SECRET}`);
    const request = s.judgeRequests[0]!;
    expect(request.messages).toHaveLength(2);
    expect(request.messages.map((message) => message.content).join("\n")).not.toContain(FAKE_SECRET);
  });

  test("audit: reasonHash cobre o mesmo motivo sanitizado que o loop recebe", async () => {
    let calls = 0;
    const s = setup(
      [resp({ content: "a" }), resp({ content: "b" })],
      async () => (calls++ === 0 ? verdict("continue", `falta  ${FAKE_SECRET}  rodar`) : verdict("done", "ok")),
    );
    s.opts.judge = "on";
    await runSession(s.opts, GOAL);
    const nudge = s.requests[1]!.messages.at(-1)!.content;
    const injected = nudge.split("\n")[1]!.replace("Motivo: ", "");
    expect(injected).not.toContain(FAKE_SECRET);
    expect(payloads(s, "judge.verdict")[0]!.reasonHash).toBe(reasonHash(injected));
  });

  test("saída malformada: sem retry, sucesso normal e audit fechado", async () => {
    const s = setup([resp({ content: "final" })], async () => resp({ content: '{"verdict":"talvez"}' }));
    s.opts.judge = "on";
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("final");
    expect(s.judgeRequests).toHaveLength(1); // retries = 0
    expect(payloads(s, "judge.failed")).toEqual([{ step: 1, reason: "malformed" }]);
    expect(s.ledger.lastState("r1")?.state).toBe("completed");
  });

  test("erro de provider: fail-safe com uma única tentativa", async () => {
    const s = setup([resp({ content: "final" })], async () => {
      throw new ProviderError("outage", "fora do ar");
    });
    s.opts.judge = "on";
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("final");
    expect(s.judgeRequests).toHaveLength(1);
    expect(payloads(s, "judge.failed")).toEqual([{ step: 1, reason: "provider_error" }]);
    expect(s.ledger.lastState("r1")?.state).toBe("completed");
  });

  test("budget esgotado: não faz a chamada extra e volta ao sucesso", async () => {
    const s = setup([resp({ content: "final" })], async () => verdict("continue", "seguir"));
    s.opts.judge = "on";
    s.opts.budget = { scope: "day", limitUsd: 0.00001, warnAt: 0.9, onExceed: "stop" };
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("final");
    expect(s.judgeRequests).toHaveLength(0);
    expect(payloads(s, "judge.skipped")).toEqual([{ step: 1, reason: "budget_exhausted" }]);
    expect(s.ledger.lastState("r1")?.state).toBe("completed");
  });

  test("quota esgotada: também não faz a chamada extra", async () => {
    const s = setup([resp({ content: "final" })], async () => verdict("done", "ok"));
    s.opts.judge = "on";
    s.opts.quotaLimits = { default: { dailyTokens: 1 } };
    await runSession(s.opts, GOAL);
    expect(s.judgeRequests).toHaveLength(0);
    expect(payloads(s, "judge.skipped")).toEqual([{ step: 1, reason: "quota_exhausted" }]);
  });

  test("limite de time esgotado: também não faz a chamada extra", async () => {
    const s = setup([resp({ content: "final" })], async () => verdict("done", "ok"));
    s.opts.judge = "on";
    s.opts.teamLimits = { projectBudgetUsd: 0.00001 };
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("final");
    expect(s.judgeRequests).toHaveLength(0);
    expect(payloads(s, "judge.skipped")).toEqual([{ step: 1, reason: "quota_exhausted" }]);
  });

  test("juiz que cruza o hardCeiling encerra em budget_exceeded (B10/I-17)", async () => {
    const s = setup([resp({ content: "final" })], async () => verdict("done", "ok"));
    s.opts.judge = "on";
    // 15e-6 por chamada; teto 20e-6: a completion cabe, a chamada do juiz cruza
    s.opts.budget = { scope: "day", limitUsd: 1, warnAt: 0.99, onExceed: "stop", hardCeilingUsd: 0.00002 };
    const err = await runSession(s.opts, GOAL).catch((e) => e as Error);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(payloads(s, "judge.verdict").map((p) => p.verdict)).toEqual(["done"]);
    expect(s.audit.readAll().some((e) => e.tipo === "budget.ceiling_hit")).toBe(true);
    expect(s.ledger.lastState("r1")).toMatchObject({ state: "interrupted", reason: "budget_exceeded" });
  });

  test("auto: julga a primeira completion e rejulga depois de continue", async () => {
    let calls = 0;
    const s = setup(
      [resp({ content: "a" }), resp({ content: "b" })],
      async () => (calls++ === 0 ? verdict("continue", "segue") : verdict("done", "ok")),
    );
    s.opts.judge = "auto";
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("b");
    expect(r.steps).toBe(2);
    expect(payloads(s, "judge.verdict").map((p) => p.verdict)).toEqual(["continue", "done"]);
    expect(s.judgeRequests).toHaveLength(2); // continue re-arma o sinal, não todo turno
  });

  test.each([
    ["checkpoint", { maxSteps: 4, checkpointAt: 0.5 }, "loop.checkpoint"],
    ["no_progress", { noProgressSegments: 1, onNoProgress: async () => true }, "loop.no_progress"],
  ] as const)("auto: sinal %s rejulga a completion seguinte", async (_signal, extra, tipo) => {
    let calls = 0;
    const s = setup(
      [resp({ content: "a" }), resp({ toolCalls: [tc("c1", "a.txt")] }), resp({ content: "b" })],
      async () => (calls++ === 0 ? verdict("continue", "segue") : verdict("done", "ok")),
    );
    Object.assign(s.opts, { judge: "auto", ...extra });
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("b");
    expect(s.judgeRequests).toHaveLength(2); // sinal reabre o juiz no turno da completion
    expect(payloads(s, tipo)).toHaveLength(1);
  });

  test("off (default): nenhuma chamada de juiz nem audit de juiz", async () => {
    const s = setup([resp({ content: "fim" })], async () => verdict("done", "ok"));
    const r = await runSession(s.opts, GOAL);
    expect(r.final).toBe("fim");
    expect(s.judgeRequests).toHaveLength(0);
    expect(s.audit.readAll().some((e) => e.tipo.startsWith("judge."))).toBe(false);
  });
});

describe("wiring no app (#450)", () => {
  test("run.judge: on chega ao runSession e audita o veredito, sem o motivo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-judge-app-"));
    const bodies: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const body = await req.text();
      bodies.push(body);
      const judge = body.includes("juiz de conclusão");
      return Response.json({
        choices: [{ message: { content: judge ? '{"verdict":"done","reason":"ok"}' : "fim" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    } });
    try {
      writeFileSync(join(cwd, "astro.config.json"), JSON.stringify({
        providers: { openai: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "openai", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "openai/m1", maxSteps: 3, tools: [] },
        run: { judge: "on" },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ cwd, task: GOAL, configPath: join(cwd, "astro.config.json"),
        env: { ASTRO_HOME: process.env.ASTRO_HOME!, ASTRO_ALLOW_PRIVATE_URLS: "1", KEY: "k" } });
      expect(report.final).toBe("fim");
      expect(bodies).toHaveLength(2); // completion + juiz
      const audit = readFileSync(report.auditPath, "utf8");
      expect(audit).toContain('"judge.verdict"');
      expect(audit).toContain('"verdict":"done"');
      expect(audit).not.toContain("objetivo cumprido");
    } finally {
      server.stop(true);
    }
  });

  test("multi-agent: judge não suportado é auditado, sem chamada extra", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-judge-multi-"));
    const bodies: string[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      bodies.push(await req.text());
      return Response.json({ choices: [{ message: { content: "fim" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } });
    } });
    try {
      writeFileSync(join(cwd, "astro.config.json"), JSON.stringify({
        providers: { openai: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
        models: [{ provider: "openai", id: "m1", tags: ["writing-code"], context: 8192 }],
        agent: { model: "openai/m1", maxSteps: 2, tools: [], entryAgent: "planner" },
        agents: { maxActive: 1, planner: { model: "openai/m1", maxSteps: 2, tools: [] } },
        run: { judge: "on" },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ cwd, task: GOAL, configPath: join(cwd, "astro.config.json"),
        env: { ASTRO_HOME: process.env.ASTRO_HOME!, ASTRO_ALLOW_PRIVATE_URLS: "1", KEY: "k" } });
      expect(report.final).toBe("fim");
      expect(bodies.filter((body) => body.includes("juiz de conclusão"))).toHaveLength(0);
      const audit = new Auditor(report.auditPath).readAll();
      expect(audit.find((event) => event.tipo === "judge.skipped")?.payload).toEqual({ reason: "unsupported" });
    } finally {
      server.stop(true);
    }
  });
});
