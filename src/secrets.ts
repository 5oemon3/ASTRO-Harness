/** Predicados de header/credencial compartilhados por config, store e plugins (I-03). */

const AUTH_HEADER = /(^|-)authorization$|(^|-)api[-_]?key$|(^|-)key$|(^|-)secret$|^cookie$|^set-cookie$|^x-auth(-|$)|token$/;
/** Headers que terminam em `-key` mas são metadado, não credencial. */
const METADATA_KEY_HEADERS = new Set(["idempotency-key", "x-idempotency-key"]);
const SECRET_VALUE = /^(sk-|nvapi-|AIza|ghp_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|eyJ[\w-]+\.[\w-]+\.)/;
/** `Bearer token`/`Basic base64` com token único; prosa ("Basic authentication required") não conta. */
const AUTH_SCHEME = /^(bearer|basic)\s+\S{6,}$/i;

export function isAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (METADATA_KEY_HEADERS.has(lower)) return false;
  return AUTH_HEADER.test(lower);
}

export function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (AUTH_SCHEME.test(trimmed)) return true;
  const text = trimmed.replace(/^(bearer|basic)\s+/i, "");
  return SECRET_VALUE.test(text);
}

/** Prefixo de `credentialRef` que aponta para o cofre local (ADR-0019). */
export const VAULT_REF_PREFIX = "vault:";
/** Id de credencial do cofre: `cred-<uuid>`. */
const VAULT_ID = /^cred-[A-Za-z0-9-]{8,}$/;

export function isVaultRef(value: string): boolean {
  return value.startsWith(VAULT_REF_PREFIX);
}

export function isVaultId(value: string): boolean {
  return VAULT_ID.test(value);
}

/** `vault:<credentialId>` bem formado; o id é público, o valor nunca (I-03). */
export function isVaultCredentialRef(value: string): boolean {
  return isVaultRef(value) && isVaultId(value.slice(VAULT_REF_PREFIX.length));
}

/** Nome de variável de ambiente (fonte de segredo nomeada, I-03). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function isEnvName(value: string): boolean {
  return ENV_NAME.test(value);
}
