import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ConfigScreen } from "../src/tui/config-screen";
import type { ConfigSummary } from "../src/chat/config-summary";
import type { PermissionMode } from "../src/permissions";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

const summary: ConfigSummary = {
  configPath: "/tmp/proj/astro.config.json",
  maxTurns: "12",
  permissionMode: "ask",
  costs: [{ ref: "p/m1", inputPerM: 1, outputPerM: 2 }],
  budget: "day · limite US$ 5.00 · aviso em 80% · ao exceder: ask",
};

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

test("mostra config, maxTurns, modo, custos, budget e pastas confiáveis (#273)", async () => {
  const saved: PermissionMode[] = [];
  const instance = render(
    <ConfigScreen
      colors={colors}
      summary={summary}
      trustedFolders={["/tmp/proj"]}
      onClose={() => undefined}
      onSaveMode={(mode) => { saved.push(mode); }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Configuração") === true);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("config: /tmp/proj/astro.config.json");
    expect(frame).toContain("run.maxTurns: 12");
    expect(frame).toContain("permissions.mode: ask");
    expect(frame).toContain("p/m1: in US$ 1.00/M · out US$ 2.00/M");
    expect(frame).toContain("day · limite US$ 5.00");
    expect(frame).toContain("/tmp/proj");
    expect(saved).toEqual([]);
  } finally {
    instance.unmount();
  }
});

test("enter abre o seletor; up+enter salva allow-edits e o modo exibido muda (#273)", async () => {
  const saved: PermissionMode[] = [];
  const instance = render(
    <ConfigScreen
      colors={colors}
      summary={summary}
      trustedFolders={[]}
      onClose={() => undefined}
      onSaveMode={(mode) => { saved.push(mode); }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Configuração") === true);
    instance.stdin.write("\r"); // main -> pick (cursor inicia no ativo: ask)
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b[A"); // up: ask -> allow-edits
    await waitFor(() => instance.lastFrame()?.includes("→ allow-edits") === true);
    instance.stdin.write("\r"); // aplica
    await waitFor(() => saved.length === 1);
    expect(saved).toEqual(["allow-edits"]);
    await waitFor(() => instance.lastFrame()?.includes("permissions.mode: allow-edits") === true);
    expect(instance.lastFrame()).toContain("modo salvo: allow-edits");
  } finally {
    instance.unmount();
  }
});

test("bypass pede confirmação: x cancela sem salvar, c salva (#273)", async () => {
  const saved: PermissionMode[] = [];
  const instance = render(
    <ConfigScreen
      colors={colors}
      summary={summary}
      trustedFolders={[]}
      onClose={() => undefined}
      onSaveMode={(mode) => { saved.push(mode); }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Configuração") === true);
    instance.stdin.write("m"); // main -> pick
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b[A"); // ask -> allow-edits
    await waitFor(() => instance.lastFrame()?.includes("→ allow-edits") === true);
    instance.stdin.write("\u001b[A"); // allow-edits -> bypass
    await waitFor(() => instance.lastFrame()?.includes("→ bypass") === true);
    instance.stdin.write("\r"); // bypass -> tela de confirmação
    await waitFor(() => instance.lastFrame()?.includes("sem aprovação humana") === true);
    expect(saved).toEqual([]);
    instance.stdin.write("x"); // cancela: volta ao main sem salvar
    await waitFor(() => (instance.lastFrame() ?? "").includes("↑/↓") === false);
    expect(saved).toEqual([]);
    expect(instance.lastFrame()).toContain("permissions.mode: ask");
    // de novo, agora confirmando (ao reabrir o seletor o cursor volta ao ativo: ask)
    instance.stdin.write("m");
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b[A");
    await waitFor(() => instance.lastFrame()?.includes("→ allow-edits") === true);
    instance.stdin.write("\u001b[A");
    await waitFor(() => instance.lastFrame()?.includes("→ bypass") === true);
    instance.stdin.write("\r");
    await waitFor(() => instance.lastFrame()?.includes("sem aprovação humana") === true);
    instance.stdin.write("c"); // confirma
    await waitFor(() => saved.length === 1);
    expect(saved).toEqual(["bypass"]);
    await waitFor(() => instance.lastFrame()?.includes("permissions.mode: bypass") === true);
  } finally {
    instance.unmount();
  }
});

test("esc no main fecha; esc no seletor volta; ctrl+c fecha; falha de save mostra erro e não troca o modo (#273)", async () => {
  let closed = 0;
  const instance = render(
    <ConfigScreen
      colors={colors}
      summary={summary}
      trustedFolders={[]}
      onClose={() => { closed++; }}
      onSaveMode={(mode) => { if (mode === "allow-edits") throw new Error("disco cheio"); }}
    />,
  );
  try {
    await waitFor(() => instance.lastFrame()?.includes("Configuração") === true);
    instance.stdin.write("m");
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b"); // esc no pick -> main
    await waitFor(() => (instance.lastFrame() ?? "").includes("↑/↓") === false);
    expect(closed).toBe(0);
    instance.stdin.write("m");
    await waitFor(() => instance.lastFrame()?.includes("↑/↓") === true);
    instance.stdin.write("\u001b[A"); // ask -> allow-edits
    await waitFor(() => instance.lastFrame()?.includes("→ allow-edits") === true);
    instance.stdin.write("\r"); // falha de save
    await waitFor(() => instance.lastFrame()?.includes("erro: disco cheio") === true);
    expect(instance.lastFrame()).toContain("permissions.mode: ask"); // não mudou
    instance.stdin.write("\u0003"); // ctrl+c -> fecha
    await waitFor(() => closed === 1);
  } finally {
    instance.unmount();
  }
});
