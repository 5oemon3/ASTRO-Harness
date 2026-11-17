# CI (GitHub Actions)

Resumo: jobs que rodam em todo PR, pré-requisitos de runner e equivalente local; CI verde é pré-condição de merge (`docs/workflow.md` §6).

| Cobre | Não cobre |
|---|---|
| Jobs, pré-requisitos de runner, equivalente local, política de merge | Billing e segredos do repositório no GitHub |

## Jobs (`.github/workflows/ci.yml`)

| Job | Runner | O que faz | Equivalente local |
|---|---|---|---|
| `test` | ubuntu-latest + windows-latest | `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` | os mesmos comandos |
| `eval` | ubuntu-latest | `bun src/cli.ts eval --threshold 0.85 --report eval-report.json` (mock) | idem |
| `coverage` | ubuntu-latest | `bun test --coverage --coverage-reporter=lcov` + `scripts/coverage-gate.ts` (total de linhas e funções ≥ 80%) | `bun run test:coverage` |
| `bench-mock` | ubuntu-latest + windows-latest × filtro `nvidia`/`openrouter` | `bun test tests/bench.test.ts -t "filtro do CI matrix restringe o bench com mocks: <filtro>"` com providers mock; não é required | idem |
| `secrets` | ubuntu-latest | gitleaks no histórico | — |

A matriz `test` roda nos dois SOs de propósito: há regressões específicas de win32 (paths, quirk de stdout do Bun) e de Linux (POSIX, Docker).

O bench noturno/ manual fica em `.github/workflows/bench.yml`; métricas, filtro e opt-in em `docs/eval.md`.

## Pré-requisitos e comportamento condicional

- **Docker**: só é usado quando `docker info` responde com engine **Linux** (`OSType=linux`). Windows containers e ausência de daemon → recusa clara do sandbox, sem downgrade. Testes de sandbox têm timeout de 60s (pull + quatro execuções).
- **LSP**: usa `typescript/unstable/async` (streams), compatível com Bun no Linux e no Windows. O canal sync dependia de `stdout._handle.fd`, indisponível no Bun/POSIX (#140).
- **Skill**: teste de `run_command` não depende do `PATH` do host; o `env` do run é o ambiente do filho.

## Política de merge

- PR só entra com `test` verde nos **dois** sistemas, `eval`, `coverage` e `secrets` verdes, mais **2 veredictos `Revisão: APPROVE`** no PR (A segurança + B correctness) (`docs/workflow.md` §6).
- Não usar `--admin` para contornar check vermelho. Exceção por causa externa (billing, runner) é registrada no PR com justificativa e issue de correção.
- Falha intermitente: reexecutar o job; se repetir, abrir issue com o link do run.

## Gate de release local (#230)

`bun run release:check` roda typecheck, `bun test`, build, smoke, `npm pack`, instala o tarball em um diretório temporário, confere a identidade `@umtioai/astro-harness` e executa o `astro` local (`<temp>/node_modules/.bin/astro[.cmd]`) com `--help`. `--skip-tests` pula typecheck/test; `--json` imprime um resumo estável. O gate nunca publica e falha fechado na primeira etapa com erro.

- **Binário local**: um `astro` global no PATH não satisfaz a etapa; se o `.bin` instalado não existir, o gate falha.
- **`npm install <tarball>`**: o pacote sob teste é local, mas `ink`, `react` e `bun` ainda vêm do registry. Não usamos `--ignore-scripts` porque o pacote `bun` precisa do postinstall para materializar o runtime; o ambiente do npm é sanitizado, mas isolamento total de HOME/`.npmrc` é residual.
- **Sinais**: `SIGINT`/`SIGTERM` limpam em melhor esforço; `kill -9`/hard kill pode deixar `astro-release-check-*` no temp.
- **Argumento desconhecido**: com `--json`, o erro de uso ainda vai para stderr humano e sai 2; nenhum resumo JSON é emitido.
- TUI e setup de provider continuam manuais (`astro tui`).

## Referências

#140 (CI verde), #230 (gate de release), `.github/workflows/ci.yml`, `docs/workflow.md` §6, `docs/review-checklist.md`.
