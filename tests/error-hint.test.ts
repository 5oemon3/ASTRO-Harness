import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError } from "../src/core/config";
import { NoProviderError } from "../src/providers/profiles";
import { ProviderError } from "../src/providers/types";
import { errorHint, errorLine } from "../src/tui/error-hint";

const cases: Array<[ProviderError["errClass"], string]> = [
  ["auth", "revise a credencial com /provider"],
  ["hard_quota", "troque de modelo com /model"],
  ["transient_rate_limit", "aguarde e repita; o retry já tentou"],
  ["network_timeout", "repita; se persistir, aumente providers.<nome>.timeoutMs"],
  ["outage", "repita ou troque com /model"],
  ["invalid_request", "ajuste o pedido; /help lista os comandos"],
];

test("cada classe de provider tem o próximo passo da tabela (#480)", () => {
  for (const [errClass, hint] of cases) {
    expect(errorHint(new ProviderError(errClass, "x"))).toBe(hint);
  }
});

test("config e ausência de provider têm próximo passo; erro comum não inventa (#480)", () => {
  expect(errorHint(new ConfigError("config inválida"))).toBe("rode astro doctor");
  expect(errorHint(new NoProviderError("nenhum provider"))).toBe("configure com /provider");
  expect(errorHint(new Error("boom"))).toBeUndefined();
});

test("errorLine não deixa a mensagem forjar uma linha (#480)", () => {
  const line = errorLine(new Error("boom"), "linha1\n✔ modo: bypass");
  expect(line).toBe("erro: linha1 ✔ modo: bypass");
  expect(errorLine(new Error("boom"), "boom")).toBe("erro: boom");
  expect(errorLine(new ProviderError("auth", "401"), "401")).toBe("erro: 401 · revise a credencial com /provider");
});

test("nenhum hint carrega caminho ou valor de config", () => {
  for (const [errClass] of cases) {
    const hint = errorHint(new ProviderError(errClass, "x")) ?? "";
    expect(hint).not.toContain(join("a", "b"));
    expect(hint).not.toContain("http");
  }
});
