import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { ProviderScreen, listActions } from "../src/tui/provider-screen";
import { ProfileManager } from "../src/provider/profile-manager";
import { getThemeColors } from "../src/tui/theme";
import { runCommand } from "../src/tui/commands";
import type { ChatSession } from "../src/chat/repl";

const colors = getThemeColors("dark");

function project() {
  return validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function manager() {
  const home = mkdtempSync(join(tmpdir(), "astro-tui-provider-"));
  return new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
}

function codexManager() {
  const home = mkdtempSync(join(tmpdir(), "astro-tui-codex-"));
  const project = validateConfig({
    providers: { c: { kind: "codex-oauth", credentialsPath: join(home, "auth.json") } },
    models: [{ provider: "c", id: "gpt-5.5", tags: ["writing-code"], context: 8192 }],
    agent: { model: "c/gpt-5.5", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
  return new ProfileManager({ project, env: { ASTRO_HOME: home } });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("lista providers com marcador e origem", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      currentModel="p/m1"
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  const frame = instance.lastFrame() ?? "";
  expect(frame).toContain("em uso: p/m1");
  expect(frame).toContain("p (p)");
  expect(frame).toContain("[project]");
  expect(frame).toContain("a adicionar");
  instance.unmount();
});

test("ctrl+c fecha a tela de providers", async () => {
  let closed = 0;
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      onClose={() => { closed++; }}
      onActivate={() => undefined}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("\u0003");
    await waitFor(() => closed === 1);
  } finally {
    instance.unmount();
  }
});

test("t pede confirmação, cancela sem chamada e executa com enter", async () => {
  let calls = 0;
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      onClose={() => undefined}
      onActivate={() => undefined}
      onTest={async () => { calls++; return { name: "provider:p", status: "ok", latencyMs: 12 }; }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("t");
    await waitFor(() => instance.lastFrame()?.includes("Testar p?") === true);
    expect(calls).toBe(0);
    instance.stdin.write("\u001b");
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    expect(calls).toBe(0);
    instance.stdin.write("t");
    await waitFor(() => instance.lastFrame()?.includes("Testar p?") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("ok · 12ms") === true);
    expect(calls).toBe(1);
  } finally {
    instance.unmount();
  }
});

test("resultado down mostra classe de erro e latência", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      onClose={() => undefined}
      onActivate={() => undefined}
      onTest={async () => ({ name: "provider:p", status: "down", latencyMs: 7, detail: "HTTP 401 em GET /models" })}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("t");
    await waitFor(() => instance.lastFrame()?.includes("Testar p?") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("down (auth) · 7ms") === true);
  } finally {
    instance.unmount();
  }
});

test("l inicia o login Codex, mostra o código e ativa ao concluir", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const done = new Promise<unknown>((resolve) => { finish = resolve; });
  let activated = "";
  const instance = render(
    <ProviderScreen
      manager={codexManager()}
      colors={colors}
      onClose={() => undefined}
      onActivate={(id) => { activated = id; }}
      onChanged={() => undefined}
      onLogin={async () => ({
        device: { deviceAuthId: "dev-1", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device", intervalMs: 1000 },
        done: done as never,
      })}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("l");
    await waitFor(() => instance.lastFrame()?.includes("grava em") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("ABCD-1234") === true);
    expect(instance.lastFrame()).toContain("https://auth.openai.com/codex/device");
    finish!({});
    await waitFor(() => instance.lastFrame()?.includes("login concluído") === true);
    expect(activated).toBe("c");
  } finally {
    instance.unmount();
  }
});

test("esc durante o login Codex aborta a espera", async () => {
  let signal: AbortSignal | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const done = new Promise<unknown>((resolve) => { finish = resolve; });
  const instance = render(
    <ProviderScreen
      manager={codexManager()}
      colors={colors}
      onClose={() => undefined}
      onActivate={() => undefined}
      onLogin={async (_id, received) => {
        signal = received;
        return {
          device: { deviceAuthId: "dev-1", userCode: "WXYZ-9999", verificationUrl: "https://auth.openai.com/codex/device", intervalMs: 1000 },
          done: done as never,
        };
      }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("l");
    await waitFor(() => instance.lastFrame()?.includes("grava em") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("WXYZ-9999") === true);
    instance.stdin.write("\u001b");
    await waitFor(() => instance.lastFrame()?.includes("login cancelado") === true);
    expect(signal?.aborted).toBe(true);
    finish!({});
  } finally {
    instance.unmount();
  }
});

test("a abre o formulário e salva um provider custom", async () => {
  const m = manager();
  const activated: string[] = [];
  const order: string[] = [];
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={(id) => { activated.push(id); order.push("activate"); }}
      onChanged={() => order.push("changed")}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("De onde partir?") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Nome") === true);
  instance.stdin.write("Local");
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Base URL") === true);
  instance.stdin.write("http://localhost:1/v1");
  await waitFor(() => instance.lastFrame()?.includes("http://localhost:1/v1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Modelos") === true);
  instance.stdin.write("m1");
  await waitFor(() => instance.lastFrame()?.includes("m1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Variável da chave") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Confirmar") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("salvo: local") === true);
  expect(m.list().map((item) => item.id)).toContain("local");
  expect(activated).toContain("local");
  expect(order).toEqual(["changed", "activate"]);
  instance.unmount();
});

const fakeSecret = ["s", "k", "-"].join("") + "live-abcdef12345";

const frame = (instance: ReturnType<typeof render>): string => instance.lastFrame() ?? "";

async function fillCredentialsStep(instance: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => frame(instance).includes("De onde partir?"));
  instance.stdin.write("\r");
  await waitFor(() => frame(instance).includes("Nome"));
  instance.stdin.write("Local");
  instance.stdin.write("\r");
  await waitFor(() => frame(instance).includes("Base URL"));
  instance.stdin.write("http://localhost:1/v1");
  await waitFor(() => frame(instance).includes("http://localhost:1/v1"));
  instance.stdin.write("\r");
  await waitFor(() => frame(instance).includes("Modelos"));
  instance.stdin.write("m1");
  await waitFor(() => frame(instance).includes("m1"));
  instance.stdin.write("\r");
  await waitFor(() => frame(instance).includes("Variável da chave"));
}

test("chave colada vai para o cofre e o perfil usa vault:<id> (#350)", async () => {
  const m = manager();
  let savedProvider = "";
  let savedSecret = "";
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={(providerId, secret) => {
        savedProvider = providerId;
        savedSecret = secret;
        return "vault:cred-12345678";
      }}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write(fakeSecret);
    await waitFor(() => frame(instance).includes("******"));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("Confirmar"));
    expect(frame(instance)).toContain("vault:<novo>");
    expect(frame(instance)).not.toContain(fakeSecret);
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("salvo: local"));
    expect(savedProvider).toBe("local");
    expect(savedSecret).toBe(fakeSecret);
    const stored = m.list().find((item) => item.id === "local");
    expect(stored?.credentialRef).toBe("vault:cred-12345678");
    expect(JSON.stringify(m.list())).not.toContain(fakeSecret);
    expect(frame(instance)).not.toContain(fakeSecret);
  } finally {
    instance.unmount();
  }
});

test("chave sem cofre disponível não grava o perfil nem ecoa o segredo (#350)", async () => {
  const m = manager();
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write(fakeSecret);
    await waitFor(() => frame(instance).includes("******"));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("cofre de credenciais indisponível"));
    expect(frame(instance)).toContain("Variável da chave");
    expect(frame(instance)).not.toContain(fakeSecret);
    expect(m.list().some((item) => item.id === "local")).toBe(false);
  } finally {
    instance.unmount();
  }
});

test("entrada que não é env nem chave reconhecível fica no passo (#350)", async () => {
  const m = manager();
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={() => "vault:cred-12345678"}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write("minha-chave");
    await waitFor(() => frame(instance).includes("***********")); // 11 chars
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("cole a chave completa"));
    expect(frame(instance)).toContain("Variável da chave");
    expect(m.list().some((item) => item.id === "local")).toBe(false);
  } finally {
    instance.unmount();
  }
});

test("edit preserva headers e remove confirma", async () => {
  const m = manager();
  const added = m.add({
    name: "Casa",
    kind: "openai-compat",
    baseUrl: "https://casa.example/v1",
    credentialRef: "KEY",
    headers: { "X-Title": "ASTRO" },
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  const edit = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "edit", target: added.id }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => edit.lastFrame()?.includes("Editar casa") === true);
  for (const label of ["Base URL", "Modelos", "Variável da chave", "Confirmar"]) {
    edit.stdin.write("\r");
    await waitFor(() => edit.lastFrame()?.includes(label) === true);
  }
  edit.stdin.write("\r");
  await waitFor(() => edit.lastFrame()?.includes("salvo: casa") === true);
  expect(m.list().find((item) => item.id === "casa")?.headers).toEqual({ "X-Title": "ASTRO" });
  edit.unmount();

  const remove = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "remove", target: "casa" }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => remove.lastFrame()?.includes("Remover Casa?") === true);
  remove.stdin.write("s");
  await waitFor(() => remove.lastFrame()?.includes("removido: casa") === true);
  expect(m.list().some((item) => item.id === "casa")).toBe(false);
  remove.unmount();
});

test("add pelo catálogo na TUI persiste quotaDomain", async () => {
  const m = manager();
  const instance = render(
    <ProviderScreen manager={m} colors={colors} initial={{ mode: "add" }} onClose={() => undefined} onActivate={() => undefined} />,
  );
  await waitFor(() => instance.lastFrame()?.includes("De onde partir?") === true);
  instance.stdin.write("\u001B[B");
  await waitFor(() => instance.lastFrame()?.includes("> nvidia") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Nome") === true);
  for (const label of ["Base URL", "Modelos", "Variável da chave", "Confirmar"]) {
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes(label) === true);
  }
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("salvo: nvidia") === true);
  expect(m.list().find((item) => item.id === "nvidia")?.quotaDomain).toBe("nvidia");
  instance.unmount();
});

test("falha de ativação aparece na tela", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => { throw new Error("boom ativação"); }}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("De onde partir?") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Nome") === true);
  instance.stdin.write("Local");
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Base URL") === true);
  instance.stdin.write("http://localhost:1/v1");
  await waitFor(() => instance.lastFrame()?.includes("http://localhost:1/v1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Modelos") === true);
  instance.stdin.write("m1");
  await waitFor(() => instance.lastFrame()?.includes("m1") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Variável da chave") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("Confirmar") === true);
  instance.stdin.write("\r");
  await waitFor(() => instance.lastFrame()?.includes("não ativado") === true);
  expect(instance.lastFrame()).toContain("boom ativação");
  instance.unmount();
});

test("remove com alvo desconhecido abre a lista, não a confirmação", async () => {
  const instance = render(
    <ProviderScreen
      manager={manager()}
      colors={colors}
      initial={{ mode: "remove", target: "ghost" }}
      onClose={() => undefined}
      onActivate={() => undefined}
    />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  expect(instance.lastFrame()).toContain("não encontrado");
  expect(instance.lastFrame()).not.toContain("Remover");
  instance.unmount();
});

test("provider do projeto não é removível pela tela", async () => {
  const instance = render(
    <ProviderScreen manager={manager()} colors={colors} onClose={() => undefined} onActivate={() => undefined} />,
  );
  await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
  instance.stdin.write("d");
  await waitFor(() => instance.lastFrame()?.includes("astro.config.json") === true);
  expect(instance.lastFrame()).toContain("definido no astro.config.json");
  instance.unmount();
});

test("/provider abre a tela pela TUI", async () => {
  const outcome = await runCommand({ kind: "provider", action: "list" }, {} as ChatSession, {});
  expect(outcome.openProviders).toEqual({ mode: "list" });
  const add = await runCommand({ kind: "provider", action: "add" }, {} as ChatSession, {});
  expect(add.openProviders).toEqual({ mode: "add" });
  const edit = await runCommand({ kind: "provider", action: "edit", target: "x" }, {} as ChatSession, {});
  expect(edit.openProviders).toEqual({ mode: "edit", target: "x" });
});

test("listActions monta menu numerado conforme disponibilidade (#272)", () => {
  const ran: string[] = [];
  const mk = (name: string) => () => { ran.push(name); };
  const current = manager().list()[0]!;
  const full = listActions({
    current, canTest: true, canLogin: true,
    add: mk("add"), activate: mk("activate"), edit: mk("edit"),
    remove: mk("remove"), test: mk("test"), login: mk("login"), close: mk("close"),
  });
  expect(full.map((a) => a.label)).toEqual([
    "Adicionar provider", "Definir como ativo", "Editar", "Remover", "Testar conexão", "Login Codex", "Fechar",
  ]);
  expect(full.map((a) => a.key)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  full[1]!.run();
  expect(ran).toEqual(["activate"]);

  const minimal = listActions({
    current: undefined, canTest: false, canLogin: false,
    add: mk("add"), activate: mk("activate"), edit: mk("edit"),
    remove: mk("remove"), test: mk("test"), login: mk("login"), close: mk("close"),
  });
  expect(minimal.map((a) => a.label)).toEqual(["Adicionar provider", "Fechar"]);
});

test("menu de ações abre com m, navega por setas e despacha com enter (#272)", async () => {
  let activated = "";
  const instance = render(
    <ProviderScreen manager={manager()} colors={colors} onClose={() => undefined} onActivate={(id) => { activated = id; }} />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("m");
    await waitFor(() => instance.lastFrame()?.includes("Ações") === true);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("1 Adicionar provider");
    expect(frame).toContain("2 Definir como ativo");
    expect(frame).toContain("5 Fechar");
    instance.stdin.write("\u001b[B"); // ↓ -> "Definir como ativo"
    await waitFor(() => instance.lastFrame()?.includes("> 2 Definir como ativo") === true);
    instance.stdin.write("\r");
    await waitFor(() => activated === "p");
    expect(instance.lastFrame()).toContain("ativo: p");
  } finally {
    instance.unmount();
  }
});

test("menu de ações aceita número direto e m fecha o menu (#272)", async () => {
  const instance = render(
    <ProviderScreen manager={manager()} colors={colors} onClose={() => undefined} onActivate={() => undefined} />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Providers") === true);
    instance.stdin.write("m");
    await waitFor(() => instance.lastFrame()?.includes("Ações") === true);
    instance.stdin.write("3"); // Editar -> provider de projeto não é editável pela tela
    await waitFor(() => instance.lastFrame()?.includes("astro.config.json") === true);
    instance.stdin.write("m");
    await waitFor(() => (instance.lastFrame()?.includes("Ações") ?? false) === false);
  } finally {
    instance.unmount();
  }
});

test("chave no formato AWS (uppercase) vai para o cofre, não para credentialRef (#351)", async () => {
  const m = manager();
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  let savedSecret = "";
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={(_id, secret) => {
        savedSecret = secret;
        return "vault:cred-12345678";
      }}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write(awsKey);
    await waitFor(() => frame(instance).includes("*".repeat(awsKey.length)));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("Confirmar"));
    expect(frame(instance)).toContain("vault:<novo>");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("salvo: local"));
    expect(savedSecret).toBe(awsKey);
    expect(m.list().find((item) => item.id === "local")?.credentialRef).toBe("vault:cred-12345678");
    expect(JSON.stringify(m.list())).not.toContain(awsKey);
  } finally {
    instance.unmount();
  }
});

test("nome de variável continua indo para credentialRef (#350)", async () => {
  const m = manager();
  let vaultCalls = 0;
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={() => { vaultCalls++; return "vault:cred-12345678"; }}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write("OPENAI_API_KEY");
    await waitFor(() => frame(instance).includes("*".repeat("OPENAI_API_KEY".length)));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("Confirmar"));
    expect(frame(instance)).toContain("OPENAI_API_KEY");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("salvo: local"));
    expect(vaultCalls).toBe(0);
    expect(m.list().find((item) => item.id === "local")?.credentialRef).toBe("OPENAI_API_KEY");
  } finally {
    instance.unmount();
  }
});

test("editar perfil com vault:<id> preserva a ref ao passar pelo passo (#351)", async () => {
  const m = manager();
  const added = m.add({
    name: "Casa", kind: "openai-compat", baseUrl: "https://casa.example/v1",
    credentialRef: "vault:cred-12345678",
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "edit", target: added.id }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={() => { throw new Error("não deveria criar credencial"); }}
    />,
  );
  try {
    await waitFor(() => frame(instance).includes("Editar casa"));
    for (const label of ["Base URL", "Modelos", "Variável da chave", "Confirmar"]) {
      instance.stdin.write("\r");
      await waitFor(() => frame(instance).includes(label));
    }
    expect(frame(instance)).toContain("vault:cred-12345678");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("salvo: casa"));
    expect(m.list().find((item) => item.id === "casa")?.credentialRef).toBe("vault:cred-12345678");
  } finally {
    instance.unmount();
  }
});

test("falha do cofre em edição preserva a credencial antiga (#351)", async () => {
  const m = manager();
  const added = m.add({
    name: "Casa", kind: "openai-compat", baseUrl: "https://casa.example/v1", credentialRef: "KEY",
    models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
  });
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "edit", target: added.id }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={() => { throw new Error("cofre falhou"); }}
    />,
  );
  try {
    await waitFor(() => frame(instance).includes("Editar casa"));
    for (const label of ["Base URL", "Modelos", "Variável da chave"]) {
      instance.stdin.write("\r");
      await waitFor(() => frame(instance).includes(label));
    }
    instance.stdin.write("\u007f".repeat("KEY".length)); // limpa a ref antiga
    instance.stdin.write(fakeSecret);
    await waitFor(() => frame(instance).includes("*".repeat(fakeSecret.length)));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("Confirmar"));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("cofre falhou"));
    expect(m.list().find((item) => item.id === "casa")?.credentialRef).toBe("KEY");
    expect(frame(instance)).not.toContain(fakeSecret);
  } finally {
    instance.unmount();
  }
});

test("ref de cofre inválida desfaz o perfil e descarta a credencial criada (#351)", async () => {
  const m = manager();
  let discarded = "";
  const instance = render(
    <ProviderScreen
      manager={m}
      colors={colors}
      initial={{ mode: "add" }}
      onClose={() => undefined}
      onActivate={() => undefined}
      onSaveSecret={() => "vault:invalido"}
      onDiscardSecret={(ref) => { discarded = ref; }}
    />,
  );
  try {
    await fillCredentialsStep(instance);
    instance.stdin.write(fakeSecret);
    await waitFor(() => frame(instance).includes("*".repeat(fakeSecret.length)));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("Confirmar"));
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("credentialRef"));
    expect(discarded).toBe("vault:invalido");
    expect(m.list().some((item) => item.id === "local")).toBe(false);
    expect(frame(instance)).not.toContain(fakeSecret);
  } finally {
    instance.unmount();
  }
});
