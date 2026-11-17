/**
 * Migração de `credentialRef` para o cofre (ADR-0019, #311 B.3): lê o valor
 * da env nomeada, cria a credencial no cofre e troca só a referência no
 * profile/config. Dry-run por default; o segredo nunca é impresso (I-03).
 */
import { ConfigError, updateConfigProviderCredentialRef } from "../config";
import { isEnvName, isVaultCredentialRef, isVaultRef } from "../secrets";
import { defaultScheme, Vault, vaultPath } from "../vault";
import { loadEffectiveConfig, loadProfileStore, profilesPath, providerIdentityFor, saveProfileStore } from "./profiles";

export interface VaultImportInput {
  provider: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  /** Store global; default `profilesPath(env)`. */
  storePath?: string;
  /** Injetável em testes; default lê o cofre do `ASTRO_HOME` do env. */
  vault?: Vault;
  /** Grava de fato; default false (dry-run). */
  apply?: boolean;
  /** Aceita o modo "plain" fora do Windows; default false. */
  allowPlain?: boolean;
  /** Injetável em testes; default `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface VaultImportResult {
  provider: string;
  envName: string;
  source: "project" | "global";
  status: "planned" | "imported";
  vaultRef?: string;
  warning?: string;
}

const PLAIN_WARNING = 'aviso: cofre em modo "plain" (sem cifra do SO); o segredo fica em arquivo 0600';

/** Troca a ref de um perfil global pelo writer atômico do store. */
function rewriteProfileRef(path: string, id: string, ref: string): void {
  const store = loadProfileStore(path);
  const index = store.profiles.findIndex((item) => item.id === id);
  if (index < 0) throw new ConfigError(`provider "${id}" não está no store global`);
  const profiles = [...store.profiles];
  profiles[index] = { ...profiles[index]!, credentialRef: ref };
  saveProfileStore({ ...store, profiles }, path);
}

/**
 * Planeja/executa a migração de um provider. Erros citam só nomes de env/ref,
 * nunca o valor; `apply` criar a credencial e trocar a referência.
 */
export function importVaultCredential(input: VaultImportInput): VaultImportResult {
  const effective = loadEffectiveConfig(input.configPath, {
    env: input.env,
    allowMissing: true,
    ...(input.storePath === undefined ? {} : { storePath: input.storePath }),
  });
  const providerConfig = effective.config.providers[input.provider];
  if (providerConfig === undefined) {
    throw new ConfigError(`provider "${input.provider}" não configurado`);
  }
  // Só openai-compat resolve `vault:` hoje; plugin/codex não leem o cofre.
  const compat = providerConfig as { kind: string; credentialRef?: unknown };
  if (compat.kind !== "openai-compat") {
    throw new ConfigError(`provider "${input.provider}" usa kind "${compat.kind}" e não lê o cofre`);
  }
  const ref = typeof compat.credentialRef === "string" ? compat.credentialRef : undefined;
  if (ref === undefined || ref === "") {
    throw new ConfigError(`provider "${input.provider}" não tem credentialRef para migrar`);
  }
  if (isVaultRef(ref)) {
    // Só ecoa o ref quando ele é um id de cofre bem formado; ref malformada
    // pode ser um segredo colado e nunca vai para a mensagem (I-03).
    if (isVaultCredentialRef(ref)) {
      throw new ConfigError(`provider "${input.provider}" já usa o cofre (${ref})`);
    }
    throw new ConfigError(`provider "${input.provider}" tem referência de vault inválida`);
  }
  if (!isEnvName(ref)) {
    throw new ConfigError(`credentialRef do provider "${input.provider}" não é um nome de variável de ambiente`);
  }
  const secret = input.env[ref];
  if (secret === undefined || secret === "") {
    throw new ConfigError(`defina ${ref} no ambiente para migrar`);
  }
  const { providerSource } = providerIdentityFor(effective, input.provider);
  if (providerSource === "env") {
    throw new ConfigError(
      "perfil de ambiente é efêmero e não pode ser migrado; crie um perfil com /provider add",
    );
  }
  const source = providerSource === "project" ? "project" : "global";
  const scheme = defaultScheme(input.platform ?? process.platform);
  const warning = scheme === "plain" ? PLAIN_WARNING : undefined;
  // Dry-run não grava: planeja também em plain e avisa que o apply vai exigir
  // a confirmação explícita (--allow-plain).
  if (input.apply !== true) {
    return {
      provider: input.provider, envName: ref, source, status: "planned",
      ...(warning === undefined ? {} : { warning }),
    };
  }
  if (scheme === "plain" && input.allowPlain !== true) {
    throw new ConfigError('cofre em modo "plain" fora do Windows; use --allow-plain para aceitar o aviso (arquivo 0600)');
  }

  const vault = input.vault ?? new Vault(vaultPath(input.env));
  const previousActive = vault.list().find((item) => item.providerId === input.provider && item.active)?.id;
  const created = vault.create({ providerId: input.provider, label: ref, secret });
  const vaultRef = `vault:${created.id}`;
  try {
    if (source === "project") {
      updateConfigProviderCredentialRef(input.configPath, input.provider, vaultRef);
    } else {
      rewriteProfileRef(input.storePath ?? profilesPath(input.env), input.provider, vaultRef);
    }
  } catch (error) {
    try {
      vault.remove(created.id);
      // create desativou as demais do provider; restaura a ativa anterior.
      if (previousActive !== undefined) vault.activate(previousActive);
    } catch {
      // preserva o erro original da escrita
    }
    throw error;
  }
  return {
    provider: input.provider, envName: ref, source, status: "imported", vaultRef,
    ...(warning === undefined ? {} : { warning }),
  };
}

/** Linha de saída do comando, sem o segredo. */
export function formatVaultImport(result: VaultImportResult): string {
  const line = result.status === "planned"
    ? `plano: importar ${result.envName} do provider "${result.provider}" para o cofre e trocar credentialRef por vault:<novo> (use --apply para gravar)`
    : `importado: provider "${result.provider}" agora usa ${result.vaultRef}`;
  return result.warning === undefined ? line : `${result.warning}\n${line}`;
}
