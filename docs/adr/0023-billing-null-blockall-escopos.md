# ADR-0023: billing v4 — null, blockAll, escopos e cache

- Status: aceita
- Data: 2026-11-05
- Issue: #368
- Decisões relacionadas: D-10, D-15, D-20, ADR-0002, ADR-0013, ADR-0014, #372

## Contexto

O ADR-0013 fixa `day|month|project|use-as-you-go`; `project` é o mês corrente alinhado a `team.projectBudgetUsd`, `null` só vale em `use-as-you-go` e `0` bloqueia tudo sem nome próprio. O plano v4 precisa de `null` explícito em qualquer escopo, `blockAll`, `weekly`, `perSession` e `perAgent`, com o gasto sempre derivado do ledger e sem segundo contador.

## Decisão

**Config.** `budget {scope, limitUsd, warnAt: 0.8, onExceed: "ask", hardCeilingUsd?, blockAll?, allowDowngrade?}`. `limitUsd: null` em qualquer escopo = sem teto. `0` é inválido (`use null for no limit, or blockAll: true`). `blockAll: true` exige `limitUsd: null`, vence os demais campos e rejeita `hardCeilingUsd` (`block_all_with_ceiling`). `allowDowngrade` default `false`.

**Escopos.** Um `scope` ativo por budget (forma atual; limites simultâneos ficam para v5): `day`/`month` em UTC; `weekly` começa segunda 00:00 UTC; `project` é o ledger do cwd, sem reset; `perSession` é a chat session; `perAgent` é o agente e reinicia na troca; `use-as-you-go` é alias legado de `limitUsd: null` (aviso em v4, remoção em v5); `total` adiado.

**Ledger e session_id.** `LEDGER_SCHEMA_VERSION` 3→4 adiciona `session_id` a `usage` e `budget`. `session_id` é o id da chat session (`AgentSession.id`); run one-shot grava `null`. Entradas pré-v4 têm `session_id: null` e não contam para `perSession`; a janela de uma sessão retomada começa no upgrade, com aviso.

**Projeto e time.** `project` não usa mais `team.projectBudgetUsd`; `team.projectBudgetUsd` continua mensal e vira `team.monthlyBudgetUsd` (alias com aviso em v4, remoção em v5). `astro config migrate` reescreve o `project` antigo para `month` + `monthlyBudgetUsd` para preservar o comportamento; quem quiser o ledger do cwd adota `project` depois. `0` migra para `blockAll: true`; `use-as-you-go` migra para `project` + `limitUsd: null`.

**Enforcement.** Verificação antes da chamada com `input + max_output`; reconciliação no ledger após a resposta; discrepância >20% gera nota. Subagente herda `min(parent.effective, child.declared)`. `outstandingReservations` conta sem filtro de sessão (B9, crash recovery). Cache de query = último `seq` do ledger; leitura stale invalida e re-consulta. Elevação de teto em runtime é #372 (D-30), aditiva a este ADR.

**Versão.** O config usa `version` semver (não `schemaVersion` inteiro); a migração/deprecação é do ADR de config/semver (a abrir), uma major por vez.

## Consequências

- Ganho: semântica explícita para ausente/esgotado, escopos de sessão/agente/semana e um único contador (ledger).
- Custo: config v4 + ledger 3→4 (`session_id`); `AgentSession`/`runTask` passam `sessionId`; migração de `project`/`0`/`use-as-you-go`.
- Invariantes afetadas: I-17 (corte físico), I-19 (checkpoint/stop), I-03 (eventos sanitizados).

## Alternativas descartadas

- Manter `0` como block-all: ambíguo com orçamento zero; `blockAll` nomeia a intenção.
- `blockAll` como escopo: mistura controle com janela; booleano separado.
- `perSession` = run: run é ciclo interno; a chat session atravessa runs.
- `project` = month/team: confunde lifetime do cwd com orçamento mensal do time.
- Segundo contador: duplicaria quota/team com duas verdades.
- `config.schemaVersion` inteiro: o config já usa semver; o ledger mantém inteiro.
