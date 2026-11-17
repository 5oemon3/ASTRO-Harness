# Eval e bench de providers

Objetivo: como `astro eval` e `astro bench` medem qualidade e desempenho, com foco na success rate do bench e nos filtros de provider/modelo.

| Cobre | Não cobre |
|---|---|
| `eval` (gate mock), `bench` (providers reais), success rate, filtro `--models`, saídas e agendamento de CI | Conteúdo dos golden cases, política de merge (`docs/ci.md`) e decisões de rotação de modelos |

## Comandos

| Comando | O que faz | Saída |
|---|---|---|
| `bun src/cli.ts eval --threshold 0.85` | Roda o golden dataset em modo mock e compara com o baseline | `eval-report.json`; exit 1 abaixo do threshold ou com regressão |
| `bun src/cli.ts bench --models <filtro> --runs <n> [--require-filter]` | Mede cada modelo com a mesma suíte de prompts | `eval/bench-<data>.{json,md}` |

- `eval`: determinístico, sem provider real; é o gate de regressão no CI.
- `bench`: chama providers reais e consome quota; nunca roda em PR.

## Bench

### Métricas

| Métrica | Definição |
|---|---|
| `successRate` | `completed / total`; `completed` são as chamadas que devolveram resposta |
| `completed`, `total` | Chamadas concluídas e tentadas (`runs` × prompts da suíte) |
| `latencyMs` | `min`, `p50`, `p95` e `max` só das chamadas concluídas |
| `tokensInAvg`, `tokensOutAvg` | Média por chamada concluída |
| `tokensPerSec` | Tokens de saída divididos pela latência média |
| `costPer1kOutUsd` | Preço de saída por 1k tokens; `null` sem `price.verificado` |
| `ttftMs` | `null` até o contrato `Provider` expor streaming |

- Falha de um prompt não interrompe a suíte: entra em `successRate` e fica fora de latência e tokens.
- O texto do erro não entra no relatório JSON/Markdown (I-03).
- Se nenhum prompt completar, `benchModel` propaga o erro do provider e nenhum relatório é gravado.
- O Markdown traz `Sucesso` por modelo (`80% (4/5)`) e `Sucesso agregado: N% (completed/total)`.
- O `summary` do relatório traz `fastest` (menor p50), `cheapest` (menor custo/1k out; ignora `null`) e `highestSuccessRate`; empate fica com o primeiro resultado e lista vazia devolve `null` nos três.
- O JSON do relatório usa `schema: 2`; a v1 não tinha `successRate`, `completed`, `total` nem `summary`.
- Relatório v1 (sem `successRate`/`completed`/`total`/`summary`) renderiza `n/d` nesses campos; nenhum vencedor de success rate é inferido.

### Filtro de provider/modelo

`--models` aceita termos separados por vírgula. Termo sem `/` casa o provider exato; termo com `/` é substring de `provider/model`. Filtro vazio, ausente ou só com espaços/vírgulas seleciona todos os modelos ativos.

| Filtro | Seleciona |
|---|---|
| `nvidia` | Modelos cujo provider é exatamente `nvidia` (não pega id de outro provider) |
| `openrouter/llama` | Modelos do `openrouter` cujo id contém `llama` |
| `/llama` | Qualquer provider cujo id contém `llama` |
| `nvidia,openrouter` | União dos dois providers |

A mesma regra vive em `filterModels`/`selectBenchModels` (`src/eval/bench.ts`): o CLI usa `selectBenchModels`, e testes e matriz usam o mesmo predicado. `--require-filter` (usado no nightly) falha quando o filtro não tem termo alfanumérico ou quando a seleção cobre todos os modelos ativos.

## CI

`bench.yml`:

- Manual: `workflow_dispatch` com os inputs `models` (filtro) e `runs` (repetições); sem `models` roda todos os modelos ativos.
- Nightly opcional: `schedule` às 03:00 UTC; o job só executa com a variable de repositório `BENCH_NIGHTLY=true`.
- No nightly, o filtro vem da variable `BENCH_MODELS`, na mesma sintaxe de `--models`; o job usa `--require-filter` e falha se o filtro não recortar o registro (vazio, só espaços/vírgulas, `/` ou união que cobre todos), em vez de rodar todos os modelos contra quota real.
- `NVIDIA_API_KEY` e `OPENROUTER_API_KEY` só existem nesse workflow; PR nunca recebe provider real.

`ci.yml`:

- `eval` é gate de merge (`docs/ci.md`), não check required de branch protection: roda em Ubuntu com threshold 0.85 e golden dataset mock.
- `bench-mock` roda a matriz OS × filtro (`nvidia`, `openrouter`); cada perna executa o caso de filtro correspondente via `-t`, sem quota de provider.

## Referências

#59, F5-4, I-03, `docs/ci.md`, `docs/roadmap-complementar.md`.
