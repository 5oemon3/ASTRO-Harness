# ADR-0024: effort — duas escalas, trava de salto e baseline

- Status: aceita
- Data: 2026-11-05
- Issue: #378
- Decisões relacionadas: ADR-0012, ADR-0023, I-01, I-03, I-17

## Contexto

O ADR-0012 fixa `lvl` 0–4 e o map por provider; o plano v3.0 pedia escala de exibição, máximos por modelo (3/4/5), trava de salto, baseline imutável e herança de subagente. Esta fatia implementa a escala 0..4 (N=5 fica futura), a trava e a herança; o texto de reasoning continua fora do ledger (I-03) e o modelo continua sem escolher o próprio esforço (I-01). O ADR amenda E4 do ADR-0012 (salto automático); thinking/forbidden/`param.stripped` permanecem.

## Decisão

**Duas escalas.** A exibição usa `low|medium|high|max|ultra`; a API/ledger usa `lvl` 0..4. Mapa: low=0, medium=1, high=2, max=3, ultra=4. `models[].call.effort` declara só `param` e `map` (0..4); `call.effort.max` e `ultra+` (N=5) ficam para uma fatia futura. O TUI mostra só os labels disponíveis.

**Baseline.** `sessionBaseline` = effort aprovado no início (`/effort`, `ASTRO_EFFORT` ou default do config); imutável durante a sessão; o `usage` grava o `lvl` inicial e cada `effort.jump` repete o baseline. Pai herda o baseline; não define o do subagente.

**Trava de salto.** `effort.auto` (default `false`) liga a escalada automática no sinal de não-progresso do loop guard (L6); desligada, o run nunca sobe sozinho. `effort.autoJumpMax` (default 1, máximo 2): delta máximo de cada decisão; `effort.maxCumulativeJump` (default 3, faixa 0..4): teto acumulado acima do `sessionBaseline`. Salto acima do teto `lvl` 4, do `autoJumpMax` ou do acumulado é negado e cai na pausa normal de não-progresso; a negação marca o segmento, então o mesmo segmento não tenta de novo (sem loop apertado). Descer continua livre e a aprovação humana (D-25) segue para o que não é automático, nunca tool model-facing.

**Subagente.** O subagente herda `effort.*` do pai, mas mantém lock e caps próprios: baseline, corrente e acumulado são por agente (chave run+agente), e um salto de um agente nunca muda o nível de outro. Não há aprovação de salto nesta fatia: negado o salto, o decider de não-progresso decide continuar ou parar.

**Billing.** O budget continua checado antes de cada chamada (I-17); o salto em si não reserva custo novo. O ledger `effort.jump` registra `{from,to,delta,baseline,cumulative,allowed,reason,segment}` por run+agente, sem prompt (I-03); `segment` é só o hash do loop guard. O audit segue com os eventos do run (`loop.no_progress`) e o `usage` com `lvl`/`effort`/`thinking` (ADR-0012).

**Limites.** Effort não troca modelo/provider/credencial (I-08/ADR-0009); thinking/forbidden continuam no ADR-0012. O modelo nunca recebe um canal para escolher `lvl` (I-01).

## Consequências

- Ganho: escala previsível, saltos auditáveis e custo controlado antes da chamada.
- Custo: `effort.auto`/`autoJumpMax`/`maxCumulativeJump` no config; `effort.jump` no ledger; TUI mostra labels.
- Invariantes afetadas: I-01 (modelo não escolhe), I-03 (reasoning não persiste), I-17 (billing antes do salto).

## Alternativas descartadas

- Uma escala só (labels no ledger): mistura UI e contrato; o ledger mantém `lvl`.
- Salto livre: ignora custo e anti-staircase.
- Modelo escolher effort: viola I-01.
- Baseline recalculado por turno: perde a referência de sessão/replay.
