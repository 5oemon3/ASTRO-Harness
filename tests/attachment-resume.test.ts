import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { SessionApi } from "../src/chat/session-api";
import { type AttachmentMeta } from "../src/attachments/model";
import { ArtifactStore, type ArtifactOwner } from "../src/attachments/store";
import { FAKE_PRIVATE_ACL, testEnv } from "./setup";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), "astro-attachment-resume-"));
  dirs.push(base);
  const cwd = join(base, "work");
  const astroHome = join(base, "home");
  const root = join(base, "artifacts");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(astroHome, { recursive: true });
  const bodies: Array<{ messages?: Array<{ role: string; content: string; images?: Array<{ dataBase64: string }> }> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as (typeof bodies)[number]);
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192, capabilities: { vision: true } }],
    agent: { model: "p/m1", maxSteps: 3, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  const context = { cwd, astroHome, checkPrivate: () => true, hardenPrivate: () => FAKE_PRIVATE_ACL };
  return {
    root, cwd, astroHome, context, bodies, configPath,
    session: () => new AgentSession({
      configPath, cwd, env: { ...testEnv({ KEY: "k" }), ASTRO_HOME: astroHome }, systemPrompt: "sys",
      artifactRoot: root, artifactCheckPrivate: () => true, artifactHardenPrivate: () => FAKE_PRIVATE_ACL,
    }),
    artifact: (owner: ArtifactOwner = { sessionId: "s1", runId: "r1", lineage: [] }) =>
      new ArtifactStore(root, context).save(owner, Buffer.from(PNG, "base64"), "image/png"),
    meta: (saved: { ref: string; hash: string }): AttachmentMeta => ({
      kind: "image", name: "a.png", sizeBytes: Buffer.from(PNG, "base64").length,
      mediaType: "image/png", ref: saved.ref, hash: saved.hash,
    }),
    stop: () => server.stop(true),
  };
}

function snapshot(id: string, meta: AttachmentMeta, lineage: string[] = ["s1"]) {
  return {
    id, startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
    messages: [{ role: "user" as const, content: "olhe", attachments: [meta] }],
    turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001, lineage,
  };
}

describe("attachment resume (ADR-0026, #392)", () => {
  test("resume reidrata a mesma imagem e o snapshot não persiste base64", async () => {
    const { session, artifact, meta, bodies, stop } = setup();
    const saved = artifact(), chat = session();
    try {
      chat.resume(snapshot("s2", meta(saved)));
      const user = chat.messages.find((message) => message.role === "user");
      expect(user?.images?.[0]?.dataBase64).toBe(PNG);
      const snapshotJson = JSON.stringify(chat.snapshot());
      expect(snapshotJson).not.toContain(PNG);
      expect(chat.snapshot().messages.find((message) => message.role === "user")?.images).toBeUndefined();

      await chat.send("depois");
      expect(JSON.stringify(bodies[0])).toContain(PNG);
      expect(JSON.stringify(chat.snapshot())).not.toContain(PNG);
    } finally {
      chat.close();
      stop();
    }
  });

  test("resume falha tipado para artefato adulterado ou de outra sessão", async () => {
    const { root, session, artifact, meta, stop } = setup();

    const tampered = artifact();
    writeFileSync(join(root, ...tampered.ref.split("/")), "adulterado");
    const tamperedChat = session();
    try {
      expect(() => tamperedChat.resume(snapshot("s2", meta(tampered)))).toThrow(/attachment_image_invalid|hash/i);
      expect(tamperedChat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      tamperedChat.close();
    }

    const other = artifact({ sessionId: "s-other", runId: "r1", lineage: [] });
    const otherChat = session();
    try {
      expect(() => otherChat.resume(snapshot("s2", meta(other), ["s1"]))).toThrow(/attachment_image_invalid|sess/i);
      expect(otherChat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      otherChat.close();
      stop();
    }
  });

  test("rejeita artefato de sessão irmã mesmo com ancestral comum", () => {
    const { session, artifact, meta, stop } = setup();
    const sibling = artifact({ sessionId: "b", runId: "r1", lineage: ["a"] });
    const chat = session();
    try {
      expect(() => chat.resume(snapshot("c", meta(sibling), ["a", "c"]))).toThrow(/attachment_image_invalid|outra sessão|sess/i);
      expect(chat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      chat.close();
      stop();
    }
  });

  test("não reidrata anexo na mensagem assistant do compact", () => {
    const { session, artifact, meta, stop } = setup();
    const saved = artifact();
    const chat = session();
    try {
      chat.resume({
        id: "s2", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
        messages: [
          { role: "user", content: "olhe", attachments: [meta(saved)] },
          { role: "assistant", content: "resumo", attachments: [meta(saved)] },
        ],
        turns: 2, tokensIn: 10, tokensOut: 5, costUsd: 0.001, lineage: ["s1"],
      });
      expect(chat.messages.find((message) => message.role === "assistant")?.images).toBeUndefined();
      expect(chat.snapshot().messages.find((message) => message.role === "assistant")?.attachments?.[0]?.ref).toBe(saved.ref);
    } finally {
      chat.close();
      stop();
    }
  });

  test("limita a linhagem a 32 ids mantendo a sessão atual", () => {
    const { session, stop } = setup();
    const chat = session();
    try {
      const lineage = Array.from({ length: 32 }, (_, index) => `s${index}`);
      chat.resume({
        id: "s-new", startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
        messages: [{ role: "user", content: "ok" }], turns: 1, tokensIn: 1, tokensOut: 1, costUsd: null, lineage,
      });
      expect(chat.snapshot().lineage).toHaveLength(32);
      expect(chat.snapshot().lineage?.at(-1)).toBe("s-new");
    } finally {
      chat.close();
      stop();
    }
  });

  test("clear esquece a linhagem de imagens", () => {
    const { session, artifact, meta, stop } = setup();
    const chat = session();
    try {
      chat.resume(snapshot("s2", meta(artifact()), ["s1"]));
      expect(chat.snapshot().lineage).toEqual(["s1", "s2"]);
      chat.clear();
      expect(chat.snapshot().lineage).toBeUndefined();
    } finally {
      chat.close();
      stop();
    }
  });

  test("compact preserva o metadado da imagem e remove os bytes", async () => {
    const { session, artifact, meta, stop } = setup();
    const saved = artifact(), chat = session();
    try {
      chat.resume(snapshot("s2", meta(saved)));
      await chat.compact();
      const summary = chat.snapshot().messages.find((message) => message.role === "assistant");
      expect(summary?.attachments?.[0]).toMatchObject({ ref: saved.ref, hash: saved.hash });
      expect(JSON.stringify(chat.snapshot())).not.toContain(PNG);
    } finally {
      chat.close();
      stop();
    }
  });

  test("segundo compact mantém o metadado do sumário anterior", async () => {
    const { session, artifact, meta, stop } = setup();
    const saved = artifact(), chat = session();
    try {
      chat.resume(snapshot("s2", meta(saved)));
      await chat.compact();
      await chat.compact();
      const summary = chat.snapshot().messages.find((message) => message.role === "assistant");
      expect(summary?.attachments?.[0]).toMatchObject({ ref: saved.ref, hash: saved.hash });
    } finally {
      chat.close();
      stop();
    }
  });

  test("SessionApi save/load preserva ref/hash e resume reidrata a imagem", () => {
    const { session, artifact, meta, stop } = setup();
    const saved = artifact();
    const apiDir = mkdtempSync(join(tmpdir(), "astro-session-api-"));
    dirs.push(apiDir);
    const api = new SessionApi(apiDir);
    try {
      api.save({ schemaVersion: 1, ...snapshot("s3", meta(saved)) });
      const loaded = api.load("s3");
      expect(loaded.messages[0]!.attachments?.[0]).toMatchObject({ ref: saved.ref, hash: saved.hash });

      const chat = session();
      try {
        chat.resume(loaded);
        const user = chat.messages.find((message) => message.role === "user");
        expect(user?.images?.[0]?.dataBase64).toBe(PNG);
      } finally {
        chat.close();
      }
    } finally {
      api.close();
      stop();
    }
  });

  test("resume descarta imagem com ref redigido e avisa em vez de abortar", () => {
    const { session, stop } = setup();
    const warnings: string[] = [];
    const warning = spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const chat = session();
    try {
      chat.resume(snapshot("s4", {
        kind: "image", name: "a.png", sizeBytes: 10, mediaType: "image/png",
        ref: "session-[REDACTED]/[REDACTED]", hash: "[REDACTED]",
      }));
      const user = chat.messages.find((message) => message.role === "user");
      expect(user?.images).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/indisponível|ignorada/i);
    } finally {
      warning.mockRestore();
      chat.close();
      stop();
    }
  });

  test("resume descarta imagem cujo artefato e sidecar sumiram e avisa", () => {
    const { root, session, artifact, meta, stop } = setup();
    const saved = artifact();
    const [key, hash] = saved.ref.split("/");
    unlinkSync(join(root, key!, hash!));
    unlinkSync(join(root, key!, `${hash!}.json`));
    const warnings: string[] = [];
    const warning = spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const chat = session();
    try {
      chat.resume(snapshot("s5", meta(saved)));
      const user = chat.messages.find((message) => message.role === "user");
      expect(user?.images).toBeUndefined();
      expect(user?.attachments).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/indisponível|ignorada|ausente/i);
    } finally {
      warning.mockRestore();
      chat.close();
      stop();
    }
  });

  test("resume é fatal para sidecar ilegível", () => {
    const { root, session, artifact, meta, stop } = setup();
    const saved = artifact();
    const [dir, hash] = saved.ref.split("/");
    writeFileSync(join(root, dir!, `${hash!}.json`), "{", "utf8");
    const chat = session();
    try {
      expect(() => chat.resume(snapshot("s7", meta(saved)))).toThrow(/attachment_image_invalid|ilegível/i);
      expect(chat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      chat.close();
      stop();
    }
  });

  test("resume é fatal quando o hash é diretório", () => {
    const { root, session, artifact, meta, stop } = setup();
    const saved = artifact();
    const [dir, hash] = saved.ref.split("/");
    unlinkSync(join(root, dir!, hash!));
    mkdirSync(join(root, dir!, hash!));
    const chat = session();
    try {
      expect(() => chat.resume(snapshot("s8", meta(saved)))).toThrow(/attachment_image_invalid|ilegível/i);
      expect(chat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      chat.close();
      stop();
    }
  });

  test("resume reidrata imagem boa e poda metadado morto; SessionApi persiste podado", () => {
    const { root, session, artifact, meta, stop } = setup();
    const good = artifact();
    const dead = artifact({ sessionId: "s-dead", runId: "r1", lineage: [] });
    const [deadDir, deadHash] = dead.ref.split("/");
    unlinkSync(join(root, deadDir!, deadHash!));
    unlinkSync(join(root, deadDir!, `${deadHash!}.json`));
    const warnings: string[] = [];
    const warning = spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const apiDir = mkdtempSync(join(tmpdir(), "astro-session-api-mixed-"));
    dirs.push(apiDir);
    const chat = session();
    const api = new SessionApi(apiDir);
    try {
      chat.resume({
        ...snapshot("s6", meta(good)),
        messages: [{ role: "user", content: "olhe", attachments: [meta(good), meta(dead)] }],
      });
      const user = chat.messages.find((message) => message.role === "user");
      expect(user?.images).toHaveLength(1);
      expect(user?.attachments).toHaveLength(1);
      expect(user?.attachments?.[0]?.ref).toBe(good.ref);
      expect(warnings.join("\n")).toMatch(/indisponível|ignorada/i);

      api.save({ schemaVersion: 1, ...chat.snapshot() });
      const loaded = api.load(chat.id);
      const loadedUser = loaded.messages.find((message) => message.role === "user");
      expect(loadedUser?.attachments).toHaveLength(1);
      expect(loadedUser?.attachments?.[0]?.ref).toBe(good.ref);
    } finally {
      api.close();
      chat.close();
      warning.mockRestore();
      stop();
    }
  });

  test("GC na criação do store remove ref expirado e preserva o atual", () => {
    const { root, context, session, artifact, meta, stop } = setup();
    const current = artifact();
    const old = artifact({ sessionId: "s-old", runId: "r1", lineage: [] });
    const oldPath = join(root, ...old.ref.split("/"));
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, eightDaysAgo, eightDaysAgo);
    const chat = session();
    try {
      chat.resume(snapshot("s2", meta(current)));
      const reader = new ArtifactStore(root, context);
      expect(() => reader.read(old.ref)).toThrow(/attachment_image_invalid|ausente/i);
      expect(() => reader.read(current.ref)).not.toThrow();
    } finally {
      chat.close();
      stop();
    }
  });

  test("resume revalida a raiz de artefato e falha tipado sem alterar a sessão", () => {
    const { cwd, root, astroHome, configPath, stop } = setup();
    const chat = new AgentSession({
      configPath, cwd, env: { ...testEnv({ KEY: "k" }), ASTRO_HOME: astroHome }, systemPrompt: "sys",
      artifactRoot: root, artifactCheckPrivate: () => false, artifactHardenPrivate: () => FAKE_PRIVATE_ACL,
    });
    const meta: AttachmentMeta = {
      kind: "image", name: "a.png", sizeBytes: 4, mediaType: "image/png",
      ref: "session-abc/deadbeef", hash: "a".repeat(64),
    };
    try {
      let thrown: unknown;
      try {
        chat.resume(snapshot("s2", meta));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ name: "AttachmentError", code: "attachment_root_invalid" });
      expect(chat.messages.map((message) => message.role)).toEqual(["system"]);
    } finally {
      chat.close();
      stop();
    }
  });
});
