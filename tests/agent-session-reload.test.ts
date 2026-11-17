import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { saveProfileStore } from "../src/providers/profiles";

test("reload preserva a escolha explícita e cai no projeto se o modelo sumir", () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-reload-"));
  const home = mkdtempSync(join(tmpdir(), "astro-reload-home-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  saveProfileStore({
    version: 1,
    activeProfileId: "q",
    profiles: [{
      id: "q", name: "Q", kind: "openai-compat",
      baseUrl: "https://q.example/v1", credentialRef: "Q_KEY",
      models: [{ id: "m2", tags: ["writing-code"], context: 8192 }],
    }],
  }, join(home, "providers.json"));

  const session = new AgentSession({ configPath, cwd, env: { ASTRO_HOME: home } });
  expect(session.model).toBe("q/m2");
  expect(session.providerSource).toBe("global");
  expect(session.providerSelection).toBe("store");

  session.setModel("p/m1");
  session.reload();
  expect(session.model).toBe("p/m1");
  expect(session.messages.length).toBe(1);

  // Depois da migração (#459) `config.json` é a fonte de verdade: remover o
  // perfil de lá é o equivalente a apagar o store legado.
  const homeConfig = join(home, "config.json");
  const migrated = JSON.parse(readFileSync(homeConfig, "utf8")) as {
    providers: Record<string, unknown>;
    models: { provider: string }[];
    activeProfileId?: string;
  };
  delete migrated.providers.q;
  delete migrated.activeProfileId;
  migrated.models = migrated.models.filter((model) => model.provider !== "q");
  writeFileSync(homeConfig, JSON.stringify(migrated));
  session.reload();
  expect(session.model).toBe("p/m1");
  expect(session.messages.length).toBe(1);
});
