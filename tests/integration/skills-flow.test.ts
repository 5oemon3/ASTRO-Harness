import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/core/app";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, requestMessages, startMockProvider, writeConfig } from "./helpers";

const REPORT_SKILL = `---
name: report
description: Lê as notas e registra o relatório
version: 1.0.0
permissions:
  tools: [read_file, write_file]
scripts:
  - name: notes
    command: read notes.txt
---
Leia notes.txt e registre o relatório em out/report.txt. Argumentos: $ARGUMENTS
`;

function installSkill(dir: string, name: string, content: string): void {
  const skillDir = join(dir, ".astro", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
}

test("skills-flow: carrega a skill, injeta o prompt e executa as tools permitidas", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "read_file", arguments: { path: "notes.txt" } }] },
    { toolCalls: [{ name: "write_file", arguments: { path: "out/report.txt", content: "report: notas lidas\n" } }] },
    { content: "skill concluída" },
  ]);
  const dir = newWorkspace("skills-flow");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    installSkill(dir, "report", REPORT_SKILL);
    writeFileSync(join(dir, "notes.txt"), "nota do relatório\n", "utf8");
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 6, tools: ["read_file", "write_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "/report revisar o diff",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      skillsUserRoot: join(dir, "sem-skills-de-usuario"),
      approveTool: () => true,
    });

    expect(report.final).toBe("skill concluída");
    expect(readFileSync(join(dir, "out", "report.txt"), "utf8")).toBe("report: notas lidas\n");

    const first = requestMessages(provider.state.bodies[0]);
    const user = first.find((message) => message.role === "user")!;
    expect(user.content).toContain("Leia notes.txt e registre o relatório");
    expect(user.content).toContain("revisar o diff");
    expect(user.content).toContain("- notes: read notes.txt");

    expect(requestMessages(provider.state.bodies[1]).some((message) => message.role === "tool" && message.content.includes("nota do relatório"))).toBe(true);

    const audit = readAudit(dir);
    const loaded = audit.events.find((event) => event.tipo === "skill.loaded");
    expect(loaded?.payload).toMatchObject({ name: "report", version: "1.0.0", source: "project" });
    expect(loaded?.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.text.includes("Leia notes.txt")).toBe(false); // I-04: prompt da skill não é persistido
    expect(audit.text.includes("test-key")).toBe(false);
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);

test("skills-flow: skill fora da allowlist falha fechado antes de chamar o provider", async () => {
  const provider = startMockProvider([{ content: "não deveria rodar" }]);
  const dir = newWorkspace("skills-deny");
  try {
    expect(provider.server.hostname).toBe("127.0.0.1");
    installSkill(dir, "deploy", REPORT_SKILL.replace("name: report", "name: deploy")
      .replace("tools: [read_file, write_file]", "tools: [run_command]"));
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "mock/mock-1", maxSteps: 4, tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const error = await runTask({
      configPath,
      task: "/deploy agora",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      skillsUserRoot: join(dir, "sem-skills-de-usuario"),
      approveTool: () => true,
    }).then(() => null, (caught: unknown) => caught as Error);

    expect(String(error?.message)).toMatch(/allowlist/);
    expect(provider.state.calls).toBe(0);
    expect(existsSync(join(dir, "out"))).toBe(false);
    const audit = readAudit(dir);
    expect(audit.text.includes("run.stopped")).toBe(true);
    expect(audit.events.some((event) => event.tipo === "skill.loaded")).toBe(false);
    expect(audit.text.includes("test-key")).toBe(false);
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);
