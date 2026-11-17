# Matriz de ameaças de segurança

Resumo: ameaça → mitigação → invariante/teste, com o dono de cada controle citado; a política completa não é duplicada aqui.

| Cobre | Não cobre |
|---|---|
| Ameaças priorizadas, mitigação existente e onde ela é testada | Política completa (`README.md` §Security, `docs/adr/0027-seguranca-hard-block-redacao-sandbox.md`), decisões (`docs/decisions.md`) e detalhe de configuração |

Donos por assunto: invariantes em `docs/invariants.md`; cofre em `docs/adr/0019-cofre-de-credenciais.md`; path/hard-block/redação/sandbox em `docs/adr/0027-seguranca-hard-block-redacao-sandbox.md`; MCP em `docs/mcp.md`; skills em `docs/skills.md`; web em `docs/web-tools.md`; providers em `docs/providers.md`; critérios de revisão em `docs/review-checklist.md`.

## Matriz

| Ameaça | Cenário | Mitigação (dono) | Invariante | Teste |
|---|---|---|---|---|
| Vazamento de API key/credencial | Chave em config, log, audit, ledger, erro, prompt ou saída de tool | Cofre local (ADR-0019) ou env nomeada; `src/sanitize-external.ts` (`redactSecrets`) antes de audit/ledger/contexto/artefato; `Auditor.sanitize` e `Ledger` redigem campos livres | I-03 | `tests/audit.test.ts`, `tests/ledger.test.ts`, `tests/security-f23.test.ts`, `tests/security-zero-secret.test.ts`, `tests/lsp.test.ts` |
| Credencial exposta ao shell/filho | `run_command` herda env com nome de segredo; stdout/stderr traz token | Env sanitizado (`src/tools/run-command.ts`), redação antes do truncamento, sandbox sem mount de `$ASTRO_HOME/keys` | I-03 | `tests/sandbox.test.ts`, `tests/security-f00.test.ts`, `tests/security-f09.test.ts` |
| Path traversal/escape do `cwd` | `..`, symlink/junction, path absoluto, `.astro/` ou item de hard-block | `src/tools/paths.ts` (`resolveWithin`) + `src/path-class.ts` (classe sobre realpath) + hard-block no dispatch (`src/tools/executor.ts`) | I-11 | `tests/tools.test.ts`, `tests/path-class.test.ts`, `tests/hard-block-gate.test.ts`, `tests/security-f00.test.ts` |
| Leitura/escrita de arquivo de segredo | `read_file` em `.env`, `edit` em `vault.json` ou chave privada | Hard-block imutável/configurável; `sensitive` exige aprovação fora do `bypass` e sai redigido; entropia em `read_file` | I-03, I-11 | `tests/hard-block-gate.test.ts`, `tests/path-class.test.ts`, `tests/permissions.test.ts` |
| Execução arbitrária/allowlist | Tool fora da allowlist, tool desconhecida, subagente pedindo mais escopo | Deny-by-default + ceiling/perfil (`src/tools/executor.ts`, `src/permissions.ts`); `spawn_agent` valida tools ⊆ pai | I-01, I-02 | `tests/tool-isolation.test.ts`, `tests/permissions.test.ts`, `tests/tools.test.ts` |
| Plugin local antes do trust / classe fail-open | Config de projeto aponta `plugins` para código local e o import roda antes da aprovação; tool de plugin sem `class` passa pelo gate | Plugin local só depois de `ensureTrustedCwd`; manifesto validado no load e no dispatch; `class` ausente/desconhecida nega `invalid_manifest` (#255, #264) | I-12, I-13 | `tests/plugins.test.ts`, `tests/permissions.test.ts`, `tests/sdk-tool.test.ts` |
| Shell sem sandbox | `run_command` com `sandbox: false`, mount do cofre ou git no container | Shell exige sandbox; recusa com `sandbox_required_for_shell`; máscaras de hard-block; imagem sem código do projeto | I-11, I-19 | `tests/sandbox.test.ts`, `tests/security-f00.test.ts`, `tests/tools.test.ts` |
| Prompt injection via web/MCP/skill/arquivo | Conteúdo externo pede para ignorar política ou executar comando | Conteúdo é dado, nunca instrução; manifesto avisa; tools seguem allowlist e gate; saída sanitizada antes do contexto | I-01, I-03, I-04 | `tests/web-fetch.test.ts`, `tests/web-search.test.ts`, `tests/mcp-tool.test.ts`, `tests/output-limit.test.ts` |
| SSRF/rede para host interno | `web_fetch`, `web_search`, webhook de auditoria ou MCP http/sse aponta para loopback, faixa privada ou metadata | `outboundUrlProblem` recusa loopback/faixa privada/metadata na URL configurada; `web_fetch` revalida cada hop e `web_search`, `sendAuditWebhook` e os transports MCP http/sse recusam redirect (`redirect: "error"`), então o header de credencial não chega a outro host. Limite: `webSearch.baseUrl` usa só `urlProblem` (aceita loopback/RFC1918/ULA) e `baseUrl` de provider plugin em `astro.config.json` não passa por `outboundUrlProblem` | I-03 | `tests/url-private-hosts.test.ts`, `tests/web-fetch.test.ts`, `tests/web-search.test.ts`, `tests/team.test.ts`, `tests/mcp-http.test.ts` |
| Skill maliciosa | Instalação por symlink, script fora da allowlist, `SKILL.md` adulterado | `src/skills/`: loader não segue link, `permissions.tools` ⊆ allowlist do agent, sidecar sha256, install recusa link | I-14, I-01, I-03 | `tests/skills-core.test.ts`, `tests/skills-cli.test.ts`, `tests/skills-executor.test.ts` |
| MCP malicioso | Servidor stdio é código arbitrário; header secreto; saída hostil; namespace colidindo | Env sanitizado, header só como `env:NOME`, saída tratada como untrusted, tool namespaced na allowlist, SSE na mesma origem | I-15, I-13, I-01, I-03 | `tests/mcp-stdio.test.ts`, `tests/mcp-tool.test.ts`, `tests/mcp-headers.test.ts`, `tests/mcp-registry.test.ts` |
| Redação/sandbox como cobertura | Confiar só em padrões; truncar antes de redigir; artefato cru | Redação em camadas antes do truncamento; artefato já redigido; entropia fail-closed em `sensitive`; padrões não substituem hard-block | I-03, I-11 | `tests/output-limit.test.ts`, `tests/path-class.test.ts`, `tests/sandbox.test.ts` |
| Auditoria incompleta/adulterada | Evento sem `seq`, append interrompido, segredo no payload, duração/custo ausentes | JSONL append-only com fsync e lock; `sanitize` no append; `durationMs` em `tool.result` e `costUsd` em `provider.complete` quando conhecido (#61) | I-04 | `tests/audit.test.ts`, `tests/ledger-lock.test.ts`, `tests/tools.test.ts` |

## Limites conhecidos

- Prompt injection não tem classificador: a defesa é tratar conteúdo externo como dado e manter allowlist/gate no caminho de execução, não detectar intenção maliciosa.
- Redação hex (#252): 64+ hex em texto externo é redigido sem contexto. No audit, `ref` só é preservado no padrão de artifact ref e `hash` só com 64-hex minúsculo; demais campos de ID/digest do harness (`sha256`, `digest`, `callId`, `handoff_id`, `ledger_id`, ...) são preservados por chave. Um segredo escondido nesses campos é residual aceito. No session store do chat, `ref`/`hash` fora de `message.attachments` reais passam por `redactSecrets`: valores não-64-hex (ex.: `refs/heads/main`, `abc1234`) sobrevivem por design; artifact ref/64-hex são redigidos fora de anexos. 40 hex (SHA-1) só é redigido com rótulo de credencial, para preservar `commit <sha>`/`git log`; 32 hex (MD5/checksum) não é redigido por padrão — residual aceito e coberto por `tests/sanitize-external.test.ts`.
- Cache de completion: `content` é redigido antes de gravar, mas `toolCalls[].arguments` fica intacto para o replay não corromper diff de `edit`/`write_file`. Segredo colocado pelo modelo nos argumentos não é redigido no cache — residual aceito; a execução continua sujeita ao gate e à redação das tools. O SQLite (`cache.db`) recebe `chmod 0600` no POSIX; no Windows valem as ACLs do diretório. Sidecars (`-journal`/`-wal`/`-shm`) herdam o diretório: mantenha-o `0700` no POSIX.
- `resolveWithin` ainda colapsa `..` lexicamente antes do realpath; a pendência está registrada como `F-00` em `docs/invariants.md` (I-11).
- `sandbox: false` desliga o shell por completo (`sandbox_required_for_shell`); não existe modo "shell sem isolamento".

## Manutenção

- Nova ameaça ou mitigação: acrescente a linha, cite o dono e o teste que a cobre; sem teste, abra issue antes de marcar como coberta.
- Revisão de segurança usa esta matriz como índice e `docs/review-checklist.md` como critério bloqueante.
- IDs de referência (`I-xx`, `D-xx`, `ADR-NNNN`, `#n`, `F-xx`) são estáveis; não cite número de linha.
