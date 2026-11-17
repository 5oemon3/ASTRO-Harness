# Doctor

Diagnóstico local do ASTRO: versões, dependências, config, credenciais por nome e disco; `--online` acrescenta o health dos providers (F6-6).

| Cobre | Não cobre |
|---|---|
| `astro doctor [--json] [--fix] [--online]`, checks e formato do JSON | Corrigir config, credenciais ou rede por conta própria |

## Comando

| Flag | Efeito |
|---|---|
| nenhuma | Checks offline, determinísticos, sem rede. |
| `--json` | Emite só o payload JSON (uma linha por check fica de fora). |
| `--fix` | Cria `$ASTRO_HOME` quando ausente (0700); nunca cria a raiz de artefatos e recusa caminho relativo, com `..`, link simbólico ou que seja arquivo. |
| `--online` | Roda `runHealthCheck` (F6-6): um check por provider, o cofre (`vault`) e um agregado `online`. Sem a flag nenhuma chamada de rede acontece. |

## Checks

| Check (exibição) | `name` |
|---|---|
| `bun`, `node` | `bun`, `node` |
| `dependências`, `dist` | `dependencies`, `dist` |
| `config`, `config global` | `config`, `configGlobal` |
| `credencial <id>` | `credential:<id>` |
| `mcp`, `skills` | `mcp`, `skills` |
| `astro home`, `anexos`, `disco` | `astroHome`, `attachments`, `disk` |

Segredo nunca entra na saída: `name`, label e detalhe passam por `redactSecrets` (I-03). `name` é slug estável; `label` é só exibição.

## `--online`

O health usa o mesmo caminho de `astro health`: `GET {baseUrl}/models` com a credencial do ambiente, `redirect: "error"` e timeout de 5s por provider. Cada `HealthCheck` vira um check, mais o agregado:

| Health | Doctor | Nível |
|---|---|---|
| `provider:<id>` `ok` | `provider:<id>` | `ok`, com latência |
| `provider:<id>` `down` | `provider:<id>` | `error` (`fail` no alias) |
| `vault` | `vault` (label `cofre`) | `ok`; só metadados |
| agregado | `online` | `ok` ou `error` |

`degraded`/`down` do health só existem com provider fora, e ambos viram `error`: o agregado `online` nunca é `warn` e `degraded` (ex.: credencial ausente) sai com exit 1.

`--online` usa `loadEffectiveConfig`: camada global (`$ASTRO_HOME/config.json`) e profile do ambiente contam. Se nenhum provider sobrar, `online` vira `ok` sem rede; config de projeto inválida vira `warn`; falha inesperada vira `online` `error`, nunca exceção.

## Payload `--json`

```json
{
  "schema": "doctor/v1",
  "checks": [{ "name": "bun", "status": "error", "message": "1.3.9 abaixo do mínimo >=1.4.0", "level": "fail", "label": "bun" }],
  "summary": { "ok": 0, "warn": 0, "fail": 1 }
}
```

| Campo | Contrato |
|---|---|
| `name` | slug estável: `bun`, `node`, `dependencies`, `dist`, `config`, `configGlobal`, `astroHome`, `attachments`, `skills`, `disk`, `mcp`, `credential:<id>`, `provider:<id>`, `vault`, `online` |
| `status` | `ok`, `warn` ou `error` (#61) |
| `message` | detalhe legível; vazio sem detalhe |
| `label` | exibição; pode mudar sem quebrar scripts |
| `level`, `detail` | aliases de `status`, `message`; `error` aparece como `fail` |
| `summary` | contagem por `level`: `ok`, `warn`, `fail` |
| `fixes` | só com `--fix`; `applied`/`errors` redigidos |

Exit code: `0` sem `fail`; `1` com algum check falho (inclusive provider fora) ou erro de `--fix`.

Referências: I-03, #61, F6-6.
