import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import type { AttachmentMeta } from "../src/attachments/model";
import { SessionStore, type SessionRecord } from "../src/chat/store";
import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import type { ModelEntry } from "../src/registry";
import { runSession, safePrompt, type SessionOptions } from "../src/session";
import { ToolExecutor } from "../src/tools/executor";

const model: ModelEntry = {
  provider: "openai",
  id: "m",
  tags: [],
  context: 128000,
  status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};

const attachment: AttachmentMeta = {
  kind: "text",
  name: "a.txt",
  sizeBytes: 3,
  mediaType: "text/plain",
  range: { start: 1, end: 1 },
};

describe("mensagem de anexo (ADR-0026, #392)", () => {
  test("runSession põe os metadados na mensagem do usuário", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-att-msg-"));
    let seen: CompletionRequest | undefined;
    const provider: Provider = {
      complete: async (request: CompletionRequest): Promise<CompletionResponse> => {
        seen = request;
        return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const opts: SessionOptions = {
      run: "r1",
      agent: "default",
      credentialRef: "OPENAI_API_KEY",
      quotaDomain: "default",
      cwd,
      provider,
      model,
      executor: new ToolExecutor({ approveTool: () => true, tools: [], allow: [], audit }),
      ledger,
      audit,
      maxSteps: 1,
      attachments: [attachment],
    };
    await runSession(opts, "leia o anexo");
    const user = seen?.messages.find((message) => message.role === "user");
    expect(user?.attachments).toEqual([attachment]);
  });

  test("safePrompt preserva metadados e redige segredo no nome", () => {
    const secret = ["s", "k", "-"].join("") + "abcdefghijklmnop123456";
    const [message] = safePrompt([
      { role: "user", content: "x", attachments: [{ ...attachment, name: secret }] },
    ]);
    expect(message?.attachments?.[0]?.name).toBe("[REDACTED]");
    expect(message?.attachments?.[0]?.mediaType).toBe("text/plain");
  });

  test("store preserva metadados no round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-att-store-"));
    const snapshot: Omit<SessionRecord, "schemaVersion" | "name"> = {
      id: "s1",
      startedAt: "2026-11-08T12:00:00.000Z",
      model: "p/m1",
      messages: [{ role: "user", content: "texto", attachments: [attachment] }],
      turns: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    };
    new SessionStore(dir).write(snapshot);
    expect(new SessionStore(dir).load("s1").record.messages[0]?.attachments).toEqual([attachment]);
  });

  test("store recusa metadado de anexo malformado", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-att-store-bad-"));
    const record = {
      schemaVersion: 1,
      id: "s1",
      startedAt: "2026-11-08T12:00:00.000Z",
      model: "p/m1",
      messages: [{ role: "user", content: "texto", attachments: [{ name: "sem-kind" }] }],
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    };
    const fileName = "2026-11-08T12-00-00-000Z-s1.json";
    writeFileSync(join(dir, fileName), JSON.stringify(record));
    expect(() => new SessionStore(dir).readByPath(join(dir, fileName))).toThrow(/anexo/);
  });
});
