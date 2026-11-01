# Frente A — catálogo de modelos: spec de execução

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** tornar modelo uma entidade listável, com catálogo efetivo derivado de config, perfis globais e env, sem ler valor de credencial.

**Architecture:** `PROVIDER_CATALOG` deixa de ter OpenAI e Ollama e passa a ter quatro sementes (NVIDIA, Codex, OpenRouter, template OpenAI-compatible). Um módulo novo, `src/model-catalog.ts`, deriva `CatalogModel[]` de `EffectiveConfig` e reaproveita `providerIdentityFor` para atribuir origem. O picker agrupa por provider e o CLI ganha `astro models list`.

**Tech Stack:** Bun, TypeScript strict, Ink/React (TUI sob demanda), `bun:test`, `ink-testing-library` (devDependency existente).

**Spec:** decisão da frente A do planejamento de 2026-11-01; ADR-0007 (pool), ADR-0011 (escolha), `docs/providers.md`.

## Global Constraints

- Zero dependência de runtime nova (D-02); `ink-testing-library` já está em `package.json:42`.
- Toda mudança de comportamento começa com teste que falha (RED); `bun test` e `bun run typecheck` verdes antes do PR; o RED vai para o PR.
- Nenhum valor de credencial é lido, ecoado ou persistido (I-03); só nome de variável.
- PR alvo de 200 linhas, teto 400; commits `tipo: resumo` com rodapé `Refs #n`. Docs em português; identificadores de código em inglês.

## Review Focus

- Mesmo `provider/id` em projeto e perfil global: projeto vence e aparece uma linha só.
- Prefixo de provider (`openai` vs `openai-work`): identidade é par exato, nunca prefixo.
- Catálogo vazio: mensagem clara e exit 0, sem crash.
- Modelo `disabled`: listado com status, nunca escondido.
- Env com sentinela: valor não aparece em texto nem em JSON.

## File Structure

- `src/provider/catalog.ts` — sementes do wizard.
- `src/model-catalog.ts` (novo) — entidade, derivação e formatação.
- `src/cli.ts` — comando `astro models list`.
- `src/tui/models.ts` e `src/tui/model-picker.tsx` — agrupamento e render por provider.
- Tests: `provider-catalog`, `provider-wizard`, `model-catalog` (novo), `models-cli` (novo), `tui-models` (novo), `model-picker` (novo), `cli-help`.

## Task 1: sementes do catálogo

**Files:**
- Modify: `src/provider/catalog.ts:16-64`
- Test: `tests/provider-catalog.test.ts`, `tests/provider-wizard.test.ts`

**Interfaces:**
- Produces: `PROVIDER_CATALOG` com chaves exatas `["nvidia", "codex", "openrouter", "openai-compatible"]`; `openai-compatible` sem `baseUrl`, sem `credentialRef` e com `models: []`.

- [ ] **Step 1: escrever o teste que falha**

```ts
test("catálogo tem as quatro entradas esperadas", () => {
  expect(PROVIDER_CATALOG.map((e) => e.key)).toEqual(["nvidia", "codex", "openrouter", "openai-compatible"]);
});
test("template openai-compatible não fixa endpoint nem chave", () => {
  const entry = catalogEntry("openai-compatible");
  expect(entry?.baseUrl).toBeUndefined();
  expect(entry?.credentialRef).toBeUndefined();
  expect(entry?.models).toEqual([]);
});
```

- [ ] **Step 2: rodar e ver falhar** — `bun test tests/provider-catalog.test.ts` → FAIL na lista de chaves.
- [ ] **Step 3: implementar** — remover `openai` e `ollama`; manter `nvidia`, `codex`, `openrouter`; adicionar `openai-compatible` com `quotaDomain: "openai-compatible"`. No teste de perfil válido, iterar só entradas com `models.length > 0`. No wizard, trocar o caso `openai` por `nvidia` (`fakeIO(["nvidia", "NVIDIA Work", "", "", "", "S", "S"])`, baseUrl `https://integrate.api.nvidia.com/v1`, quotaDomain `nvidia`).
- [ ] **Step 4: rodar e ver passar** — `bun test tests/provider-catalog.test.ts tests/provider-wizard.test.ts` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat: seed model catalog with initial providers"`.

## Task 2: entidade do modelo

**Files:**
- Create: `src/model-catalog.ts`
- Test: `tests/model-catalog.test.ts`

**Interfaces:**
- Consumes: `EffectiveConfig`, `providerIdentityFor` (`src/provider/profiles.ts:259-277`), `ModelConfig`/`ModelStatus`/`PriceConfig` (`src/config.ts:57-79`).
- Produces: `CatalogModel { ref, provider, id, tags, context, status, source, price? }`; `buildModelCatalog(effective): CatalogModel[]`; `formatModelCatalog(models): string`.

- [ ] **Step 1: escrever os testes que falham** — `tests/model-catalog.test.ts` com config de projeto, store global e `envProfile`, cobrindo:

```ts
test("origem project/global/env", ...);            // proj/p1 → "project"; glob/g1 → "global"; env/e1 → "env"
test("projeto vence global na mesma ref", ...);    // uma linha, source "project", context do projeto
test("identidade é par exato, não prefixo", ...);  // openai-work/x não colide com openai/x
test("disabled aparece com status", ...);
test("formatação não ecoa valor de ambiente", ...); // env KEY="sentinel-xyz"; output sem "sentinel-xyz"
```

- [ ] **Step 2: rodar e ver falhar** — `bun test tests/model-catalog.test.ts` → FAIL por módulo ausente.
- [ ] **Step 3: implementar** — `ref = `${provider}/${id}``; `source = providerIdentityFor(effective, provider).providerSource`; `status = model.status ?? "active"`; `price = config.pricing?.[ref] ?? model.price`; dedup com `Map` como guarda (a lista de `config.models` já vem deduplicada por `mergeModels`, com projeto vencendo); ordenar por `provider` e `id` com comparação exata de string. `formatModelCatalog` devolve `"nenhum modelo"` para lista vazia e uma linha por modelo: `ref · source · status · tags · contexto · preço`.
- [ ] **Step 4: rodar e ver passar** — `bun test tests/model-catalog.test.ts` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat: derive model catalog from effective config"`.

## Task 3: comando `astro models list`

**Files:**
- Modify: `src/cli.ts` (USAGE ~93, `ParsedCommand` ~231, `parseArgs` ~278, dispatch)
- Modify: `src/model-catalog.ts` (`formatSeedList`)
- Test: `tests/models-cli.test.ts` (novo), `tests/cli-help.test.ts`

**Interfaces:**
- Consumes: `buildModelCatalog`, `formatModelCatalog`, `formatSeedList`, `loadEffectiveConfig`.
- Produces: `astro models list [--config <path>] [--seeds] [--json]`.

- [ ] **Step 1: escrever os testes que falham**

```ts
test("models list imprime modelos e não ecoa segredo", async () => {
  // config temporário com provider proj e credentialRef SENTINEL_KEY
  // Bun.spawn([process.execPath, entry, "models", "list", "--config", tmp], { env })
  expect(out).toContain("proj/p1");
  expect(out).not.toContain("sentinel-xyz");
});
test("models list --seeds lista as quatro sementes", ...);
```

Em `tests/cli-help.test.ts`, adicionar `expect(out).toContain("astro models")`.

- [ ] **Step 2: rodar e ver falhar** — `bun test tests/models-cli.test.ts tests/cli-help.test.ts` → FAIL.
- [ ] **Step 3: implementar** — adicionar comando ao USAGE e ao union; `--seeds` acrescenta `formatSeedList(PROVIDER_CATALOG)`; `--json` imprime `JSON.stringify(models, null, 2)`; lista vazia imprime `formatModelCatalog([])` e retorna 0.
- [ ] **Step 4: rodar e ver passar** — mesmos testes → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat: add astro models list"`.

## Task 4: agrupamento no picker

**Files:**
- Modify: `src/tui/models.ts`, `src/tui/model-picker.tsx:71-82`
- Test: `tests/tui-models.test.ts` (novo), `tests/model-picker.test.tsx` (novo)

**Interfaces:**
- Produces: `ModelGroup { provider, models }`; `groupModels(models): ModelGroup[]` (providers ordenados, ordem interna preservada).
- Consumes: `ModelOption`, `filterModels`, `orderModels`.

- [ ] **Step 1: escrever os testes que falham** — `groupModels` com dois providers e ordem interna; lista vazia → `[]`; render com `ink-testing-library` mostrando `nvidia · 1` como cabeçalho.
- [ ] **Step 2: rodar e ver falhar** — `bun test tests/tui-models.test.ts tests/model-picker.test.tsx` → FAIL.
- [ ] **Step 3: implementar** — agrupar por `provider`, ordenar cabeçalhos, renderizar `<Text bold>{provider} · {n}</Text>` antes do grupo mantendo o índice de seleção por `ref`. Coordenar com T2 (#63) para não conflitar em `model-picker.tsx`.
- [ ] **Step 4: rodar e ver passar** — `bun test tests/tui-models.test.ts tests/model-picker.test.tsx tests/tui-last-model.test.ts` → PASS.
- [ ] **Step 5: commit** — `git commit -m "feat: group model picker by provider"`.

## Task 5: documentação

**Files:**
- Modify: `docs/providers.md` (tabela de seeds e comandos), `docs/INDEX.md` (linha de `docs/superpowers/plans/`)

- [ ] **Step 1: atualizar** — tabela de seeds com NVIDIA, Codex, OpenRouter e OpenAI-compatible; remover OpenAI/Ollama; documentar `astro models list [--seeds] [--json]`; registrar que a descoberta `GET /models` é entrega separada.
- [ ] **Step 2: verificar** — `bun test tests/cli-help.test.ts` → PASS.
- [ ] **Step 3: commit** — `git commit -m "docs: document model catalog seeds and command"`.

## Critério de pronto

- `astro models list` lista modelos de projeto, perfil global e env, com origem, sem ler credencial.
- `astro models list --seeds` lista exatamente as quatro sementes; OpenAI e Ollama não aparecem como seed.
- Picker agrupa por provider e mantém filtro, favoritos, recentes e seleção.
- `bun test` e `bun run typecheck` verdes; `tests/model-choice*.test.ts` inalterados e verdes.
- Nenhum valor de credencial em stdout, JSON, log ou erro (teste com sentinela); descoberta `GET /models`, cofre (frente B) e design system (frente C) fora deste spec.
