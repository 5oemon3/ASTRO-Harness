import { describe, expect, test } from "bun:test";
import { cliErrorLine } from "../src/cli-error";

describe("cliErrorLine (#510: code em erro tipado, sempre redigido)", () => {
  test("erro sem code imprime só a mensagem", () => {
    expect(cliErrorLine(new Error("boom"))).toBe("erro: boom");
  });

  test("erro tipado imprime `erro: <code>: <mensagem>`", () => {
    const err = new Error("defina KEY no ambiente · exporte a variável");
    (err as { code?: string }).code = "credential_missing";
    expect(cliErrorLine(err)).toBe("erro: credential_missing: defina KEY no ambiente · exporte a variável");
  });

  test("segredo na mensagem é redigido (I-03)", () => {
    const secret = ["s", "k", "-"].join("") + "abcdefgh12345678";
    expect(cliErrorLine(new Error(`falhou com ${secret}`))).toBe("erro: falhou com [REDACTED]");
  });

  test("valor que não é Error vira string", () => {
    expect(cliErrorLine("texto puro")).toBe("erro: texto puro");
  });

  test("code que não é string é ignorado", () => {
    const err = new Error("boom");
    (err as { code?: unknown }).code = 42;
    expect(cliErrorLine(err)).toBe("erro: boom");
  });
});
