/**
 * Handlers da chave digitada na tela de providers (#350/#352): guardam a
 * credencial ativa anterior para que o rollback restaure o estado do cofre.
 */
import { isVaultCredentialRef, VAULT_REF_PREFIX } from "../secrets";
import type { Vault } from "../vault";

export interface SecretHandlers {
  saveSecret(providerId: string, secret: string): string;
  discardSecret(ref: string): void;
}

export function createSecretHandlers(vault: Vault): SecretHandlers {
  // Pilha por provider: desfazer saves em sequência devolve a ativa original,
  // não só a última criada (dois saves antes do rollback).
  const previous = new Map<string, Array<string | undefined>>();
  return {
    saveSecret(providerId, secret) {
      const active = vault.list().find((item) => item.providerId === providerId && item.active)?.id;
      const stack = previous.get(providerId) ?? [];
      stack.push(active);
      previous.set(providerId, stack);
      const created = vault.create({ providerId, label: "tui", secret });
      return `${VAULT_REF_PREFIX}${created.id}`;
    },
    discardSecret(ref) {
      if (!isVaultCredentialRef(ref)) return;
      const id = ref.slice(VAULT_REF_PREFIX.length);
      try {
        // list() traz o providerId sem decifrar o segredo (I-03).
        const entry = vault.list().find((item) => item.id === id);
        if (entry === undefined) return;
        const stack = previous.get(entry.providerId);
        const active = stack?.at(-1);
        vault.remove(id);
        // Só desempilha depois de restaurar: falha em activate mantém o estado.
        if (active !== undefined) vault.activate(active);
        stack?.pop();
      } catch {
        // preserva o erro original da gravação do perfil
      }
    },
  };
}
