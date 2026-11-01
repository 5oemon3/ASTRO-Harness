# ADR-0019: cofre local de credenciais com DPAPI e fallback 0600

- Status: aceita
- Data: 2026-11-01
- Issue: a abrir (frente B)
- Decisões relacionadas: D-03, D-21, I-03, I-07, ADR-0009, ADR-0017, ADR-0018

## Contexto

A TUI só aceita `credentialRef` (nome de variável de ambiente) e não tem onde guardar uma chave digitada (`src/chat/provider-wizard.ts:100-113`, `src/provider/profiles.ts:117-122`). `providerAccountRefFor` já usa o `credentialRef` como conta para `openai-compat` (`src/config.ts:319-333`), então nomes de variável distintos já são contas distintas; duas credenciais do mesmo provider só viram contas distintas se a conta passar a ser a credencial. O precedente local é `saveCodexAuth` (`src/provider/codex-login.ts:263-282`): escrita atômica, 0600, `flag: "wx"`.

OpenCode guarda credenciais em SQLite 0600 sem cifra; OpenClaude cifra no SO (DPAPI no Windows, Keychain no macOS, libsecret no Linux) e cai em texto puro 0600 com aviso. O ASTRO roda em Bun multiplataforma (ADR-0017/0018), mas o beta é validado primeiro no Windows.

## Decisão

**Arquivo e proteção.** `~/.astro/vault.json` (`ASTRO_HOME` sobrescreve), diretório 0700, arquivo 0600, escrita atômica tmp+rename. Metadados em claro por credencial: `id`, `providerId`, `label`, `scheme`, `createdAt`, `lastUsedAt`, `active`. O segredo fica opaco: `scheme: "dpapi"` guarda o blob base64 de `ProtectedData.Protect(bytes, entropy, CurrentUser)` com entropia `astro:<usuário>`; `scheme: "plain"` guarda o valor em claro. O backend é escolhido por plataforma: DPAPI no Windows via PowerShell (sem dependência de runtime); fora do Windows, `plain` 0600 até existir backend nativo.

**Modelo de ameaça.** Em escopo: roubo do arquivo, backup, cópia para outra máquina ou outro usuário do Windows. Fora de escopo: processo rodando como o mesmo usuário (pode chamar `Unprotect`), dump de memória, malware e administrador. `plain` 0600 tem a mesma exposição do `~/.codex/auth.json` atual; é aceito explicitamente para não bloquear o beta, com aviso visível na TUI e em `astro providers health`, nunca silencioso.

**Múltiplas credenciais.** Várias por provider, uma `active`. `resolve(providerId)` devolve a ativa; `create`, `rotate`, `activate` e `remove` operam por `credentialId` sem reescrever o perfil. Precedência: cofre ativo > variável de ambiente nomeada por `credentialRef`. A origem (`vault`, `env`, `ausente`) aparece na TUI e no audit; o valor nunca.

**Contas.** `providerAccountRefFor` devolve `vault:<credentialId>` quando o provider tem credencial ativa no cofre; senão mantém o comportamento atual (`credentialRef`, caminho OAuth ou `provider:<name>`). A resolução da conta recebe o cofre; sem cofre, nada muda. `src/model-choice.ts:154` e `src/config.ts:1199-1207` passam a enxergar as contas do cofre. A validação estática continua contando contas declaradas; a checagem final `maxActive <= contas resolvíveis` ocorre no spawn, preservando `max_active_exceeds_accounts`.

**I-03 (texto novo).** Segredo pode repousar apenas no cofre local, cifrado por DPAPI ou em arquivo 0600; nunca em config, log, audit, ledger, cache, erro, prompt ou contexto de modelo. Em memória, só durante a requisição que o usa. `credentialRef` e `credentialId` são as únicas formas de citar uma credencial. `src/sanitize-external.ts`, `src/secrets.ts` e os testes de auditoria (`tests/audit.test.ts`) conhecem o cofre: redigem o blob `dpapi` e o valor `plain` antes de log, audit ou contexto, e o caminho de `vault.json` entra em `CRITICAL_PATHS`.

**D-03 (texto novo).** Credencial vem do cofre local quando há uma ativa; senão de variável de ambiente nomeada. Codex OAuth continua em `~/.codex/auth.json`. Config nunca guarda valor de segredo.

## Consequências

- Ganho: a TUI aceita chave digitada; N contas do mesmo provider destravam `maxActive`; rotação sem editar config.
- Custo: DPAPI exige spawn de PowerShell (ordem de 200–400 ms por operação) e cache em memória; testes por plataforma; `plain` é fallback aceito.
- Invariantes afetadas: I-03 (texto acima), I-07 (conta vira `vault:<id>`), I-08 (troca de credencial continua exigindo aprovação).
- Fora de escopo: Keychain/libsecret, cifra com passphrase, cofre para OAuth do Codex.

## Alternativas descartadas

- Só variável de ambiente: não atende a criação de modelo custom pela TUI.
- SQLite 0600 sem cifra (modelo OpenCode): mais simples, mas não cumpre "segura" em repouso.
- Keychain nativo como backend único: mais código por plataforma e o mesmo usuário continua lendo; fica como evolução.
- Cifra com passphrase: adiciona dependência e um prompt por sessão.
