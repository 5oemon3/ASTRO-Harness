import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTurnOptions, SessionSnapshot, TurnResult } from "../src/chat/agent-session";
import type { ChatSession } from "../src/chat/repl";
import type { AttachmentMeta } from "../src/attachments/model";
import { prepareTurnAttachments } from "../src/attachments/turn";
import { TuiApp } from "../src/tui/app";
import { createApprovalBridge } from "../src/tui/approvals";

/** PNG 1x1 real (70 bytes), o mesmo fixture do teste de turno. */
const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class FakeSession implements ChatSession {
  model = "p/m1";
  sent: Array<{ prompt: string; metas?: AttachmentMeta[] }> = [];
  async send(prompt: string, _signal?: AbortSignal, _onToken?: (text: string) => void, _attachments?: AttachmentMeta[], turn?: SendTurnOptions): Promise<TurnResult> {
    // Exercita o preparo real do turno para que a aprovação da TUI seja de fato chamada.
    const prepared = await prepareTurnAttachments({
      attachments: turn?.attachments ?? [],
      owner: { runId: "r1" },
      ...(turn?.approveAttachment === undefined ? {} : { approver: turn.approveAttachment }),
    });
    this.sent.push({ prompt, ...(prepared.metas.length === 0 ? {} : { metas: prepared.metas }) });
    return {
      final: "ok", model: this.model, steps: 1, tokensIn: 1, tokensOut: 1, costUsd: 0,
      totalTokensIn: 1, totalTokensOut: 1, totalCostUsd: 0,
      contextTokens: 1, contextLimit: 100, contextRatio: 0.01, warning: false, trimmed: false,
    };
  }
  compact(): Promise<string> {
    return Promise.resolve("noop");
  }
  clear(): void {}
  resume(): void {}
  setModel(ref: string): string {
    return ref;
  }
  listModels(): string[] {
    return ["p/m1"];
  }
  listProviders() {
    return [];
  }
  setProvider(): string {
    return this.model;
  }
  snapshot(): SessionSnapshot {
    return {
      id: "s1", startedAt: "2026-11-08T12:00:00.000Z", model: this.model,
      messages: [], turns: this.sent.length, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }
  close(): void {}
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

function frame(instance: ReturnType<typeof render>): string {
  return instance.lastFrame() ?? "";
}

test("/attach na TUI materializa o texto e envia metadados (#392)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-att-tui-"));
  writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/attach a.txt");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("anexo adicionado"));
    instance.stdin.write("resuma");
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    expect(session.sent[0]?.prompt).toContain("[anexo: a.txt]");
    expect(session.sent[0]?.metas?.[0]).toMatchObject({ kind: "text", name: "a.txt" });
  } finally {
    instance.unmount();
  }
});

test("imagem na TUI pede aprovação, recusa falha o turno e mantém o anexo (#392)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-att-tui-deny-"));
  writeFileSync(join(cwd, "a.png"), Buffer.from(pngData, "base64"));
  writeFileSync(join(cwd, "b.txt"), "ok");
  const session = new FakeSession();
  const approvals = createApprovalBridge();
  const instance = render(<TuiApp session={session} cwd={cwd} approvals={approvals} />);
  try {
    instance.stdin.write("/attach a.png");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("anexo adicionado"));

    instance.stdin.write("resuma");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("não redigíveis"));
    expect(frame(instance)).toContain("a.png");

    instance.stdin.write("n");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("erro: anexos do turno não aprovados"));
    expect(session.sent).toHaveLength(0);

    // o anexo recusado continua pendente: b.txt entra como segundo item
    instance.stdin.write("/attach b.txt");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("2. b.txt"));
    expect(frame(instance)).toContain("1. a.png (4 bytes decodificados)");
  } finally {
    instance.unmount();
  }
});

test("/attach repetido na TUI é recusado e materializa um bloco só (#392)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-att-tui-dup-"));
  writeFileSync(join(cwd, "a.txt"), "um\ndois\n");
  const session = new FakeSession();
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("/attach a.txt");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("anexo adicionado"));
    instance.stdin.write("/attach a.txt");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("já adicionado: a.txt"));

    instance.stdin.write("resuma");
    instance.stdin.write("\r");
    await waitFor(() => session.sent.length === 1);
    expect(session.sent[0]?.prompt).toBe("resuma\n\n[anexo: a.txt]\num\ndois\n");
    expect(session.sent[0]?.metas).toHaveLength(1);
  } finally {
    instance.unmount();
  }
});
