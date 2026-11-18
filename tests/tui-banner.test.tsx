import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { HEADER_WIDTH, Header, budgetColor, footerBase, headerLine, modeColor, packageVersion, truncateMiddle } from "../src/tui/banner";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

test("headerLine tem versão, provider/modelo e saúde, sem endpoint nem modo (#480)", () => {
  expect(headerLine({ provider: "p", model: "p/m1", health: "ok", version: "9.9.9" }))
    .toBe("ASTRO v9.9.9 · p/m1 · ok");
  // ref completa não duplica o provider
  expect(headerLine({ provider: "p", model: "m1", health: "n/d", version: "9.9.9" }))
    .toBe("ASTRO v9.9.9 · p/m1 · n/d");
});

test("headerLine cabe em 80 colunas no pior par do catálogo (#480)", () => {
  const worst = headerLine({
    provider: "openai-compatible",
    model: "openai-compatible/meta/llama-3.3-70b-instruct",
    health: "down",
    version: "0.1.0-alpha.4",
  });
  expect(worst.length).toBe(75);
  expect(worst.length).toBeLessThanOrEqual(HEADER_WIDTH);
});

test("headerLine corta modelo e provider, nunca a saúde (#480)", () => {
  const longProvider = "p".repeat(64);
  const line = headerLine({ provider: longProvider, model: `${longProvider}/modelo-longo`, health: "down", version: "0.1.0-alpha.4" });
  expect(line.length).toBeLessThanOrEqual(HEADER_WIDTH);
  expect(line.endsWith(" · down")).toBe(true);
  expect(line).toContain("…");

  expect(truncateMiddle("abcdefghij", 5)).toBe("ab…ij");
  expect(truncateMiddle("abc", 10)).toBe("abc");
});

test("packageVersion lê a versão semântica do package.json (#274)", () => {
  expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

test("Header renderiza a linha sem caixa e com a saúde (#480)", () => {
  const instance = render(<Header colors={colors} provider="p" model="p/m1" health="down" version="1.2.3" />);
  try {
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ASTRO v1.2.3 · p/m1 · down");
    expect(frame).not.toContain("estado:");
  } finally {
    instance.unmount();
  }
});

test("footerBase só mostra campos com valor (#480)", () => {
  expect(footerBase({ place: "~", turns: 0, tokensIn: 0, tokensOut: 0, costUsd: null })).toBe("~");
  expect(footerBase({ place: "~", turns: 2, tokensIn: 10, tokensOut: 5, costUsd: 0.5 }))
    .toBe("~ · 2 turno(s) · 10/5 tokens · US$ 0.500000");
  expect(footerBase({ place: "~", turns: 1, tokensIn: 1, tokensOut: 0, costUsd: null }))
    .toBe("~ · 1 turno(s) · 1/0 tokens");
});

test("modeColor: só bypass usa cor de alerta (#270)", () => {
  expect(modeColor("bypass", colors)).toBe(colors.error);
  expect(modeColor("allow-edits", colors)).toBeUndefined();
  expect(modeColor("ask", colors)).toBeUndefined();
  expect(modeColor(undefined, colors)).toBeUndefined();
});

test("headerLine remove controle e não deixa o provider forjar uma linha (#480)", () => {
  const line = headerLine({ provider: "p\u001b]0;x\u0007", model: "m\nok", health: "ok", version: "1.0.0" });
  expect(line).not.toContain("\u001b");
  expect(line).not.toContain("\n");
  expect(line.endsWith(" · ok")).toBe(true);
});


test("budgetColor: teto em erro, aviso em warning, resto sem cor (#480)", () => {
  expect(budgetColor({ warning: false, exhausted: false, ceilingHit: true }, colors)).toBe(colors.error);
  expect(budgetColor({ warning: false, exhausted: true, ceilingHit: false }, colors)).toBe(colors.error);
  expect(budgetColor({ warning: true, exhausted: false, ceilingHit: false }, colors)).toBe(colors.warning);
  expect(budgetColor({ warning: false, exhausted: false, ceilingHit: false }, colors)).toBeUndefined();
});
