# ADR-0024: effort — duas escalas, trava de salto e baseline

- Status: aceita
- Data: 2026-11-05
- Issue: #378
- Decisões relacionadas: ADR-0012, ADR-0023, I-01, I-03, I-17

## Contexto

O ADR-0012 fixa `lvl` 0–4 e o map por provider; o plano v3.0 precisa de uma escala de exibição, máximos por modelo (3/4/5), trava de salto, baseline imutável e herança de subagente. O texto de reasoning continua fora do ledger (I-03) e o modelo continua sem escolher o próprio esforço (I-01). Este ADR amenda E4 do ADR-0012 (salto automático) e estende a escala para `0..N`; thinking/forbidden/`param.stripped` permanecem.

## Decisão

**Duas escalas.** A exibição usa `low|medium|high|max|ultra|ultra+`; a API/ledger usa `lvl` 0..N. Mapa: low=0, medium=1, high=2, max=3, ultra=4, ultra+=5 (só N=5). `models[].call.effort.max` declara N (3, 4 ou 5); o map cobre 0..N; o TUI mostra só os labels disponíveis.

**Baseline.** `sessionBaseline` = effort aprovado no início (`/effort`, `ASTRO_EFFORT` ou default do config); imutável durante a sessão; o `usage` grava o `lvl` inicial e cada `effort.jump` repete o baseline. Pai herda o baseline; não define o do subagente.

**Trava de salto.** `effort.autoJumpMax` (default 1, máximo 2): delta ≤ +autoJumpMax é automático; acima pede aprovação; descer é sempre livre. `effort.maxCumulativeJump` (default 3): teto `sessionBaseline + maxCumulativeJump`; acima disso, qualquer salto pede aprovação (anti-staircase). A aprovação é humana (D-25), nunca tool model-facing.

**Subagente.** O subagente nunca excede `min(parent.current, model.max, sessionBaseline + maxCumulativeJump)`; o pai aprova até o nível corrente do pai; o usuário aprova o pai acima do baseline. O baseline do subagente é o herdado do pai, não um novo.

**Billing.** O check de budget roda antes do salto, com estimativa conservadora; salto que estoura `limitUsd`/`hardCeilingUsd` é negado independentemente da permissão de effort. O audit `effort.jump` registra `{current, target, delta, permission, reason, estimate, billingCheck, sessionId, agentId, baseline, cumulative}`; o ledger `usage` segue com `lvl`/`effort`/`thinking` (ADR-0012).

**Limites.** Effort não troca modelo/provider/credencial (I-08/ADR-0009); thinking/forbidden continuam no ADR-0012. O modelo nunca recebe um canal para escolher `lvl` (I-01).

## Consequências

- Ganho: escala previsível, saltos auditáveis e custo controlado antes da chamada.
- Custo: `call.effort.max` + `effort.*` no config; `effort.jump` no audit; TUI mostra labels.
- Invariantes afetadas: I-01 (modelo não escolhe), I-03 (reasoning não persiste), I-17 (billing antes do salto).

## Alternativas descartadas

- Uma escala só (labels no ledger): mistura UI e contrato; o ledger mantém `lvl`.
- Salto livre: ignora custo e anti-staircase.
- Modelo escolher effort: viola I-01.
- Baseline recalculado por turno: perde a referência de sessão/replay.
