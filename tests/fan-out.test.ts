import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, releaseAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { runFanOut, type FanOutJob } from "../src/fan-out";
import { Ledger } from "../src/ledger";
import { planResume } from "../src/resume";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(): { ledger: Ledger; audit: Auditor } {
  const dir = mkdtempSync(join(tmpdir(), "astro-fan-out-"));
  return { ledger: new Ledger(join(dir, "ledger.jsonl")), audit: new Auditor(join(dir, "audit.jsonl")) };
}

interface Probe {
  active: number;
  max: number;
  started: string[];
  finished: string[];
}

function job(
  ledger: Ledger,
  audit: Auditor,
  id: string,
  account: string,
  probe: Probe,
  ms = 15,
): FanOutJob<string> {
  const run = `run-${id}`;
  return {
    id,
    account,
    async run() {
      acquireAgentLock(ledger, audit, {
        run, agent_id: id, session_id: run, provider: "p", model: "m", credentialRef: account,
      });
      probe.active++;
      probe.max = Math.max(probe.max, probe.active);
      probe.started.push(id);
      try {
        await delay(ms);
        ledger.record({
          run, agent: id, provider: "p", model: "m", credentialRef: account,
          quotaDomain: "default", tokensIn: 1, tokensOut: 1,
        });
        return `${id}:ok`;
      } finally {
        probe.active--;
        probe.finished.push(id);
        releaseAgentLock(ledger, audit, { run, agent_id: id, reason: "completed" });
      }
    },
  };
}

describe("fan-out concorrente (A11)", () => {
  test("dois filhos em contas distintas rodam em paralelo com teto maxActive", async () => {
    const { ledger, audit } = setup();
    const probe: Probe = { active: 0, max: 0, started: [], finished: [] };
    const jobs = [
      job(ledger, audit, "a", "KEY_A", probe, 20),
      job(ledger, audit, "b", "KEY_B", probe, 20),
      job(ledger, audit, "c", "KEY_C", probe, 20),
    ];
    const results = await runFanOut(jobs, { parallel: true, maxActive: 2 });

    expect(results.map((result) => result.id)).toEqual(["a", "b", "c"]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(probe.max).toBe(2);
    // Dois começaram antes do primeiro terminar: execução concorrente real.
    expect(probe.started.length).toBe(3);
    expect(probe.finished[0]).not.toBe("b");

    // A4 no ledger: seq único, ordem por filho e atribuição determinística.
    const entries = ledger.readAllEntries();
    const seqs = entries.map((entry) => entry.seq!);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const usage = ledger.readAll().filter((entry) => entry.kind === "usage");
    expect(usage).toHaveLength(3);
    expect(usage.map((entry) => entry.agent)).toEqual(["a", "b", "c"]);
    expect(usage.map((entry) => entry.credentialRef)).toEqual(["KEY_A", "KEY_B", "KEY_C"]);
    expect(usage.reduce((sum, entry) => sum + entry.tokensIn + entry.tokensOut, 0)).toBe(6);
    for (const id of ["a", "b", "c"]) {
      const own = entries
        .filter((entry) => (entry.kind === "agent" ? entry.agent_id : entry.agent) === id)
        .map((entry) => entry.seq!);
      expect(own).toEqual([...own].sort((left, right) => left - right));
    }
  });

  test("conta compartilhada nunca roda dois filhos ao mesmo tempo", async () => {
    const { ledger, audit } = setup();
    const probe: Probe = { active: 0, max: 0, started: [], finished: [] };
    const results = await runFanOut([
      job(ledger, audit, "a", "SHARED", probe, 20),
      job(ledger, audit, "b", "SHARED", probe, 20),
    ], { parallel: true, maxActive: 2 });

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(probe.max).toBe(1);
    expect(probe.started).toEqual(["a", "b"]);
  });

  test("falha ou aborto de um filho não cancela nem corrompe os irmãos", async () => {
    const { ledger, audit } = setup();
    const probe: Probe = { active: 0, max: 0, started: [], finished: [] };
    const jobs: FanOutJob<string>[] = [
      {
        id: "abort",
        account: "KEY_A",
        async run() {
          throw new DOMException("cancelado pelo filho", "AbortError");
        },
      },
      job(ledger, audit, "ok", "KEY_B", probe, 20),
      {
        id: "fail",
        account: "KEY_C",
        async run() {
          throw new Error("falha isolada");
        },
      },
    ];
    const results = await runFanOut(jobs, { parallel: true, maxActive: 2 });

    expect(results[0]).toMatchObject({ id: "abort", ok: false });
    expect(results[1]).toMatchObject({ id: "ok", ok: true, value: "ok:ok" });
    expect(results[2]).toMatchObject({ id: "fail", ok: false });
    expect(probe.started).toEqual(["ok"]);
  });

  test("paralelo é opt-in: default serial", async () => {
    const { ledger, audit } = setup();
    const probe: Probe = { active: 0, max: 0, started: [], finished: [] };
    const results = await runFanOut([
      job(ledger, audit, "a", "KEY_A", probe),
      job(ledger, audit, "b", "KEY_B", probe),
    ], { parallel: false, maxActive: 2 });

    expect(results.every((result) => result.ok)).toBe(true);
    expect(probe.max).toBe(1);
    expect(probe.started).toEqual(["a", "b"]);
  });

  test("teto inválido falha antes de executar", async () => {
    await expect(runFanOut([], { parallel: true, maxActive: 0 })).rejects.toThrow(/maxActive/);
  });

  test("conta presa fora do grupo recusa o job em vez de rodar junto", async () => {
    const { ledger, audit } = setup();
    const probe: Probe = { active: 0, max: 0, started: [], finished: [] };
    acquireAgentLock(ledger, audit, {
      run: "outsider", agent_id: "outsider", session_id: "outsider",
      provider: "p", model: "m", credentialRef: "KEY_B",
    });
    const results = await runFanOut([
      job(ledger, audit, "a", "KEY_A", probe, 5),
      job(ledger, audit, "b", "KEY_B", probe, 5),
    ], { parallel: true, maxActive: 2 });
    releaseAgentLock(ledger, audit, { run: "outsider", agent_id: "outsider", reason: "completed" });

    expect(results[0]).toMatchObject({ id: "a", ok: true });
    expect(results[1]).toMatchObject({ id: "b", ok: false });
    expect((results[1] as { error: string }).error).toContain("já está em uso");
    expect(ledger.readAll().filter((entry) => entry.agent === "b")).toHaveLength(0);
  });
});

describe("resume após fan-out parcial (A11)", () => {
  test("retoma só o run pai; nenhum filho pendente é reexecutado", () => {
    const { ledger, audit } = setup();
    acquireAgentLock(ledger, audit, {
      run: "parent", agent_id: "planner", session_id: "parent", provider: "p", model: "m", credentialRef: "KEY_A",
    });
    ledger.recordState("parent", "interrupted", { agent: "planner" });
    acquireAgentLock(ledger, audit, {
      run: "parent.task.1", agent_id: "child", session_id: "parent.task.1", provider: "p", model: "m", credentialRef: "KEY_B",
    });
    ledger.recordState("parent.task.1", "completed", { agent: "child" });

    const resumed = planResume(ledger, "parent");
    expect(resumed.agent.agent_id).toBe("planner");
    expect(resumed.tree.nodes.map((node) => node.agent_id)).toEqual(["planner"]);
    // O filho vive em run próprio; o pai não o enxerga como pendente.
    expect(ledger.readAllEntries().filter((entry) => entry.run === "parent.task.1").length).toBeGreaterThan(0);
  });
});
