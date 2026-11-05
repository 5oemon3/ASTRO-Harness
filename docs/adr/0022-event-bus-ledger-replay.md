# ADR-0022: event bus ↔ ledger — replay

- Status: aceita
- Data: 2026-11-05
- Issue: #376
- Decisões relacionadas: ADR-0002, ADR-0010, ADR-0020, ADR-0021, I-03, I-06, I-19

## Contexto

O bus entrega deltas ao vivo, mas deltas efêmeros podem cair e o `seq` de entrega reinicia com o processo. Replay precisa de uma ordem durável e de uma fonte que não dependa do stream; o ledger e o session store já são essas fontes. Falta dizer como os eventos persistidos se correlacionam e o que replay reconstrói.

## Decisão

**Fonte e ordem.** Replay lê o ledger (decisão/uso/sistema, `seq` monotônico sob lock, ADR-0002) e o session store (mensagens/tool calls, ADR-0010). O `seq` do bus é de entrega e não é durável; não substitui o `seq` do ledger. O bus pode reiniciar do zero; a TUI recarrega os stores e usa o high-water mark.

**Eventos persistidos são projeções.** Um evento `ledger` carrega `payload.ref` = `ledgerSeq` (ou o id do artefato); um evento `session` carrega `payload.ref` = `messageId`/`toolCallId`. O `id` do envelope é de correlação da UI, não a chave de replay. O mesmo fato não é gravado duas vezes: o ledger é a decisão; o session store é a mensagem.

**O que replay reconstrói.** Runs/agentes/estado (`run_state`, `agent`), uso/custo (`usage`), budget (`budget`), compactação/checkpoint, `subagent.*` e escolhas de config/system registradas. A timeline é uma projeção: mensagens/tool calls vêm do session store (o "histórico bruto" do plano, ADR-0010); eventos de sistema vêm do ledger/audit; o ledger não duplica mensagens. Reasoning: replay usa só metadados (`reasoningTokens`, duração, `exposed`, HMAC), nunca o texto. Deltas e stream não são reproduzidos. Gaps/inconsistência viram `replay_incomplete`, nunca replay parcial; `--resume` continua usando a árvore/ledger (ADR-0010/0014).

**Segurança.** Replay não lê reasoning nem stream; `file.diff` replay usa o diff redigido/artefato persistido; `config.changed` replay usa o diff não secreto; nenhum path de replay contorna I-03.

## Consequências

- Ganho: replay determinístico sem depender do bus; UI e auditoria com a mesma verdade.
- Custo: `payload.ref` nos eventos persistidos; merge por `ref` na TUI; testes de gap/replay.
- Invariantes afetadas: I-06 (replay), I-19 (retomada segura), I-03 (sem stream/segredo).

## Alternativas descartadas

- Replay do stream do bus: não durável, com deltas perdidos e reasoning.
- Reconstruir da TUI: segunda fonte de verdade.
- Persistir todos os eventos no ledger: duplicaria mensagens/stream (ADR-0021).
- Usar o `seq` do bus como durável: reinício do processo quebra a ordem.
