import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { DiffViewer } from "../src/tui/diff-viewer";

const colors = { accent: "cyan", warning: "yellow", error: "red" };
const frame = (instance: ReturnType<typeof render>): string => instance.lastFrame() ?? "";

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

const SAMPLE = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " context",
  "-old",
  "+new",
].join("\n") + "\n";

function longDiff(total: number): string {
  const lines = ["@@ -1," + total + " +1," + total + " @@"];
  for (let i = 1; i <= total; i++) lines.push(` line-${String(i).padStart(2, "0")}`);
  return lines.join("\n") + "\n";
}

test("mostra título com path e estatísticas, e as linhas do diff (#64)", async () => {
  const instance = render(
    <DiffViewer path="src/a.ts" diff={SAMPLE} colors={colors} onClose={() => {}} />,
  );
  try {
    await waitFor(() => frame(instance).includes("diff · src/a.ts"));
    expect(frame(instance)).toContain("+1");
    expect(frame(instance)).toContain("-1");
    expect(frame(instance)).toContain("@@ -1,3 +1,3 @@");
    expect(frame(instance)).toContain("-old");
    expect(frame(instance)).toContain("+new");
    expect(frame(instance)).toContain(" context");
  } finally { instance.unmount(); }
});

test(" rola com j/↓ dentro da viewport e prende nos limites (#64)", async () => {
  const instance = render(
    <DiffViewer path="big.ts" diff={longDiff(30)} colors={colors} viewport={5} onClose={() => {}} />,
  );
  try {
    await waitFor(() => frame(instance).includes("linha 1-5/31")); // 30 linhas + 1 hunk
    expect(frame(instance)).toContain("line-01");
    expect(frame(instance)).not.toContain("line-06");
    for (let i = 0; i < 10; i++) instance.stdin.write("j");
    await waitFor(() => frame(instance).includes("linha 11-15/31"));
    expect(frame(instance)).toContain("line-11");
    expect(frame(instance)).not.toContain("line-01");
    instance.stdin.write("\u001b[A"); // up
    await waitFor(() => frame(instance).includes("linha 10-14/31"));
    for (let i = 0; i < 100; i++) instance.stdin.write("\u001b[A"); // prende no topo
    await waitFor(() => frame(instance).includes("linha 1-5/31"));
  } finally { instance.unmount(); }
});

test("redige segredos do diff e do path no próprio render (I-03) (#64)", async () => {
  const secret = "sk-live-abcdef12345";
  const diff = "@@ -1 +1 @@\n-old\n+const k = \"" + secret + "\";\n";
  const instance = render(
    <DiffViewer path={"cfg-" + secret + ".ts"} diff={diff} colors={colors} onClose={() => {}} />,
  );
  try {
    await waitFor(() => frame(instance).includes("diff ·"));
    expect(frame(instance)).toContain("[REDACTED]");
    expect(frame(instance)).not.toContain(secret);
  } finally { instance.unmount(); }
});

test("diff vazio renderiza sem quebrar e j além do fim prende no último lote (#64)", async () => {
  const empty = render(<DiffViewer path="vazio.ts" diff="" colors={colors} onClose={() => {}} />);
  try {
    await waitFor(() => frame(empty).includes("linha 0-0/0"));
    expect(frame(empty)).toContain("+0");
    expect(frame(empty)).toContain("-0");
  } finally { empty.unmount(); }

  const instance = render(
    <DiffViewer path="big.ts" diff={longDiff(30)} colors={colors} viewport={5} onClose={() => {}} />,
  );
  try {
    await waitFor(() => frame(instance).includes("linha 1-5/31"));
    for (let i = 0; i < 100; i++) instance.stdin.write("j");
    await waitFor(() => frame(instance).includes("linha 27-31/31"));
  } finally { instance.unmount(); }
});

test("pgdn avança uma página e esc/q fecham o overlay (#64)", async () => {
  let closed = 0;
  const instance = render(
    <DiffViewer path="big.ts" diff={longDiff(30)} colors={colors} viewport={5} onClose={() => { closed++; }} />,
  );
  try {
    await waitFor(() => frame(instance).includes("linha 1-5/31"));
    instance.stdin.write("\u001b[6~"); // pageDown
    await waitFor(() => frame(instance).includes("linha 6-10/31"));
    instance.stdin.write("q");
    await waitFor(() => closed === 1);
  } finally { instance.unmount(); }

  let closedByEsc = 0;
  const second = render(
    <DiffViewer path="big.ts" diff={longDiff(30)} colors={colors} viewport={5} onClose={() => { closedByEsc++; }} />,
  );
  try {
    await waitFor(() => frame(second).includes("linha 1-5/31"));
    second.stdin.write("\u001b"); // esc
    await waitFor(() => closedByEsc === 1);
  } finally { second.unmount(); }
});
