import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Banner, bannerLine, modeColor, packageVersion } from "../src/tui/banner";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

test("bannerLine junta versão, provider, modelo, endpoint e estado (#274)", () => {
  expect(bannerLine({ provider: "p", model: "p/m1", endpoint: "https://p.example/v1", state: "ok", version: "9.9.9" }))
    .toBe("ASTRO v9.9.9 · p · p/m1 · https://p.example/v1 · estado: ok");
});

test("packageVersion lê a versão semântica do package.json (#274)", () => {
  expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

test("Banner renderiza a linha no frame (#274)", () => {
  const instance = render(<Banner colors={colors} provider="p" model="p/m1" endpoint="-" state="down" version="1.2.3" />);
  try {
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ASTRO v1.2.3");
    expect(frame).toContain("p · p/m1");
    expect(frame).toContain("estado: down");
  } finally {
    instance.unmount();
  }
});

test("bannerLine anexa o modo quando informado (#270)", () => {
  expect(bannerLine({ provider: "p", model: "p/m1", endpoint: "-", state: "ok", version: "9.9.9", mode: "bypass" }))
    .toBe("ASTRO v9.9.9 · p · p/m1 · - · estado: ok · modo: bypass");
  // sem modo, a linha fica exatamente como antes
  expect(bannerLine({ provider: "p", model: "p/m1", endpoint: "-", state: "ok", version: "9.9.9" }))
    .toBe("ASTRO v9.9.9 · p · p/m1 · - · estado: ok");
});

test("modeColor: só bypass usa cor de alerta (#270)", () => {
  expect(modeColor("bypass", colors)).toBe(colors.error);
  expect(modeColor("allow-edits", colors)).toBeUndefined();
  expect(modeColor("ask", colors)).toBeUndefined();
  expect(modeColor(undefined, colors)).toBeUndefined();
});

test("Banner renderiza o modo no frame (#270)", () => {
  const instance = render(<Banner colors={colors} provider="p" model="p/m1" endpoint="-" state="ok" version="1.2.3" mode="bypass" />);
  try {
    expect(instance.lastFrame() ?? "").toContain("modo: bypass");
  } finally {
    instance.unmount();
  }
});
