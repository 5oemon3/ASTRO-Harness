import { describe, expect, test } from "bun:test";
import {
  boundHookToolResult,
  emitHook,
  MAX_HOOK_TOOL_RESULT_CHARS,
  sanitizeHookMessage,
} from "../src/chat/hooks";
import type { ChatMessage } from "../src/provider/types";

const secret = ["ghp", "_", "hook", "secret", "123456"].join("");

describe("session hooks (#367)", () => {
  test("sanitizeHookMessage redige todo texto e remove imagens", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: `eco ${secret}`,
      toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ apiKey: secret }) }],
      attachments: [{ kind: "image", name: `${secret}.png`, sizeBytes: 10, mediaType: "image/png", ref: "r", hash: "h" }],
      images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
    };

    const sanitized = sanitizeHookMessage(message);
    const json = JSON.stringify(sanitized);

    expect(sanitized).not.toHaveProperty("images");
    expect(json).not.toContain(secret);
    expect(json).toContain("[REDACTED]");
    expect(sanitized.attachments?.[0]?.name).not.toContain(secret);
    expect(sanitized.toolCalls?.[0]?.arguments).not.toContain(secret);
  });

  test("boundHookToolResult redige e limita o resultado incluindo o marcador", () => {
    const result = `${secret} ${"x".repeat(MAX_HOOK_TOOL_RESULT_CHARS + 50)}`;
    const bounded = boundHookToolResult(result);

    expect(bounded).not.toContain(secret);
    expect(bounded.endsWith("[truncated]")).toBe(true);
    expect(Array.from(bounded).length).toBe(MAX_HOOK_TOOL_RESULT_CHARS);

    expect(boundHookToolResult("x".repeat(MAX_HOOK_TOOL_RESULT_CHARS - 1)))
      .toBe("x".repeat(MAX_HOOK_TOOL_RESULT_CHARS - 1));
    expect(boundHookToolResult("x".repeat(MAX_HOOK_TOOL_RESULT_CHARS)))
      .toBe("x".repeat(MAX_HOOK_TOOL_RESULT_CHARS));

    const over = boundHookToolResult("x".repeat(MAX_HOOK_TOOL_RESULT_CHARS + 1));
    expect(over.endsWith("[truncated]")).toBe(true);
    expect(Array.from(over).length).toBe(MAX_HOOK_TOOL_RESULT_CHARS);
  });

  test("erro do observador não escapa de emitHook", () => {
    expect(() => emitHook(() => { throw new Error("observer boom"); }, { ok: true })).not.toThrow();
    expect(() => emitHook(undefined, { ok: true })).not.toThrow();
  });
});
