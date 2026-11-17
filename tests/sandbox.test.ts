import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTask } from "../src/core/app";
import { validateConfig, ConfigError } from "../src/core/config";
import { realpathPreservingDots } from "../src/tools/paths";
import { ToolError } from "../src/tools/types";
import {
  SANDBOX_DISABLED_WARNING,
  SandboxRequiredForShellError,
  configureRunCommand,
  dockerArgv,
  dockerInfoSupportsLinuxContainers,
  releaseDockerArgv,
  resolveDockerImage,
  resolveSandboxSetting,
  sandboxWarning,
  sanitizedEnv,
} from "../src/tools/run-command";
import { expectSandboxRefusal, installDockerSpawnMock, isolatedRunCommand } from "./helpers/docker-mock";

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config tools.run_command.sandbox (F4-6)", () => {
  test("sem tools: sandbox efetivo ligado (fail-closed)", () => {
    const cfg = validateConfig(structuredClone(baseConfig));
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(true);
  });

  test("tools.run_command sem sandbox → ligado (opt-out precisa ser explícito)", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: {} };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox: false é opt-out explícito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: false } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(false);
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(false);
  });

  test("tools.run_command.sandbox: true aceito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: true } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox inválido → ConfigError", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: "yes" } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});

describe("erros e aviso do sandbox (ADR-0027, #391 slice 5b)", () => {
  test("SandboxRequiredForShellError tem code e modo, sem ecoar comando", () => {
    const error = new SandboxRequiredForShellError("sandbox:false");
    expect(error.code).toBe("sandbox_required_for_shell");
    expect(error.message).toContain("sandbox:false");
    expect(error.message).not.toContain("echo");
  });

  test("sandboxWarning avisa só quando o sandbox está desligado", () => {
    expect(sandboxWarning(true)).toBeUndefined();
    expect(sandboxWarning(false)).toBe(SANDBOX_DISABLED_WARNING);
    expect(SANDBOX_DISABLED_WARNING).toContain("sandbox:false");
    expect(SANDBOX_DISABLED_WARNING).toContain("run_command");
  });

  test("runTask emite o aviso de sandbox:false no boot (review B F5)", { timeout: 30000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-warn-"));
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      providers: { ...baseConfig.providers, openai: { ...baseConfig.providers.openai, baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 500, maxRetries: 0 } },
      tools: { run_command: { sandbox: false } },
    }));
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      await runTask({ configPath, cwd, task: "x", env: { OPENAI_API_KEY: "k" } }).catch(() => {});
    } finally {
      console.warn = original;
    }
    expect(warnings.some((message) => message.includes("sandbox:false"))).toBe(true);
  });
});

describe("sanitizedEnv (I-03)", () => {
  test("remove DB_PASS, SSH_PEM e PASSPHRASE sem remover nomes inocentes", () => {
    const env = sanitizedEnv({
      DB_PASS: "db-secret",
      SSH_PEM: "pem-secret",
      DEPLOY_PASSPHRASE: "pass-secret",
      GIT_AUTHOR_NAME: "autora",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("DB_PASS");
    expect(env).not.toHaveProperty("SSH_PEM");
    expect(env).not.toHaveProperty("DEPLOY_PASSPHRASE");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("remove AUTHORIZATION e variantes; mantém identidade git (I-03)", () => {
    const env = sanitizedEnv({
      AUTHORIZATION: "Bearer aaa",
      HTTP_AUTHORIZATION: "Bearer bbb",
      PROXY_AUTHORIZATION: "Bearer ccc",
      WWW_AUTHORIZATION: "Bearer ddd",
      GIT_AUTHOR_NAME: "autora",
      GIT_COMMITTER_NAME: "autor",
      GIT_AUTHOR_EMAIL: "a@b.c",
      GIT_COMMITTER_EMAIL: "a@b.c",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("AUTHORIZATION");
    expect(env).not.toHaveProperty("HTTP_AUTHORIZATION");
    expect(env).not.toHaveProperty("PROXY_AUTHORIZATION");
    expect(env).not.toHaveProperty("WWW_AUTHORIZATION");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
    expect(env.GIT_COMMITTER_NAME).toBe("autor");
    expect(env.GIT_AUTHOR_EMAIL).toBe("a@b.c");
    expect(env.GIT_COMMITTER_EMAIL).toBe("a@b.c");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("run_command sandbox (F4-6)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
  });

  test("detecção só aceita engine Linux (Windows containers não rodam alpine/--read-only)", () => {
    expect(dockerInfoSupportsLinuxContainers("24.0.7|linux\n")).toBe(true);
    expect(dockerInfoSupportsLinuxContainers("24.0.7|windows\n")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("|linux")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("24.0.7")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("")).toBe(false);
  });

  test("sandbox=false: recusa sandbox_required_for_shell sem spawnar o comando (I-19, slice 4b)", async () => {
    const mock = installDockerSpawnMock();
    try {
      const mod = await isolatedRunCommand("s4b-refuse");
      mod.configureRunCommand({ sandbox: false });
      const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
      const result = await mod.runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
      expectSandboxRefusal(result, mock);
      expect(result.output).not.toContain("echo ok"); // recusa não traz conteúdo de comando (I-03)
    } finally {
      mock.restore();
    }
  });

  test("sandbox=true com Docker (mock): executa só via docker run", async () => {
    const mock = installDockerSpawnMock(() => "ok-docker\n");
    try {
      const mod = await isolatedRunCommand("s4b-docker");
      mod.configureRunCommand({ sandbox: true });
      const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
      const result = await mod.runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("ok-docker");
      expect(mock.runCalls.length).toBeGreaterThan(0);
      expect(mock.calls.every((cmd) => cmd[0] === "docker")).toBe(true); // nada fora do docker
    } finally {
      mock.restore();
    }
  });

  test("sandbox=true sem Docker → recusa clara (sem downgrade silencioso)", async () => {
    const mod = await isolatedRunCommand("s4b-nodocker");
    mod.configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await mod.detectDockerAvailable();
    const result = await mod.runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
    if (!docker) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Docker");
      expect(result.output).toContain("sandbox");
    } else {
      // neste ambiente Docker existe; o comando roda contido
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("ok");
    }
  }, 60_000);

  test("sandbox=true: detecção de Docker é cacheada", async () => {
    const mod = await isolatedRunCommand("s4b-cache");
    const first = await mod.detectDockerAvailable();
    const second = await mod.detectDockerAvailable();
    expect(first).toBe(second);
  }, 60_000);

  test("sandbox=true com Docker: comando malicioso não escapa", async () => {
    const mod = await isolatedRunCommand("s4b-escape");
    mod.configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await mod.detectDockerAvailable();
    if (!docker) {
      // Windows CI sem Docker: teste de contenção é no-op aqui; coberto no Ubuntu
      expect(true).toBe(true);
      return;
    }

    // rede desabilitada: wget falha
    const net = await mod.runCommandTool.execute(
      { command: "wget -T 2 http://example.invalid 2>&1 || echo net-failed" },
      ctx(cwd),
    );
    expect(net.output).toContain("net-failed");

    // rootfs read-only: escrever fora do cwd falha
    const fsEscape = await mod.runCommandTool.execute(
      { command: "touch /etc/astro-evil 2>&1 || echo fs-blocked" },
      ctx(cwd),
    );
    expect(fsEscape.output).toContain("fs-blocked");

    // cwd continua gravável
    const writeOk = await mod.runCommandTool.execute(
      { command: "echo dentro > sandbox-ok.txt && cat sandbox-ok.txt" },
      ctx(cwd),
    );
    expect(writeOk.isError).toBeFalsy();
    expect(writeOk.output).toContain("dentro");

    // env do host não vaza para dentro do container
    const envProbe = await mod.runCommandTool.execute(
      { command: "sh -c 'echo KEY=${ASTRO_TEST_SECRET:-vazio}'" },
      ctx(cwd),
    );
    expect(envProbe.output).toContain("vazio");
  }, 60_000);
});

describe("dockerArgv: máscaras do sandbox (ADR-0027, #391 slice 4a)", () => {
  const argvCwd = (): string => mkdtempSync(join(tmpdir(), "astro-sb-argv-"));
  const created: string[][] = [];
  const rawDockerArgv = dockerArgv;
  const argvFor = (...args: Parameters<typeof dockerArgv>): string[] => {
    const argv = rawDockerArgv(...args);
    created.push(argv);
    return argv;
  };
  afterEach(() => {
    while (created.length > 0) releaseDockerArgv(created.pop()!);
  });

  const volumeSpecs = (argv: string[]): string[] =>
    argv.flatMap((value, i) => (value === "--volume" ? [argv[i + 1]] : []));

  const hasRoMaskFor = (argv: string[], target: string): boolean =>
    volumeSpecs(argv).some((spec) => spec.endsWith(`:${target}:ro`));

  const maskSourceFor = (argv: string[], target: string): string | undefined => {
    const spec = volumeSpecs(argv).find((s) => s.endsWith(`:${target}:ro`));
    return spec?.slice(0, spec.length - `:${target}:ro`.length);
  };

  test("argv contém --tmpfs /tmp e env GIT_DIR/GIT_CONFIG_NOSYSTEM/HOME", () => {
    const argv = argvFor("sb-test", { cwd: argvCwd() }, "echo ok");
    const tmpfsAt = argv.indexOf("--tmpfs");
    expect(tmpfsAt).toBeGreaterThan(-1);
    expect(argv[tmpfsAt + 1]).toBe("/tmp:rw,noexec,nosuid,size=64m");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("GIT_DIR=/dev/null");
    expect(argv).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(argv).toContain("HOME=/tmp");
  });

  test("imagem default oven/bun:1.4.2; override via ASTRO_DOCKER_IMAGE", () => {
    expect(resolveDockerImage({})).toBe("oven/bun:1.4.2");
    expect(resolveDockerImage({ ASTRO_DOCKER_IMAGE: "   " })).toBe("oven/bun:1.4.2");
    expect(resolveDockerImage({ ASTRO_DOCKER_IMAGE: "img@sha256:abcd" })).toBe("img@sha256:abcd");
    const cwd = argvCwd();
    expect(argvFor("sb-test", { cwd }, "echo ok")).toContain("oven/bun:1.4.2");
    const custom = argvFor("sb-test", { cwd, env: { ASTRO_DOCKER_IMAGE: "img@sha256:abcd" } }, "echo ok");
    expect(custom).toContain("img@sha256:abcd");
    expect(custom).not.toContain("oven/bun:1.4.2");
  });

  test(".env hard-block no cwd vira máscara de arquivo vazio :ro fora do cwd", () => {
    const cwd = argvCwd();
    writeFileSync(join(cwd, ".env"), "SUPER_SECRET=1");
    const argv = argvFor("sb-test", { cwd }, "echo ok");
    const root = resolve(cwd);
    const target = join(root, ".env");
    expect(hasRoMaskFor(argv, target)).toBe(true);
    const source = maskSourceFor(argv, target);
    expect(source).toBeDefined();
    expect(source!.startsWith(tmpdir())).toBe(true); // fonte fora do cwd
    const st = statSync(source!);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(0);
    // bind do cwd continua read-write (sem :ro)
    expect(volumeSpecs(argv)).toContain(`${root}:${root}`);
  });

  test(".env em subdiretório também é mascarado; .env.example (sensitive) não é", () => {
    const cwd = argvCwd();
    mkdirSync(join(cwd, "sub"));
    writeFileSync(join(cwd, "sub", ".env"), "X=1");
    writeFileSync(join(cwd, ".env.example"), "X=");
    const argv = argvFor("sb-test", { cwd }, "echo ok");
    const root = resolve(cwd);
    expect(hasRoMaskFor(argv, join(root, "sub", ".env"))).toBe(true);
    expect(hasRoMaskFor(argv, join(root, ".env.example"))).toBe(false);
  });

  test(".git é sempre mascarado: diretório em repo e arquivo em worktree", () => {
    const repoCwd = argvCwd();
    mkdirSync(join(repoCwd, ".git"));
    const argvRepo = argvFor("sb-test", { cwd: repoCwd }, "echo ok");
    const gitDir = join(resolve(repoCwd), ".git");
    expect(hasRoMaskFor(argvRepo, gitDir)).toBe(true);
    expect(statSync(maskSourceFor(argvRepo, gitDir)!).isDirectory()).toBe(true);
    const wtCwd = argvCwd();
    writeFileSync(join(wtCwd, ".git"), "gitdir: /elsewhere/.git");
    const argvWt = argvFor("sb-test", { cwd: wtCwd }, "echo ok");
    const gitFile = join(resolve(wtCwd), ".git");
    expect(hasRoMaskFor(argvWt, gitFile)).toBe(true);
    expect(statSync(maskSourceFor(argvWt, gitFile)!).isFile()).toBe(true);
  });

  test("ASTRO_ARTIFACT_ROOT é mascarado pelo realpath", () => {
    const cwd = argvCwd();
    const art = mkdtempSync(join(tmpdir(), "astro-art-"));
    const argv = argvFor("sb-test", { cwd, env: { ASTRO_ARTIFACT_ROOT: art } }, "echo ok");
    const target = realpathPreservingDots(art, resolve(cwd));
    expect(hasRoMaskFor(argv, target)).toBe(true);
    expect(statSync(maskSourceFor(argv, target)!).isDirectory()).toBe(true);
  });

  test("hard-block em profundidade > 12 é mascarado (recursivo, qualquer profundidade — ADR-0027)", () => {
    const cwd = argvCwd();
    const parts = Array.from({ length: 15 }, (_, i) => `n${i}`);
    mkdirSync(join(cwd, ...parts), { recursive: true });
    writeFileSync(join(cwd, ...parts, ".env"), "DEEP_SECRET=1");
    const argv = argvFor("sb-test", { cwd }, "echo ok");
    expect(hasRoMaskFor(argv, join(resolve(cwd), ...parts, ".env"))).toBe(true);
  });

  test("cwd inválido (arquivo): varredura falha fail-closed com ToolError", () => {
    const file = join(argvCwd(), "arq.txt");
    writeFileSync(file, "x");
    expect(() => argvFor("sb-test", { cwd: file }, "echo ok")).toThrow(ToolError);
  });

  test("cwd atrás de symlink/junction: .astro, protectedPaths e ASTRO_HOME léxicos viram máscara", () => {
    const real = mkdtempSync(join(tmpdir(), "astro-sbl-real-"));
    mkdirSync(join(real, ".astro"));
    mkdirSync(join(real, "protected"));
    mkdirSync(join(real, "home"));
    writeFileSync(join(real, "protected", "x.txt"), "x");
    const link = join(mkdtempSync(join(tmpdir(), "astro-sbl-")), "proj");
    if (process.platform === "win32") {
      expect(Bun.spawnSync(["cmd", "/c", "mklink", "/J", link, real]).exitCode).toBe(0);
    } else symlinkSync(real, link, "dir");
    const argv = argvFor(
      "sb",
      { cwd: link, protectedPaths: ["protected"], env: { ASTRO_HOME: join(link, "home") } },
      "echo ok",
    );
    const root = resolve(link);
    for (const t of [".astro", "protected", "home"]) expect(hasRoMaskFor(argv, join(root, t))).toBe(true);
  });
});

describe("sandbox: fontes de máscara não vazam em tmpdir (#391)", () => {
  test("remove o diretório de máscara após sucesso e após falha do comando", async () => {
    let fail = false;
    const mock = installDockerSpawnMock(() => (fail ? { code: 1, stdout: "", stderr: "boom" } : "ok\n"));
    try {
      const mod = await isolatedRunCommand("s4a-mask-cleanup");
      mod.configureRunCommand({ sandbox: true });
      const cwd = mkdtempSync(join(tmpdir(), "astro-sb-mask-clean-"));
      writeFileSync(join(cwd, ".env"), "X=1");
      const suffix = `:${join(resolve(cwd), ".env")}:ro`;
      const maskSource = (): string | undefined => {
        const argv = mock.runCalls.at(-1) ?? [];
        const index = argv.findIndex((value, i) => value === "--volume" && String(argv[i + 1]).endsWith(suffix));
        return index < 0 ? undefined : argv[index + 1]!.slice(0, -suffix.length);
      };
      for (const shouldFail of [false, true]) {
        fail = shouldFail;
        const result = await mod.runCommandTool.execute({ command: "echo probe" }, ctx(cwd));
        expect(result.isError === true).toBe(shouldFail);
        const source = maskSource();
        expect(source).toBeDefined();
        expect(existsSync(source!)).toBe(false);
      }
    } finally {
      mock.restore();
    }
  });
});