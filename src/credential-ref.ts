/**
 * Resolução de `credentialRef` (ADR-0019, #311): env nomeada ou `vault:<id>`.
 * O valor existe só em memória; erros nomeiam o ref, nunca o segredo (I-03).
 */
import { ConfigError } from "./core/config";
import { isVaultId, isVaultRef, looksLikeSecret, VAULT_REF_PREFIX } from "./secrets";

/** Leitor mínimo do cofre; `Vault` satisfaz sem expor o resto da API. */
export interface VaultReader {
  read(id: string): { value: string } | undefined;
}

/** Próximo passo exibido quando a credencial falta (#510); nunca repete valor (I-03). */
const NEXT_STEP_ENV = "exporte a variável no shell ou salve a credencial no cofre (astro providers vault-import; /provider na TUI)";
const NEXT_STEP_VAULT = "salve a credencial no cofre (/provider na TUI; astro providers vault-import na CLI)";

/**
 * Mensagem única (pt-BR) de credencial ausente/vazia (#510), usada por
 * `createProvider`, `health` e `doctor`: nomeia só o ref e o provider, com o
 * próximo passo. Ref com cara de segredo tem o nome suprimido (I-03).
 */
export function credentialMissingMessage(ref: string, provider?: string): string {
  if (looksLikeSecret(ref)) {
    return `defina a variável de ambiente do provider (nome suprimido: parece um segredo) · ${NEXT_STEP_ENV}`;
  }
  if (isVaultRef(ref)) {
    return `credencial de vault "${ref}" ausente ou vazia · ${NEXT_STEP_VAULT}`;
  }
  const who = provider === undefined ? "" : ` (provider "${provider}")`;
  return `defina ${ref} no ambiente${who} · ${NEXT_STEP_ENV}`;
}

/** Erro tipado de credencial ausente/vazia (#510): `code` + mensagem com próximo passo; nunca ecoa o valor (I-03). */
export class CredentialMissingError extends Error {
  readonly code = "credential_missing";
  readonly credentialRef: string;
  constructor(ref: string, provider?: string) {
    super(credentialMissingMessage(ref, provider));
    this.name = "CredentialMissingError";
    this.credentialRef = ref;
  }
}

export function resolveCredentialValue(
  ref: string,
  env: Record<string, string | undefined>,
  vault: VaultReader,
): string | undefined {
  if (!isVaultRef(ref)) return env[ref];
  const id = ref.slice(VAULT_REF_PREFIX.length);
  // Nunca ecoar a ref malformada: o usuário pode ter colado um segredo nela.
  if (!isVaultId(id)) {
    throw new ConfigError(`referência de vault inválida: use vault:<credentialId>`);
  }
  const entry = vault.read(id);
  if (entry === undefined) {
    // id ausente no cofre é credencial faltando (#510), não config inválida
    throw new CredentialMissingError(ref);
  }
  return entry.value;
}
