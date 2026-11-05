# ADR-0028: config — versionamento semver, compatibilidade e migração

- Status: aceita
- Data: 2026-11-05
- Issue: #386
- Decisões relacionadas: ADR-0002, ADR-0019, ADR-0023, ADR-0026, ADR-0027, D-15, I-03, I-19

## Contexto

`astro.config.json` é config de projeto. `version` é validado como `x.y.z` quando presente, mas não participa de nenhuma decisão de compatibilidade; chave desconhecida no **topo** é ignorada em silêncio e só algumas seções (`call`, `modelRouting`, `outputLimit`, `compaction`, `webSearch`) rejeitam chave extra. Resultado: config de harness novo roda em harness antigo com ajustes perdidos, e um typo passa despercebido. O ADR-0023 delega a política de migração/deprecação para cá; o ADR-0026/0027 delegam aqui o versionamento das chaves novas.

## Decisão

**Versão.** `version` é a versão do **schema do documento**, semver `x.y.z`, independente da versão do harness em `package.json`. Ausente = `0.0.0` (legado), aceito; `AstroConfig.version` fica `undefined` (ausência preservada) e `migratedFrom = "0.0.0"`, e o `doctor` sugere declarar. O harness declara `CONFIG_SCHEMA_VERSION` (semver, alvo `1.0.0`) e `CONFIG_KEYS` por major, fonte runtime de "chave conhecida"; o schema aninhado continua em `src/config.ts`.

**Semântica.** major: remove, renomeia, redefine tipo/default, ou endurece validação a ponto de rejeitar config antes aceita; minor: chave ou valor novo opcional, retrocompatível; patch: só mensagem/correção sem mudar o que é aceito. Chave nova entra em `src/config.ts` no mesmo PR do comportamento, com validação, teste e nota do minor.

**Ordem (normativa).** (1) Ler o JSON cru e validar só a forma de `version`; (2) se major > `CONFIG_SCHEMA_VERSION`, recusar `config_ahead_of_harness` **antes** de qualquer checagem de chave; (3) checar chave desconhecida no documento de **origem** contra a **união** `CONFIG_KEYS(declarado..suportado)` — uma config legada sem `version` usa a união `0..suportado`, e `CONFIG_KEYS(0)` é o conjunto de topo legado hoje aceito; (4) migrar major antigo em memória; (5) checar o **destino** contra `CONFIG_KEYS(suportado)`; (6) validar o resultado. Se o major é o suportado e o minor do arquivo é maior, chave desconhecida que exista no minor novo gera dica de upgrade; chave que não existe em nenhum minor conhecido ≤ suportado continua `config_unknown_key` (a dica não suprime typo).

**Matriz.**

| config | resultado |
|---|---|
| major == suportado | aceita; minor/patch não decidem aceite, só a dica de upgrade |
| major < suportado | migra em memória, um major por passo (`migrateVnToN+1` puro, cadeia testada por passo); sem caminho → `config_migration_required` |
| major > suportado | recusa `config_ahead_of_harness`; nunca adivinha |
| ausente (`0.0.0`) | major 0, migra para o suportado em memória |

**Chaves desconhecidas.** Em major 1, chave desconhecida em seção de forma fixa é `config_unknown_key`. Contêineres de **nome livre** são dados apenas no nome; o valor continua seção de forma fixa: `providers`, `agents`, `modelPool`, `mcpServers`, `quota`, `pricing`, `team.agentQuotas` e as chaves de `headers`/`env`. No topo, `$schema` (string URI, nunca buscada) e `provenance` (forma `{registry: string, plugins: boolean}`, de `src/config-share.ts`/#255) são metadados permitidos: validados, preservados pelas migrações, nunca tratados como config e nunca fonte de autorização. A migração não pode reconstruir o objeto por whitelist antes da checagem, senão a chave desconhecida some — a perda silenciosa que esta decisão proíbe.

**Guardas de segurança.** O documento contém chave sensível (`permissions.mode`, `tools.run_command.sandbox`, `budget`, `paths`). Nenhum passo de migração pode reduzir o valor efetivo de uma chave de segurança nem injetar default permissivo para chave ausente; transformação que preserve a semântica é permitida, e o resto falha `config_migration_required`. `security.entropyThreshold` vem de flag/env do usuário, nunca do config de projeto. As allowlists (`allow-sensitive`/`allow-critical`) seguem o ADR-0027: **só flag de CLI**, com `--i-understand` obrigatório quando exigido, e nunca vêm de `astro.config.json` nem de env. `astro config migrate` não é alcançável por tool, plugin ou `run_command`: o harness não reescreve o próprio `sandbox`/`permissions.mode`.

**Migração.** Default em memória, sem escrita. `astro config migrate [--config <path>]` valida **sempre**; já no major suportado e válida não escreve, imprime o `version` do arquivo e sai 0; inválida → erro e nenhuma escrita. Fora disso, roda a cadeia, valida origem e destino e grava **uma única vez**, atômico: temporário no mesmo diretório criado com `wx`, 0600 no POSIX ou ACL owner-only no Windows, `lstat` sem seguir symlink (recusa destino symlink ou não-regular), `fsync` do temporário, `rename` com o novo `version` já no conteúdo, `fsync` do diretório; falha de validação deixa o arquivo intacto.

**Deprecação.** Registro runtime `DEPRECATED_CONFIG_KEYS` (não JSDoc) alimenta o aviso uma vez por load e o `doctor`; a chave continua válida no minor em que é anunciada e só é removida no próximo major, com entrada no `CHANGELOG`.

**Escopo.** Só `astro.config.json` (inclusive `--config`). Stores de usuário (`providers.json`, `trusted.json`, `vault.json`) têm formato próprio e ficam fora; se ganharem versão, ADR próprio. Dado persistido continua com inteiro (ADR-0002), não semver.

**Erros.** `config_ahead_of_harness`, `config_migration_required`, `config_unknown_key` e a validação de `version` são `ConfigError`, com mensagem em português citando a chave, o major de destino e a migração disponível (nunca removê-la como sugestão), o formato esperado de `version` (nunca o valor cru) e nenhum segredo (I-03); a recusa sai antes do run, com exit ≠ 0 (não é checkpoint de I-19).

## Consequências

- Ganho: config incompatível falha alto em vez de perder ajuste; typo visível; migração reprodutível e testável por passo.
- Custo: harness antigo recusa config novo (intencional); validação estrita em seções de forma fixa é mudança de major 1; `astro config migrate`; manutenção da cadeia.
- Invariantes afetadas: I-03 (mensagem); I-11 não se aplica (config é path do usuário).

## Alternativas descartadas

- Ignorar chave desconhecida (status quo): perda silenciosa de configuração.
- `schemaVersion` inteiro no config: perde a compatibilidade aditiva que o config já usa; inteiro fica para dado persistido (ADR-0002).
- Migrar gravando sempre no load: escrita surpresa em arquivo versionado.
- Aceitar config mais novo com aviso: comportamento indefinido por chave.
- Versão por seção: multiplica majors e não resolve a compatibilidade do documento.
