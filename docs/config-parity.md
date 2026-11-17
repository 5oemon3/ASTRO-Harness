# Paridade de configuração: CLI, TUI e REPL

Objetivo: uma só configuração efetiva; cada ajuste tem um dono e um arquivo, e nenhuma superfície mantém store de config paralelo. Responde D-CFG2 e Q-10 (#453); a decisão está em D-31.

| Cobre | Não cobre |
|---|---|
| Precedência, autoridade por ajuste, o que cada superfície lê/grava, resposta de Q-10 e migração de stores | Implementação (lacunas no fim), semântica de budget (`ADR-0013`) e de permissões (`ADR-0027`/D-24) e sharing via registry (`config push/pull`) |

## Referência OpenCode

Comparado com o OpenCode: o núcleo descobre uma config única (`packages/core/src/config`, `opencode.json`/`.jsonc`, com precedência sistema/global/explicit/projeto) e cada cliente guarda só estado local de UI (`packages/cli/src/config`, incluindo a migração do TUI v1).

| Superfície OpenCode | Paridade | Decisão no ASTRO |
|---|---|---|
| config do núcleo (global/projeto/explicit) | mesma | `$ASTRO_HOME/config.json` + projeto (`astro.config.json`/`--config`), ADR-0029 |
| preferências do cliente (tema, abas) | mesma | `.astro/tui.json`, estado de UI, descartável |
| app/desktop/web como clientes adicionais | não se aplica | ASTRO é local: CLI, TUI e REPL no mesmo processo e nas mesmas camadas |
| flags de CLI | mesma | efêmeras; vencem a invocação, nunca gravam |
| servidor/sync de config | não se aplica | só `config push/pull` explícito via registry |

## Precedência (normativa)

As camadas e as regras de merge são de ADR-0029; esta seção aplica o recorte às três superfícies.

| # | Camada | Origem | Quem grava |
|---|---|---|---|
| 1 | defaults de código | `BASELINE_LAYER` e defaults de `validateConfig` | ninguém |
| 2 | global | `$ASTRO_HOME/config.json` (`ASTRO_HOME`, default `~/.astro`) | usuário; import único de #459; `vault-import` de perfil global (store hoje, `config.json` após #459); CRUD de provider da TUI/REPL (alvo de #401, após #459 — #492) |
| 3 | projeto | `astro.config.json` do cwd ou `--config` | usuário; `/config` da TUI (`permissions.mode`); `config pull`; `vault-import` de provider do projeto |
| 4 | invocação | `--provider`, `--permission-mode`, `ASTRO_PROVIDER`, `ASTRO_PERMISSION_MODE`, `--allow-critical`/`--allow-sensitive`, `--no-global-config` | ninguém; existe só no processo |

- `--config <path>` escolhe o arquivo da camada 3 (default `astro.config.json`, resolvido do cwd); a camada 2 continua valendo. `--no-global-config` vale para qualquer comando, grava `ASTRO_NO_GLOBAL_CONFIG=1` no processo e remove a camada 2 (o env sozinho faz o mesmo); o store de perfis continua sendo lido hoje e só é desligado quando #459 entrar. Nenhum dos dois é persistido.
- Objetos mesclam em profundidade; arrays substituem, exceto `models` (união por `provider/id`, projeto vence); escalares substituem.
- O projeto não amplia as chaves cobertas por `assertNarrowed`: tools e perfil de agente, `permissions.mode`, budget, quotas, endpoint de credencial e `quotaDomain`. `paths`, `tools.run_command.sandbox` e `security` não passam por essa guarda; nas chaves cobertas, violação é erro, não override.
- Provider ativo: `--provider` > `ASTRO_PROVIDER` > `activeProfileId` > provider de `agent.model`. `agent.profile` vence a seleção de store/env; `--provider` divergente é erro.
- Modo: `--permission-mode` > `ASTRO_PERMISSION_MODE` > `permissions.mode` > `ask`. O perfil efêmero `OPENAI_*` só é selecionado quando a config não define um provider/modelo e nunca é gravado.

## Autoridade por ajuste (Q-10)

| Ajuste | Persistido em | CLI | TUI | REPL | Classe / por quê |
|---|---|---|---|---|---|
| providers e models | camadas 2–3 | lê | lê + CRUD guiado (provider/perfil) | lê + CRUD guiado (provider/perfil) | compartilhado: contrato do run |
| pricing, quota, paths, MCP, plugins | camadas 2–3 | lê | lê | lê | compartilhado; edição só no arquivo |
| provider ativo | `activeProfileId` (store legado hoje; `config.json` após #459/#492) | `--provider` efêmero | tela; só perfil global | `/provider use`; só global | compartilhado; flag CLI-only |
| modelo do turno | `agent.model`/`modelPool` (camadas 2–3) | sem flag | `lastModel` no boot; `/model` em runtime | só config; `/model` em runtime | compartilhado; memória TUI-only |
| `permissions.mode` | camada 3 | `--permission-mode`/env efêmeros | `/config` grava; `/mode` runtime | `/config` só imprime; `/mode` runtime | compartilhado; persistência TUI-only |
| trust | `$ASTRO_HOME/state.json` | pergunta no TTY | pergunta; revoga no `/config` | pergunta | compartilhado; revogação TUI-only |
| tema, `lastModel`, favoritos, recentes | estado de UI (`.astro/tui.json` hoje; #468 define a raiz) | não lê | lê/grava | não lê | TUI-only: preferência de terminal |
| sessões | `.astro/sessions.db` (SQLite; `.astro/sessions/` é legado migrado; #468 move para `$ASTRO_HOME`) | sem comando | picker: lista/renomeia/exclui/retoma | lista/retoma/exclui (TTY) | compartilhado; renomear TUI-only |
| `--allow-critical`/`--allow-sensitive`/`--i-understand` | invocação | entrada | herda | herda | CLI-only: allowlist é ato explícito (ADR-0027) |
| `--artifact-root` | invocação de `chat`/`tui` | entrada | herda | herda | CLI-only na entrada, compartilhado na sessão |
| `config push/pull`, `providers vault-import`, `doctor --fix`, `config migrate` (alvo) | camada 3/2, `$ASTRO_HOME` | executa | não expõe | não expõe | CLI-only: operação administrativa |
| primeiro run / setup de provider | nenhum arquivo por default | `run` exige config | abre setup automático | erro com instrução | TUI-only hoje; alvo: contrato comum quando S3 (#469) definir a criação |

## Flag versus valor gravado (Q-10)

| Regra | Comportamento |
|---|---|
| R1 | Flag vence só a invocação e nunca grava; ao sair, o valor gravado volta. |
| R2 | Flag inválida (provider inexistente, modo inválido) falha antes do run; não cai no valor gravado. |
| R3 | `--provider` divergente de `agent.profile` é erro; seleção de env/store divergente gera aviso e é ignorada. |
| R4 | Status (footer da TUI e linha do REPL) e `/details` mostram o provider/modelo efetivos, não a seleção gravada; não mostram a origem. `run.started` audita `providerSource`/`providerSelection`. |
| R4b | A lista de providers mostra a origem: a TUI sempre (`[source]`) e o REPL em `/provider list`; `/providers` mostra `credentialRef`, não a origem. |
| R5 | Escrita na camada de projeto não pode ampliar a global (ex.: `mode: bypass` com global `ask`): o merge tem de falhar e o arquivo ficar intacto. |
| R6 | `--no-global-config` remove a camada global de config, mas hoje ainda lê/grava o store de perfis; quando #459 entrar, o store também é desligado e a escrita falha com `GlobalStoreDisabledError` (planejado). Não cria arquivo alternativo. |
| R7 | Sem TTY, `ask` nega e para (#461); `bypass` explícito continua valendo. Nenhuma superfície troca o modo sozinha. |

## D-CFG2: um store, não dois

A TUI e o REPL **não** criam store de configuração próprio. O contrato é escrever os mesmos arquivos da CLI, por um escritor validado e atômico (`updateConfigFile` para a camada de projeto; o mesmo contrato para a global após #459/#492), exceto `config pull`, que ainda usa `writeFileSync` (lacuna). Divergência é bug, não contrato.

| Arquivo | Guarda | Lido por | Gravado por |
|---|---|---|---|
| `$ASTRO_HOME/config.json` | config global: providers, models, preferências; provider guarda só referência de credencial; `mcpServers.*.env`/`args` não têm screening — lacuna | CLI/TUI/REPL | usuário; import de #459; CRUD da TUI/REPL (#492) |
| `astro.config.json`/`--config` | política do projeto | CLI/TUI/REPL | usuário; `/config` da TUI (`permissions.mode`); `config pull`; `vault-import` de provider do projeto |
| `$ASTRO_HOME/state.json` | trust e `migrations.*` | todas | prompt de trust (TTY), revogação da TUI, migrações |
| `$ASTRO_HOME/vault.json` | segredo de API key (OAuth Codex: `~/.codex/auth.json`) | runtime | wizard da TUI; `vault-import --apply` |
| `$ASTRO_HOME/providers.json` | legado pré-#459 | só antes de `migrations.providers` | import-only após #459; escrita recusada |
| `$ASTRO_HOME/trusted.json` | legado de trust | só antes de `migrations.trust` | importado e preservado; `saveTrustedStore` com caminho explícito ainda grava |
| `.astro/tui.json` | tema, `lastModel`, favoritos, recentes | só TUI | só TUI |

- `.astro/tui.json` é estado de UI, não config: ausente ou inválido cai nos defaults, o CLI/REPL nunca leem e ele não vence config explícita. A exceção é `lastModel` no boot da TUI, e só sem `--provider`: ele é passado como `opts.model` e vence `agent.model`, então o modelo do projeto é trocado sem aprovação — gap de I-08.
- #468 move a raiz desse estado para `$ASTRO_HOME` (tema global com override por projeto); a autoridade continua TUI-only.
- `activeProfileId` mora junto dos providers (store legado; `config.json` após #459/#492); `lastModel` é dica de UI. Depois de `/model`, `●` (ativo salvo) e `em uso` (sessão) podem divergir — é esperado.
- Na lista de perfis (`/provider list` no REPL, tela da TUI), projeto e `env` aparecem com `[source]`, mas são somente leitura; ativar é runtime-only. Só perfil global grava `activeProfileId`.

## Migração e retrocompatibilidade

- A TUI não introduz migração própria: reusa as camadas; `tui.json` é opcional e descartável.
- #459 importa `providers.json` uma vez para `config.json` e marca `migrations.providers`; depois disso o legado é import-only (preservado byte a byte, não lido, escrita recusada com `ProfileStoreMigratedError`, nome planejado em #459).
- `trusted.json` é importado e preservado (#403); depois de `migrations.trust` não é mais lido, mas `saveTrustedStore` não recusa escrita em caminho explícito — diferente de `providers.json` após #459.
- Antes de #459, o CRUD da TUI/REPL ainda grava o store legado; é a janela de migração, não uma segunda fonte. Quando #459 entrar e antes de #492, o CRUD recusa; o alvo é um só: `config.json`.

## Lacunas de implementação

| Lacuna | Efeito hoje | Onde |
|---|---|---|
| CRUD de provider da TUI/REPL gravar `config.json` | quando #459 entrar, `saveProfileStore` recusa e o CRUD para; falta o escritor de config | #492 (próximo slice de #401) |
| `providers vault-import` de perfil global gravar `config.json` | mesmo bloqueio após #459 | #491 |
| `/config` validar o merge com a camada global antes de gravar | `updateConfigFile` valida só a camada: um `mode` mais largo passa, a sessão aplica e o próximo load falha em `assertNarrowed` | #494 (contrato R5) |
| `astro config migrate` e `CONFIG_SCHEMA_VERSION` (ADR-0028) | não há migração de major nem rejeição de chave desconhecida | #493 |
| `config pull` usa `writeFileSync` simples | não é atômico/0600 como os demais escritores | #495 |
| `/config` em projeto sem arquivo | modo não persiste; S3 não cria config | #469 |
| `lastModel` da TUI vence `agent.model` no boot | troca de modelo sem aprovação explícita (I-08); `--provider` desliga | #497 |
| `mcpServers.*.env`/`args` sem screening de segredo | `config push` publica valor colado; I-03 em risco | #496 |
