# ADR-0021: event bus — persistência por tipo de evento

- Status: aceita
- Data: 2026-11-05
- Issue: #376
- Decisões relacionadas: ADR-0002, ADR-0010, ADR-0020, ADR-0022, I-03, I-04

## Contexto

ADR-0020 define o envelope e o campo `durability`, mas não decide onde cada kind persiste. Persistir tudo no ledger infla o log e mistura stream com decisão; não persistir nada perde replay. A separação precisa ser explícita para não criar segunda fonte de verdade nem vazar conteúdo sensível.

## Decisão

**Tabela de persistência.** O `durability` é atribuído pelo produtor conforme o kind; divergência entre kind e campo é erro de teste/contrato.

| kind | destino | regra |
|---|---|---|
| `turn.started`/`turn.finished` | ephemeral | timeline ao vivo; replay deriva turnos de `usage`/mensagens |
| `message.user` | session | exibido ao vivo; gravado sanitizado; audit/ledger só `taskHash` |
| `message.part` (alias `message.assistant.delta`) | ephemeral | stream coalescido; nunca grava |
| `message.assistant.done` | session | conteúdo sanitizado; sem reasoning |
| `reasoning.part` (alias `reasoning.delta`) | ephemeral | texto nunca persiste; só metadados |
| `session.updated` | ephemeral | invalidação/estado da UI; nunca grava |
| `tool.call.stream` | ephemeral | stream de tool; nunca grava |
| `command.started`/`command.finished` | session | comando/saída sanitizados e truncados; exit code/duração |
| `tool.call` | session | args sanitizados; o ledger registra uso/custo quando houver |
| `tool.result` | session | saída sanitizada/truncada; erro tipado |
| `file.diff` | ledger | diff redigido com cap; acima do cap vira artefato + referência/hash; hard-block omitido, sensível redigido, normal verbatim |
| `system` | ledger/audit | `model.changed`, `billing.changed`, `effort.jump`, `compaction.completed`, `checkpoint.written`, `config.changed`, `config.migrated`; sem valor de segredo |
| `subagent.launched`/`subagent.completed` | ledger | evento de orquestração; implementação multi-agente posterior |
| `error` | ledger/audit | mensagem sanitizada; sem segredo |

**Escrita.** O bus não persiste: o dono do destino grava (ledger append-only sob lock, ADR-0002; session store por `session_id/agent_id`, ADR-0010) antes ou no momento do emit. Falha de escrita persistida é erro do run/dono, nunca um evento "fantasma" no bus. `ephemeral` nunca toca disco.

**Histórico de mensagens.** O "histórico bruto" do plano é o session store (mensagens/tool calls, ADR-0010); o ledger guarda decisão/uso/sistema. O mesmo fato não é duplicado nos dois: o evento persistido é uma projeção com `payload.ref` para o registro durável.

**Reasoning.** O ledger/`usage` guarda só metadados (`reasoningTokens`, duração, `exposed`) e o HMAC do conteúdo quando essa camada existir; o texto nunca persiste. A chave do HMAC e sua rotação ficam no ADR de segurança.

**Sanitização.** Conteúdo de mensagem/tool passa por `redactSecrets` antes de gravar; `file.diff` segue a classe do path (`hard-block` omitido, `sensitiveButUseful` redigido, normal verbatim); `config.changed` guarda só chaves/diff não secreto; reasoning nunca. O ledger não ganha payload de stream.

## Consequências

- Ganho: uma regra única de persistência, ledger enxuto e replay sem stream.
- Custo: tabela versionada e testes por kind; toda evolução de evento define o destino.
- Invariantes afetadas: I-03 (sanitização), I-04 (auditoria), I-06 (replay).

## Alternativas descartadas

- Persistir todos os eventos no ledger: stream e conteúdo sensível inflam o log.
- Não persistir nada: perde decisão/uso e replay.
- TUI persistir: segunda fonte de verdade.
- Guardar reasoning: viola I-03 e o contrato de metadados.
