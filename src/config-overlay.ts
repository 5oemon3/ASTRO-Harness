/** Camadas de configuração (ADR-0029, #401): merge `global < projeto` e guarda
 * de estreitamento — o projeto só pode restringir a camada global. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BASELINE_MAX_STEPS, ConfigError, isPlainObject } from "./core/config";
import { isVaultRef } from "./secrets";

/** Ranque de permissão: `ask` é o mais restrito, `bypass` o mais largo. */
const MODE_RANK: Record<string, number> = { ask: 0, "allow-edits": 1, bypass: 2 };
/** Ranque do perfil do agent: `read-only` é o mais restrito. */
const PERMISSION_RANK: Record<string, number> = { "read-only": 0, write: 1, execute: 2, full: 3 };
/** Janela do budget: `project` é a mais estreita (o teto do time entra nela). */
const SCOPE_RANK: Record<string, number> = { project: 0, month: 1, day: 2, "use-as-you-go": 3 };
/** Chaves de credencial: guardam a referência, nunca o valor. */
const CREDENTIAL_KEYS = ["credentialRef", "credentialsPath"];

/** Mescla camadas: objetos por chave, arrays substituem, escalares substituem. */
export function mergeConfigLayers(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (key === "models" && Array.isArray(current) && Array.isArray(value)) merged[key] = mergeModelLayers(current, value);
    else if (isPlainObject(current) && isPlainObject(value)) {
      const next = mergeConfigLayers(current, value);
      // `model` e `profile` são uma chave lógica (o schema proíbe os dois):
      // declarar um no projeto descarta o herdado da camada global. O
      // conflito dentro da mesma camada é erro do schema (ADR-0007) e passa
      // intacto para a validação.
      if (value.model !== undefined && value.profile === undefined) delete (next as Record<string, unknown>).profile;
      else if (value.profile !== undefined && value.model === undefined) delete (next as Record<string, unknown>).model;
      merged[key] = next;
    } else merged[key] = value;
  }
  return merged;
}

/** `models` une por `provider/id`; a camada de cima prevalece no conflito. */
export function mergeModelLayers(base: readonly unknown[], overlay: readonly unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  let index = 0;
  for (const model of [...base, ...overlay]) {
    const key = isPlainObject(model) && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}` : `#${index}`; // modelo inválido fica à parte
    merged.set(key, model);
    index += 1;
  }
  return [...merged.values()];
}

/**
 * Schema de uma camada crua: `model` e `profile` não convivem (ADR-0007) e
 * `models` não se repete. A mescla entre camadas resolve o XOR; o conflito
 * dentro da camada é erro, com a mesma mensagem de `validateConfig`.
 */
export function assertLayerSchema(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  assertExclusiveModel(raw.agent, "agent");
  const named = isPlainObject(raw.agents) ? raw.agents : {};
  for (const [name, agent] of Object.entries(named)) assertExclusiveModel(agent, `agents.${name}`);
  const models = Array.isArray(raw.models) ? raw.models : [];
  const seen = new Set<string>();
  for (const entry of models) {
    if (!isPlainObject(entry)) continue;
    const key = `${String(entry.provider)}/${String(entry.id)}`;
    if (seen.has(key)) throw new ConfigError(`config inválida: modelo duplicado "${key}" em "models"`);
    seen.add(key);
  }
}

/** Todo model declarado aponta para um provider declarado nas camadas. */
export function assertDeclaredProviders(declared: Record<string, unknown>): void {
  const providers = isPlainObject(declared.providers) ? declared.providers : {};
  const models = Array.isArray(declared.models) ? declared.models : [];
  for (const entry of models) {
    if (!isPlainObject(entry)) continue;
    const provider = String(entry.provider);
    if (!Object.hasOwn(providers, provider)) {
      throw new ConfigError(
        `config inválida: modelo "${provider}/${String(entry.id)}" aponta para o provider ` +
          `"${provider}", que não está declarado em "providers"`,
      );
    }
  }
}

/** `model` e `profile` na mesma camada: o schema proíbe os dois (ADR-0007). */
function assertExclusiveModel(agent: unknown, field: string): void {
  if (!isPlainObject(agent)) return;
  if (agent.model !== undefined && agent.profile !== undefined) {
    throw new ConfigError(
      `config inválida: "${field}" define "model" e "profile"; use apenas um — o profile substitui o model (ADR-0007)`,
    );
  }
}

/**
 * O projeto estreita a camada global, nunca amplia (ADR-0029): tools e perfil de
 * permissão ficam dentro do global, `permissions.mode` fica mais restrito, o
 * budget não passa do teto global e a credencial global não muda de endpoint.
 */
export function assertNarrowed(
  global: Record<string, unknown>,
  merged: Record<string, unknown>,
  storeProviders: Record<string, unknown> = {},
  projectLayer?: Record<string, unknown>,
): void {
  // Agent principal e agents nomeados: tools, perfil de permissão e teto de
  // passos (#473). O teto de passos é o valor global quando declarado, senão o
  // padrão embutido (BASELINE_MAX_STEPS): o projeto só reduz, nunca eleva.
  const main = isPlainObject(global.agent) ? global.agent : undefined;
  const mainAfter = isPlainObject(merged.agent) ? merged.agent : undefined;
  const mainCeiling = typeof main?.maxSteps === "number" ? main.maxSteps : BASELINE_MAX_STEPS;
  if (mainAfter !== undefined) assertStepsCeiling(mainAfter.maxSteps, "agent.maxSteps", mainCeiling);
  if (main !== undefined && mainAfter !== undefined) assertAgentNarrowed(main, mainAfter, "do agent principal");
  const named = isPlainObject(global.agents) ? global.agents : {};
  const namedAfter = isPlainObject(merged.agents) ? merged.agents : {};
  for (const [name, agent] of Object.entries(named)) {
    const after = namedAfter[name];
    if (isPlainObject(agent) && isPlainObject(after)) assertAgentNarrowed(agent, after, `do agent "${name}"`);
  }
  // Teto de passos dos nomeados cobre também os declarados só no projeto: sem
  // valor global do nomeado, vale o teto do agent principal (mainCeiling).
  for (const [name, after] of Object.entries(namedAfter)) {
    if (!isPlainObject(after)) continue;
    const globalAgent = isPlainObject(named[name]) ? named[name] : undefined;
    const ceiling = globalAgent !== undefined && typeof globalAgent.maxSteps === "number" ? globalAgent.maxSteps : mainCeiling;
    assertStepsCeiling(after.maxSteps, `agents.${name}.maxSteps`, ceiling);
  }
  // Teto de turnos (#473): `run.maxTurns` só capa `agent.maxSteps`, mas não pode
  // passar de um teto numérico declarado na camada global ("unlimited" alarga).
  const globalTurns = isPlainObject(global.run) ? global.run.maxTurns : undefined;
  const mergedTurns = isPlainObject(merged.run) ? merged.run.maxTurns : undefined;
  if (typeof globalTurns === "number"
    && (mergedTurns === "unlimited" || (typeof mergedTurns === "number" && mergedTurns > globalTurns))) {
    throw new ConfigError(
      `config inválida: o projeto amplia o teto global de turnos (run.maxTurns acima do teto ${globalTurns})`,
    );
  }
  // Modo de permissão do gate: o projeto só pode ser mais restrito.
  const globalMode = isPlainObject(global.permissions) ? global.permissions.mode : undefined;
  const mergedMode = isPlainObject(merged.permissions) ? merged.permissions.mode : undefined;
  assertNotWider(globalMode, mergedMode, MODE_RANK, "o modo de permissão global");
  // Escalada de effort é política do usuário: o projeto não liga o auto nem
  // sobe caps (nem para desligar, para não abrir caminho de widening).
  if (isPlainObject(projectLayer?.effort)) {
    throw new ConfigError('config inválida: o projeto não pode declarar "effort" (escalada automática é política global do usuário)');
  }
  // Budget: teto, janela e escopo não podem crescer.
  const globalBudget = isPlainObject(global.budget) ? global.budget : {};
  const mergedBudget = isPlainObject(merged.budget) ? merged.budget : {};
  assertCeiling(globalBudget.limitUsd, mergedBudget.limitUsd, "budget.limitUsd");
  assertCeiling(globalBudget.hardCeilingUsd, mergedBudget.hardCeilingUsd, "budget.hardCeilingUsd");
  const scopeFrom = SCOPE_RANK[String(globalBudget.scope)];
  const scopeTo = SCOPE_RANK[String(mergedBudget.scope)];
  if (scopeFrom !== undefined && scopeTo !== undefined && scopeTo > scopeFrom) {
    throw new ConfigError("config inválida: o projeto amplia o budget global (a janela do escopo não pode alargar)");
  }
  if (globalBudget.onExceed === "stop" && mergedBudget.onExceed === "ask") {
    throw new ConfigError("config inválida: o projeto amplia o budget global (onExceed: stop → ask)");
  }
  // Teto do time e das quotas: o custo efetivo não cresce com o budget intacto.
  const globalTeam = isPlainObject(global.team) ? global.team : {};
  const mergedTeam = isPlainObject(merged.team) ? merged.team : {};
  assertCeiling(globalTeam.projectBudgetUsd, mergedTeam.projectBudgetUsd, "team.projectBudgetUsd");
  assertQuotas(globalTeam.agentQuotas, mergedTeam.agentQuotas, "team.agentQuotas");
  assertQuotas(global.quota, merged.quota, "quota");
  // Provider: a credencial global não muda de endpoint (comparação pela referência: a URL canonicalizada com o `kind`).
  // A referência é reservada pela camada global (config global + store): o
  // projeto pode reusá-la no mesmo endpoint, nunca em outro. O perfil efêmero de
  // env não entra: ele é por execução e a escolha do usuário não é bloqueio.
  const endpoints = new Map<string, Set<string>>();
  // As fontes globais (config global + store) por id e por referência: a
  // reserva da credencial e a política de custo (domínio de quota) seguem a
  // credencial e o provider herdado.
  const globalById = new Map<string, GlobalSource[]>();
  const globalByRef = new Map<string, GlobalSource[]>();
  const globalProviders = isPlainObject(global.providers) ? global.providers : {};
  for (const [id, provider] of [...Object.entries(globalProviders), ...Object.entries(storeProviders)]) {
    if (!isPlainObject(provider)) continue;
    const source: GlobalSource = { id, provider };
    globalById.set(id, [...(globalById.get(id) ?? []), source]);
    const endpoint = endpointOf(provider);
    for (const key of CREDENTIAL_KEYS) {
      const ref = provider[key];
      if (typeof ref !== "string") continue;
      const mapKey = credentialKey(key, ref);
      const allowed = endpoints.get(mapKey) ?? new Set<string>();
      allowed.add(endpoint);
      endpoints.set(mapKey, allowed);
      globalByRef.set(mapKey, [...(globalByRef.get(mapKey) ?? []), source]);
    }
  }
  const mergedProviders = isPlainObject(merged.providers) ? merged.providers : {};
  for (const [id, provider] of Object.entries(mergedProviders)) {
    if (!isPlainObject(provider)) continue;
    const endpoint = endpointOf(provider);
    for (const key of CREDENTIAL_KEYS) {
      const ref = provider[key];
      if (typeof ref !== "string") continue;
      const allowed = endpoints.get(credentialKey(key, ref));
      if (allowed !== undefined && !allowed.has(endpoint)) {
        throw new ConfigError(`config inválida: o projeto redireciona a credencial global do provider "${id}" (a mesma referência já está declarada em outro endpoint)`);
      }
    }
  }
  // Domínio de quota: o que o PROJETO declara é política do projeto; o que a
  // camada global (ou o store) declara é do usuário. Duas fontes globais que
  // discordam entre si não são erro do projeto.
  const projectProviders = isPlainObject(projectLayer?.providers) ? projectLayer.providers : {};
  for (const [id, provider] of Object.entries(projectProviders)) {
    if (!isPlainObject(provider)) continue;
    const effective = mergedProviders[id];
    if (!isPlainObject(effective)) continue;
    // De onde o provider herda a política global: pelo id e pela referência.
    const sources = [...(globalById.get(id) ?? [])];
    for (const key of CREDENTIAL_KEYS) {
      const ref = provider[key];
      if (typeof ref !== "string") continue;
      for (const source of globalByRef.get(credentialKey(key, ref)) ?? []) {
        if (source.id === id) continue; // o mesmo provider, não outra conta
        sources.push(source);
      }
    }
    assertQuotaDomain(id, effective, sources, global.quota);
  }
}

/** Uma fonte global (config global ou store) de um provider. */
interface GlobalSource {
  id: string;
  provider: Record<string, unknown>;
}

/** Tools e perfil de permissão de um agent: só o que o global permite. */
function assertAgentNarrowed(globalAgent: Record<string, unknown>, mergedAgent: Record<string, unknown>, label: string): void {
  const allowed = globalAgent.tools;
  const declared = mergedAgent.tools;
  if (Array.isArray(allowed) && Array.isArray(declared)) {
    const extra = declared.filter((tool) => !allowed.map(String).includes(String(tool)));
    if (extra.length > 0) throw new ConfigError(`config inválida: o projeto amplia a allowlist global ${label} (${extra.join(", ")})`);
  }
  assertNotWider(globalAgent.permission, mergedAgent.permission, PERMISSION_RANK, `a permissão global ${label}`);
}

/** Teto de passos (#473): o valor mesclado não pode passar do teto (global ou padrão embutido). */
function assertStepsCeiling(steps: unknown, field: string, ceiling: number): void {
  if (typeof steps === "number" && steps > ceiling) {
    throw new ConfigError(
      `config inválida: o projeto amplia o teto global de passos (${field}: ${steps} acima do teto ${ceiling})`,
    );
  }
}

/** Rejeita quando o projeto é mais permissivo que o global. */
function assertNotWider(globalValue: unknown, mergedValue: unknown, table: Record<string, number>, label: string): void {
  const from = typeof globalValue === "string" ? table[globalValue] : undefined;
  const to = typeof mergedValue === "string" ? table[mergedValue] : undefined;
  if (from !== undefined && to !== undefined && to > from) {
    throw new ConfigError(`config inválida: o projeto amplia ${label} ("${String(globalValue)}" → "${String(mergedValue)}")`);
  }
}

/** Teto numérico: o projeto não passa do valor global. */
function assertCeiling(globalValue: unknown, mergedValue: unknown, label: string): void {
  if (typeof globalValue !== "number") return;
  if (typeof mergedValue !== "number" || mergedValue > globalValue) {
    throw new ConfigError(`config inválida: o projeto amplia o budget global (${label} acima do teto global)`);
  }
}

/** Quotas por agent (`team.agentQuotas`) e por domínio (`quota`): teto por chave. */
function assertQuotas(globalValue: unknown, mergedValue: unknown, label: string): void {
  if (!isPlainObject(globalValue)) return;
  const merged = isPlainObject(mergedValue) ? mergedValue : {};
  for (const [key, limit] of Object.entries(globalValue)) {
    if (!isPlainObject(limit)) continue;
    const after = isPlainObject(merged[key]) ? merged[key] : {};
    for (const field of ["dailyTokens", "monthlyCostUsd"]) {
      assertCeiling(limit[field], after[field], `${label}.${key}.${field}`);
    }
  }
}

/** Domínio de quota do provider (o runtime usa `quotaDomain ?? "default"`). */
function quotaDomainOf(provider: Record<string, unknown>): string {
  return typeof provider.quotaDomain === "string" ? provider.quotaDomain : "default";
}

/**
 * Quota: o domínio de quota do provider é parte da política global de custo. O
 * projeto não tira um provider que herda a política global (mesmo id OU reuso
 * da referência global) de um domínio com teto: escaparia do teto global — um
 * domínio sem limite declarado passa no enforcement, que corta por domínio —
 * e a troca fragmentaria o contador da conta em dois domínios.
 *
 * O destino precisa ter teto declarado na camada global. O teto do próprio
 * projeto não conta: um limite que o projeto declara pode ser maior que o
 * global, e o domínio é política da camada global.
 */
function assertQuotaDomain(
  id: string,
  provider: Record<string, unknown>,
  sources: GlobalSource[],
  globalQuota: unknown,
): void {
  // O tipo do campo é do schema: com um valor que não é string (ou vazio), o
  // schema fala.
  if (provider.quotaDomain !== undefined
    && (typeof provider.quotaDomain !== "string" || provider.quotaDomain.length === 0)) return;
  const limits = isPlainObject(globalQuota) ? globalQuota : {};
  const domain = quotaDomainOf(provider);
  const sourceDomains = sources
    .filter((source) => source.provider.quotaDomain === undefined
      || (typeof source.provider.quotaDomain === "string" && source.provider.quotaDomain.length > 0))
    .map((source) => quotaDomainOf(source.provider));
  // Sem teto global no domínio de origem, não há o que escapar.
  const ceilingDomains = [...new Set(sourceDomains.filter((source) => isPlainObject(limits[source])))];
  if (ceilingDomains.length === 0) return;
  // O destino tem teto declarado na camada global (o enforcement corta por
  // domínio: um destino sem teto passaria sem limite).
  if (isPlainObject(limits[domain])) return;
  throw new ConfigError(
    `config inválida: o projeto amplia o budget global (o domínio de quota do provider "${id}" ` +
      `não pode mudar para "${domain}": o teto global está em "${ceilingDomains.join('", "')}")`,
  );
}

/** Chave de comparação da referência: o caminho de credenciais é normalizado. */
function credentialKey(key: string, ref: string): string {
  if (key === "credentialsPath") return `${key}=${normalizePath(ref)}`;
  // O nome de variável de ambiente é comparado sem diferenciar maiúsculas: o
  // ambiente do Windows não diferencia e a mesma variável não pode virar duas
  // credenciais. A ref do cofre é exata (o id do cofre diferencia maiúsculas).
  return `${key}=${isVaultRef(ref) ? ref : ref.toUpperCase()}`;
}

/** Endpoint do provider: URL canonicalizada e tipo — a credencial não troca de endpoint. */
function endpointOf(provider: Record<string, unknown>): string {
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : String(provider.baseUrl);
  return `${canonicalUrl(baseUrl)}|${String(provider.kind)}`;
}

/** A mesma URL em outra grafia é o mesmo endpoint. */
function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** Normaliza como o runtime: `~` vira o home e o `..` é resolvido. */
function normalizePath(path: string): string {
  const expanded = path === "~"
    ? homedir()
    : path.startsWith("~/") || path.startsWith("~\\")
      ? join(homedir(), path.slice(2))
      : path;
  const resolved = resolve(expanded);
  // Mesmo arquivo com outro nome: link (symlink/junction) e a caixa do Windows.
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // O arquivo pode não existir (ou o link não resolve): sem arquivo não há
    // credencial para ler, e a comparação lexical ainda separa as grafias.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
