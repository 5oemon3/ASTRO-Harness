/**
 * Resolução de `credentialRef` (ADR-0019, #311): env nomeada ou `vault:<id>`.
 * O valor existe só em memória; erros nomeiam o ref, nunca o segredo (I-03).
 */
import { ConfigError } from "./config";
import { isVaultId, isVaultRef, VAULT_REF_PREFIX } from "./secrets";

/** Leitor mínimo do cofre; `Vault` satisfaz sem expor o resto da API. */
export interface VaultReader {
  read(id: string): { value: string } | undefined;
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
    throw new ConfigError(`credencial de vault "${ref}" não encontrada`);
  }
  return entry.value;
}
