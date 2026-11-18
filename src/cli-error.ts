/**
 * Linha de erro da CLI (#510): `erro: <code>: <mensagem>` quando o erro é
 * tipado com `code`, senão `erro: <mensagem>`. A mensagem sempre passa por
 * `redactSecrets` (I-03). Puro, sem I/O, para ser testável fora do entrypoint.
 */
import { redactSecrets } from "./sanitize-external";

export function cliErrorLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && typeof (error as { code?: unknown }).code === "string"
    ? (error as unknown as { code: string }).code
    : undefined;
  const message = redactSecrets(raw);
  return code === undefined ? `erro: ${message}` : `erro: ${code}: ${message}`;
}
