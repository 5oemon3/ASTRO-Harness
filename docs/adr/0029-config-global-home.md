# ADR-0029: configuração global no home do ASTRO

- Status: aceita
- Data: 2026-11-06
- Issue: #401
- Decisões relacionadas: ADR-0019, ADR-0028, I-01, I-03, I-11, I-17

## Contexto

`astro.config.json` é configuração de projeto; providers e trust também precisam sobreviver entre projetos. Os stores legados separam esses dados em arquivos no home, sem uma precedência única para a configuração efetiva.

## Decisão

Use `$ASTRO_HOME` (default `~/.astro`) para `config.json`, `state.json` e `vault.json`. `config.json` contém preferências e providers sem valores secretos; `state.json` contém trust por caminho e marcadores de migração; `vault.json` continua sendo o único arquivo de valores secretos.

Resolva defaults < configuração global < configuração de projeto (`astro.config.json` ou `--config`) < flags/env. `--config` escolhe somente a camada de projeto. `--no-global-config` e `ASTRO_NO_GLOBAL_CONFIG=1` ignoram a camada global.

Mescle objetos em profundidade; arrays substituem, exceto `models`, unidos por `provider/id` com precedência do projeto; escalares substituem. O schema de cada camada vale antes da mescla para o XOR de `model`/`profile` e para `models` repetido; todo model aponta para um provider declarado nas camadas combinadas.

Rejeite widening de tools, modo de permissões e budget declarado globalmente (`budget.limitUsd`, `budget.hardCeilingUsd`, `budget.scope`, `budget.onExceed`, `team.projectBudgetUsd` e `quota`). `effort` é política do usuário: a camada de projeto não pode declará-la (nem para desligar), porque o default é off e o projeto habilitaria auto-escalada ou subiria caps. O domínio de quota é política: quando o domínio de origem de um provider que o projeto declara (mesmo id ou reuso da referência global) tem limite em `quota`, o gasto continua em um domínio com limite declarado na camada global — um domínio sem limite passa no enforcement (que corta por domínio) e a troca fragmentaria o contador da conta. O limite do destino precisa estar na camada global: um limite só do projeto não conta, porque o projeto pode aumentá-lo. A regra vale só para o que o projeto declara: `config.json` e `providers.json` discordando sobre o domínio da mesma conta é divergência do usuário, não erro do projeto.

O projeto também não pode mudar o endpoint de um provider global herdando a credencial global, nem reutilizar em outro endpoint uma referência de credencial declarada globalmente (config global ou `providers.json`): a referência é reservada pela camada global e pelo store. O endpoint é a URL canonicalizada (esquema, host, path e query) junto com o `kind` do provider. A comparação canonicaliza a URL, o caminho do arquivo e o nome de variável de ambiente sem diferenciar maiúsculas — o nome é comparado assim em todas as plataformas, para o comportamento não depender do sistema operacional.

Importe `providers.json` e `trusted.json` uma única vez para os destinos novos, preservando os arquivos legados. Sem configuração nem dados legados, o carregamento não cria arquivos; a configuração só é criada por uma ação explícita confirmada.

Após migrar providers, `config.json` é a fonte de verdade também para o gerenciador de providers da TUI; `providers.json` permanece preservado e não recebe novas edições.

## Consequências

- Ganho: preferências de usuário são reutilizadas entre projetos com fronteira clara para trust e segredos.
- Custo: o loader deve validar as camadas antes de executar; projeto não pode relaxar políticas globais.
- Custo: depois da migração, `config.json` é a única fonte (leitura e escrita); o legado fica preservado e escrever nele falha com `ProfileStoreMigratedError` apontando a config. A seleção ativa acompanha os perfis em `activeProfileId`; a TUI ainda não edita a config (slice seguinte de #401). Import e flag não são transacionais: a config é gravada antes da flag e repetir o import é idempotente (janela aceita de propósito).
- Invariantes afetados: I-01, I-03, I-11 e I-17.

## Alternativas descartadas

- Usar apenas `astro.config.json`: repete preferências e não oferece estado global.
- Gravar configuração no primeiro start: cria estado sem consentimento explícito.
- Mover segredos para `config.json` ou `state.json`: viola I-03.
