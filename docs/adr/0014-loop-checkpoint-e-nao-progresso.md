# ADR-0014: loop de segmento com checkpoint e guarda de não-progresso

- Status: aceita
- Data: 2026-10-28
- Issue: #120
- Decisões relacionadas: D-12, ADR-0010, ADR-0013

## Contexto

`maxSteps` existe (`src/session.ts`); F-06 (S-10) dá cancelamento e F-22 (S-14) resume determinístico. Falta o loop de segmento com presets, checkpoint e guarda de não-progresso (L1–L7) para runs longos sob budget.

## Decisão

**Presets (L1).** Config `run {maxTurns: 100 | 500 | "unlimited", checkpointAt: 0.8, noProgressSegments: 3, judge: "off"}`; `"unlimited"` segue a exigência de teto de ADR-0013 (L2, Q-01).

**Turno (L3).** Um turno = uma chamada de modelo + as tool calls que ela pede; completion sem tool calls encerra o loop (semântica atual de `maxSteps` preservada).

**Checkpoint (L5).** A 80% do limite de turnos OU do gasto do escopo do budget (D-27), grava `{summary, changed files, next step}` sanitizado (I-03) no store do ADR-0010 (PS-2). Bater o limite para em estado seguro (I-19, via S-10); retomar o run pelo ledger é replay determinístico com `astro resume <run> --task <...>`; retomar do checkpoint é `astro continue <run> [--task] [--agent]` (run novo, D-27), com os limites da config (S-14; `run.maxTurns` só capa `agent.maxSteps`). Subir budget em runtime com aprovação foi entregue em D-30 (#372/#388): `budget.raised` no ledger, teto físico exige `CONFIRMAR`; sem TTY ou `onExceed: stop` continua a parada segura. O B4 decide depois do estouro: `continue_same`/`lower_effort`/`stop` no chat/TUI e mais `raise` (D-30) na CLI. O prompt de não-progresso (`onNoProgress`) é o ponto de "continuar" em runtime.

**Escopo multi-agent (L5/L6).** No loop multi-agent cada agente ativo grava o próprio checkpoint, uma vez, na fração do limite dele (turnos do agente) ou do gasto do escopo, depois das tools do turno; o não-progresso é contado por agente, inclusive no turno que faz handoff. A gravação é best-effort: falha de I/O/encoding vira audit `loop.checkpoint_error` com `{step, code}` (sem path nem conteúdo) e o run continua — não queima o handoff já recebido. O filho do `task` recebe o mesmo `config.run` e o decider do pai. Nome de agente/run com `_` ou `.` vira segmento reversível do path (`x_` + base64url); nome que não pode virar segmento (separador, `..`, controle/formatação ou >120 caracteres) é recusado no load da config.

**Não-progresso (L6).** Sinais por segmento: hash dos caminhos tocados pelas tools + número de falhas de tool (um teste que falha vira erro de tool). O tamanho do histórico não entra no hash porque cresce a cada turno e mascararia o loop. 3 segmentos sem mudança → pausa e pergunta.

**Judge (L4).** Permanece `off` por default; `on`/`auto` ficam documentados sem implementação (v2, guarda-chuva #138).

**Paradas físicas (L7).** Loop `unlimited` para por: conclusão, teto físico (`ceiling_hit`, ADR-0013) ou não-progresso — nunca roda sem parada física (golden §11.8).

## Consequências

- Ganho: runs longos supervisionados, com estado seguro e retomável; sem loop infinito sem corte.
- Custo: S-18 (#135) implementa; apresentação no REPL/TUI fica em T1/T2.
- Invariantes afetadas: I-19 (estado seguro e retomável), I-03 (checkpoint sanitizado).

## Alternativas descartadas

- Sem checkpoint: trabalho longo perdido no esgotamento do limite.
- Judge `on` por default: custo extra e não determinismo — v2.
- Parar apenas em `maxTurns`: deixa o loop sem corte quando não há progresso.
