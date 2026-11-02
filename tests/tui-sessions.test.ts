import { describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, sessionSummaryLine } from "../src/chat/store";

const store = (): SessionStore => new SessionStore(mkdtempSync(join(tmpdir(), "astro-session-name-")));
const snapshot = (id: string) => ({
  id, startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1",
  messages: [{ role: "user" as const, content: "velho" }], turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001,
});

describe("rename de sessão (#64)", () => {
  test("grava o nome no mesmo arquivo e a lista/linha passam a mostrá-lo", () => {
    const sessions = store();
    const path = sessions.write(snapshot("abc"));
    const renamed = sessions.rename("abc", "  refatoração do parser  ");
    expect(renamed.name).toBe("refatoração do parser");
    expect(renamed.path).toBe(path); // mesmo arquivo, sem duplicar
    const listed = sessions.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("refatoração do parser");
    expect(sessionSummaryLine(listed[0]!, 0)).toContain("refatoração do parser");
    expect(sessions.load("abc").record.name).toBe("refatoração do parser");
  });
  test("nome vazio, longo, com controle ou invisível é recusado sem tocar no arquivo", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const bad = ["   ", "x".repeat(61), "a\u0000b", "a\u202eb", "a\u200bb", "a\u009fb", "a\ufeffb",
      "a\u2028b", "a\u2029b", "a\u2060b", "a\u180eb", "a\u061cb", "a\ufff9b"];
    for (const name of bad) expect(() => sessions.rename("abc", name)).toThrow(/nome da sessão inválido/);
    expect(sessions.load("abc").record.name).toBeUndefined();
    expect(sessions.list()[0]!.name).toBeUndefined();
    expect(() => sessions.rename("nope", "x")).toThrow(/não encontrada/);
  });
  test("persistir de novo depois do rename preserva o nome", () => {
    const sessions = store();
    const snap = snapshot("abc");
    sessions.write(snap);
    sessions.rename("abc", "parser");
    // auto-save de um turno novo reescreve o mesmo arquivo
    sessions.write({ ...snap, messages: [...snap.messages, { role: "user", content: "novo" }], turns: 2 });
    expect(sessions.list()[0]!.name).toBe("parser");
  });
  test("nome inválido no disco não derruba a sessão: vira ausente na leitura", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const path = sessions.list()[0]!.path;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.name = "a\tb";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]!.name).toBeUndefined();
    expect(sessions.load("abc").record.name).toBeUndefined();
  });
  test("limite conta code points; nome que cresce na redação falha limpo", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(sessions.rename("abc", "😀".repeat(31)).name).toBe("😀".repeat(31));
    expect(() => sessions.rename("abc", "😀".repeat(61))).toThrow(/nome da sessão inválido/);
    // 54 chars passam no limite, mas a redação expande acima de 60: falha sem sumir da lista
    expect(() => sessions.rename("abc", "password=a password=b password=c password=d password=e"))
      .toThrow(/nome da sessão inválido/);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]!.name).toBe("😀".repeat(31));
    // nome curto com segredo: grava e devolve o valor redigido, e continua listável
    const renamed = sessions.rename("abc", "login password=abc");
    expect(renamed.name).toBe("login password=[REDACTED]");
    expect(sessions.list()[0]!.name).toBe("login password=[REDACTED]");
  });
  test("startedAt com controle no disco descarta a sessão (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const path = sessions.list()[0]!.path;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.startedAt = "2026-10-01\r"; // Date.parse aceita date-only com controle; o \r volta à coluna 0 na linha
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(sessions.list()).toHaveLength(0);
    expect(() => sessions.load("abc")).toThrow(/não encontrada/);
  });

  test("write recusa model invisível em vez de gravar sessão que a leitura rejeita (#64)", () => {
    const sessions = store();
    expect(() => sessions.write({ ...snapshot("abc"), model: "p/gpt-4o\u200b" })).toThrow(/modelo da sessão inválido/);
    expect(sessions.list()).toHaveLength(0);
  });

  test("nome com ZWJ/ZWNJ legítimo (emoji composto, persa) é aceito (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(sessions.rename("abc", "👨‍👩‍👧 família").name).toBe("👨‍👩‍👧 família");
    expect(sessions.rename("abc", "می‌خواهد").name).toBe("می‌خواهد");
  });

  test("rename recusa ref que escapa do store; write descarta name em runtime (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(() => sessions.rename("../escape.json", "x")).toThrow(/fora do diretório/);
    sessions.rename("abc", "parser");
    sessions.write({ ...snapshot("abc"), name: "outro" } as never);
    expect(sessions.list()[0]!.name).toBe("parser");
  });

  test("model com escape invisível no disco descarta a sessão (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const path = sessions.list()[0]!.path;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.model = '{"a":"\\u009b31mPWNED"}'; // decodifica para C1 cru depois do sanitizeValue
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(sessions.list()).toHaveLength(0);
    expect(() => sessions.load("abc")).toThrow(/não encontrada/);
  });

  test("nome JSON com escape invisível no disco é descartado na leitura (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const path = sessions.list()[0]!.path;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // escape literal no arquivo: parseRecord aceita, mas a decodificação JSON solta U+009B cru
    raw.name = '{"a":"\\u009b31mPWNED"}';
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(sessions.list()[0]!.name).toBeUndefined();
    expect(sessions.load("abc").record.name).toBeUndefined();
  });
  test("sanitiza antes de validar: escape JSON de controle é recusado e o retorno é o gravado", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(() => sessions.rename("abc", '{"a":"\\u202e"}')).toThrow(/nome da sessão inválido/);
    expect(sessions.list()).toHaveLength(1);
    const renamed = sessions.rename("abc", "[1, 2]");
    expect(renamed.name).toBe("[1,2]");
    expect(sessions.list()[0]!.name).toBe("[1,2]");
  });
  test("tmp plantado como link não é seguido por write/rename (I-11)", () => {
    const sessions = store();
    const snap = snapshot("abc");
    sessions.write(snap);
    const path = sessions.list()[0]!.path;
    const outside = join(mkdtempSync(join(tmpdir(), "astro-session-outside-")), "alvo.txt");
    writeFileSync(outside, "intacto", "utf8");
    linkSync(outside, `${path}.tmp`); // repositório malicioso planta o irmão do arquivo
    expect(sessions.rename("abc", "parser").name).toBe("parser");
    expect(readFileSync(outside, "utf8")).toBe("intacto"); // não escreveu fora do store
    expect(statSync(outside).ino).not.toBe(statSync(path).ino); // a sessão não virou o link
    sessions.write(snap); // o write() também ignora o tmp plantado
    expect(readFileSync(outside, "utf8")).toBe("intacto");
    expect(sessions.list()[0]!.name).toBe("parser");
  });
});
