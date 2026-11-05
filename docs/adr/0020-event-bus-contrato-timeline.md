# ADR-0020: event bus — contrato e modelo de eventos da timeline

- Status: aceita
- Data: 2026-11-05
- Issue: #369
- Decisões relacionadas: ADR-0002, ADR-0010, ADR-0014, ADR-0021 (a abrir), ADR-0022 (a abrir), I-03, I-18, I-19

## Contexto

A TUI atual mantém uma lista própria de entradas (user/assistant/info/error) e o runtime devolve só `{final, steps, messages}`; tool calls, comandos, diffs e eventos de sistema não chegam à timeline. O plano v3.0 precisa de uma timeline única, sem segunda fonte de verdade e sem acoplar a UI ao runtime.

## Decisão

**Envelope.** Todo evento é `{v: 1, id, seq, sessionId?, runId, agentId, kind, at, durability, payload}`. `id` é único; `seq` é monotônico por sessão/processo e é de entrega, distinto do `seq` do ledger; `sessionId` é null em run one-shot; `durability` é `ledger|session|ephemeral` (o mapeamento por kind é do ADR-0021). `payload` é JSON-safe, com cap de tamanho; o emissor nunca bloqueia o runtime.

**Eventos da timeline.** `turn.started`, `message.user`, `message.assistant.delta` (efêmero), `message.assistant.done`, `reasoning.delta` (efêmero), `command.started`, `command.finished`, `tool.call`, `tool.result`, `file.diff`, `system`, `turn.finished`, `error`. `system.payload.type` cobre `model.changed`, `billing.changed`, `effort.jump`, `compaction.completed`, `checkpoint.written`, `config.changed`, `config.migrated`; `subagent.*` fica para a extensão multi-agente.

**Entrega e ordem.** O transporte 2a é in-process (`onEvent` em `runTask`/`runAgentSession`); o 2b é um servidor local que transporta o mesmo envelope. Subscribers recebem em ordem de `seq`; exceção de subscriber é isolada. Deltas efêmeros podem ser coalescidos/descartados sob backpressure; eventos finais (`done`/`result`/`error`/`system`) e persistidos não são descartados. A TUI reconcilia por `id` e `seq`, sem estado próprio; em reconexão/restart, recarrega session store + ledger (ADR-0010/0002) e ignora eventos abaixo do high-water mark.

**Persistência e replay.** O bus não é fonte de verdade: `ledger` é decisão/uso/sistema (ADR-0002), `session` é mensagem/tool (ADR-0010), `ephemeral` vive só em memória. `file.diff` persistido é referência/hash ou artefato com cap; `config.changed` nunca carrega valor de segredo; `reasoning.delta` nunca persiste. Replay reconstrói a decisão do ledger sem o stream (ADR-0022); a timeline 2a não depende do servidor.

**Segurança.** `message.user` é exibido como digitado ao vivo; a persistência no session store aplica sanitize-on-write e audit/ledger guardam só `taskHash` (D-11, I-03). Payload de evento persistido ou entregue fora do processo é sanitizado; `file.diff` segue a classe do path (hard-block omitido, sensível redigido). O bus é de UI/observabilidade, não canal entre agentes (I-18); transporte local e auth ficam no ADR de segurança.

## Consequências

- Ganho: uma timeline única, com deltas ao vivo e estado reconstruível, sem segunda fonte.
- Custo: `onEvent` no runtime e no `AgentSession`; coalescência de deltas; schema do envelope versionado.
- Invariantes afetadas: I-03 (payload sanitizado/persistido), I-18 (sem canal peer-to-peer), I-19 (não bloquear a parada segura).

## Alternativas descartadas

- TUI ler o ledger diretamente: não tem deltas ao vivo e cria acoplamento/segundo estado.
- Persistir todos os eventos no ledger: inflaria o ledger com stream e conteúdo sensível.
- Um evento genérico `update` para tudo: perde semântica e dificulta replay/render.
- Deltas bloqueantes (backpressure no runtime): atrasaria o run por causa da UI.
- Servidor no 2a: atrasaria a timeline; o mesmo envelope permite trocar o transporte depois.
