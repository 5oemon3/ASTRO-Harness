# Guia de implementação para agentes (LLM)

> Objetivo: uma sessão nova implementa uma issue do zero ao merge sem pedir instruções; cobre TDD, fluxo, revisão dupla e padrões de código.

| Cobre | Não cobre |
|---|---|
| Como implementar uma issue `#n` ponta a ponta: branch, TDD, PR, revisão dupla, merge | Decisões arquiteturais (em `docs/decisions.md` e `docs/adr/`) e invariantes (em `docs/invariants.md`) |

Leia na ordem: `AGENTS.md` → este guia → `docs/workflow.md` (detalhe) → `docs/review-checklist.md` (se for revisar).

## 1. Antes de começar

| Passo | Comando/ação | Regra |
|-------|--------------|-------|
| 1. Issue | `gh issue view n --repo UmTioAii/ASTRO-Harness` | Toda mudança tem issue com critério de aceite testável. Se não houver, crie antes. |
| 2. Estado local | `bun install --frozen-lockfile && bun test && bun run typecheck` | Base verde antes de tocar em qualquer coisa. |
| 3. Worktree | `git worktree add .worktrees/<tipo>-<n>-<slug> -b <tipo>/<n>-<slug> origin/main` | Nunca commite direto na `main`. Uma branch por issue. |
| 4. Docs base | ler `docs/INDEX.md`, abrir só o doc que a issue cita | Não ler `docs/` inteiro. |

## 2. TDD obrigatório (toda mudança de comportamento)

| Ordem | Commit | O que fazer |
|-------|--------|-------------|
| 1 | `test: ...` (RED) | Escrever o teste que falha. Rodar: `bun test <arquivo>` → **FAIL esperado**. Commitar só o teste. |
| 2 | `feat: ...` ou `fix: ...` (GREEN) | Implementar o mínimo para passar. Rodar: `bun test` → **PASS** + `bun run typecheck` → sem erros. Commitar. |
| 3 | PR | O RED vai na descrição do PR (seção "Como foi testado (TDD)" do template). |

Regras:
- RED e GREEN em **commits separados** (`test:` antes de `feat:`/`fix:`).
- Se a mudança é só doc/config sem comportamento, RED não se aplica; justificar no corpo do PR.
- `bun test` e `bun run typecheck` verdes **antes** de marcar o PR como ready.

## 3. Commits

| Regra | Exemplo |
|-------|---------|
| Formato `tipo: resumo` (imperativo, ≤72 chars, inglês) | `feat: scope permission grants to once or session` |
| Rodapé obrigatório `Refs #n` | `Refs #305` |
| Tipos: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci` | — |
| Nunca commitar `.env*`, `astro.config.json` real, `.astro/`, credenciais, saída de teste com segredo | — |
| Sem menção a ferramenta/sessão no commit/PR (regra do `AGENTS.md`) | — |

## 4. PR

| Passo | Ação |
|-------|------|
| Abrir como **draft** | `gh pr create --draft --fill` usando o template `.github/pull_request_template.md` |
| Corpo | `Closes #n` no fim; seção TDD com RED/GREEN; invariantes tocados (`I-xx`); checklist marcado |
| Tamanho | alvo ≤200 linhas alteradas, teto 400. Acima: dividir em PRs encadeados |
| Ready | só com CI verde (`test` nos 2 SOs + `eval` + `secrets`) e checklist preenchido |

## 5. Revisão dupla obrigatória (2 agentes em paralelo, contexto fresco)

Nenhum PR entra na `main` sem **dois** vereditos no próprio PR.

| Revisor | Lente | Foco | Bloqueia? |
|---------|-------|------|-----------|
| **A — Segurança** | `risco:seguranca` | I-03 (segredo em qualquer lugar), I-01 (bypass de allowlist), I-11 (escape de caminho/symlink/sandbox), vazamento em log/audit/ledger/erro/prompt | **Sempre** |
| **B — Correctness** | contrato e testes | critérios de aceite da issue, tipos, edge cases (timeout, retry, arquivo grande, `costUsd: null`), docs atualizados, diff ≤400 linhas | Sim, se achado bloqueante |

Formato do veredito (primeira linha do comentário no PR):

```
Revisão: APPROVE
1. [sugestão] src/foo.ts:42 — ...
```

ou

```
Revisão: REQUEST_CHANGES
1. [bloqueante] src/tools/run-command.ts:42 — `env` herda `process.env`; cenário: modelo chama `cat ~/.codex/auth.json`. Correção: env sanitizado.
2. [sugestão] tests/session.test.ts — falta caso maxSteps = 0.
```

Regras:
- Revisor recebe **só o diff + checklist + issue**, não o raciocínio do autor.
- Achado bloqueante exige `arquivo:linha` + cenário concreto de falha. Sem isso, é sugestão.
- Achado de segurança **sempre bloqueia**, mesmo sem cenário.
- Após correção, a nova revisão cobre **só o commit novo**.

## 6. Merge

| Pré-condição | Verificação |
|--------------|-------------|
| CI verde | `test` (Linux + Windows), `eval`, `secrets` |
| 2 aprovações | `Revisão: APPROVE` dos dois revisores no PR |
| Docs | docs afetados no mesmo PR; arquivo novo em `docs/` entra no `docs/INDEX.md` |
| Merge | **squash merge** apenas. Branch apagada automaticamente. `main` nunca recebe commit direto. |

## 7. Padrões de código (TypeScript + Bun)

| Regra | Exemplo |
|-------|---------|
| TypeScript strict; `bun run typecheck` sem erros | `tsconfig.json` strict |
| Zero dependências de runtime (D-02); exceção só com ADR | `import ... from "node:fs"` |
| Identificadores em inglês; mensagens de erro ao usuário em pt-BR | `resolveWithin(cwd, path)` |
| Testes espelham `src/` em `tests/` | `src/tools/paths.ts` → `tests/tools.test.ts` |
| Erro classificado, nunca `Error` genérico | `throw new ProviderError("outage", ...)` (D-18) |
| Segredo só via `credentialRef`/cofre; nunca em código, teste, log (I-03) | `env[cfg.credentialRef]` |
| Caminho de arquivo confinado ao `cwd` (I-11) | `resolveWithin(cwd, p)` em toda tool de FS |
| Tool fora da allowlist não executa (I-01) | `ToolExecutor` valida `allow` |
| Toda escrita de arquivo gera evento de auditoria sanitizado (I-16) | `auditor.append({ tipo: "tool.call", ... })` |
| Mudou comportamento → atualiza doc afetado no mesmo PR | `docs/providers.md` |

## 8. Checklist rápido antes de abrir o PR

- [ ] Issue `#n` existe e tem critério de aceite testável
- [ ] Branch `<tipo>/<n>-<slug>` criada em worktree a partir de `main` atualizada
- [ ] RED commitado antes do GREEN (`test:` antes de `feat:`/`fix:`)
- [ ] `bun test` verde · `bun run typecheck` verde
- [ ] PR com `Closes #n`, RED no corpo, invariantes listados
- [ ] Diff ≤400 linhas (alvo 200)
- [ ] 2 revisores solicitados (A segurança, B correctness) em contexto fresco
- [ ] Docs atualizados; novo doc em `docs/` está no `INDEX.md`

## 9. O que NÃO fazer

| Não | Por quê |
|-----|---------|
| Commit direto na `main` | branch protection; squash merge only (D-16) |
| PR sem issue | rastreabilidade; estado vive em issues/milestones |
| GREEN sem RED | quebra a evidência TDD |
| Um revisor só | regra do projeto: 2 lentes (segurança + correctness) |
| Segredo no diff/teste/log | I-03; gitleaks no CI bloqueia |
| Dependência de runtime nova sem ADR | D-02 |
| Arquivo de estado de projeto (`progress.md`) | estado vive em issues e milestones |
| Ler `docs/` inteiro | custo de tokens; use `docs/INDEX.md` |
