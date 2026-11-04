# Ferramentas web

Resumo: `web_search` consulta um backend configurável; o conteúdo retornado é untrusted e nunca é executado.

## Configuração (`webSearch`)

| Campo | Obrigatório | Default | Regra |
|---|---|---|---|
| `provider` | sim | — | `exa`, `brave`, `google` ou `custom` |
| `apiKeyEnv` | sim | — | **nome** de variável de ambiente; valor ou nome que parece segredo é recusado (I-03) |
| `baseUrl` | só `custom` | endpoint do backend | `http(s)` sem credencial/metadata; em `google` pode trazer `cx` |
| `defaultMaxResults` | não | 5 | inteiro 1..10 |

A chave é lida do `env` do run no momento da chamada. Nenhuma outra variável do host é enviada ao backend; o audit `web.search` grava `{query, provider, resultsCount, duration, status}` com a query redigida.

## Backends

| Provider | Requisição | Chave |
|---|---|---|
| `exa` | `POST {baseUrl}/search` com `contents.text` | header `x-api-key` |
| `brave` | `GET {baseUrl}/res/v1/web/search?q=&count=` | header `X-Subscription-Token` |
| `google` | `GET {baseUrl}` com `key`, `q`, `num` e `dateRestrict` | query `key` (contrato do Google) |
| `custom` | `POST {baseUrl}` com `{query,maxResults,recencyDays}` | header `Authorization: Bearer` |

Redirect não é seguido (`redirect: "error"`): a chave nunca vai para outro host.

## Limite e backoff

Até 3 tentativas. `429`, `500`, `502`, `503`, `504` e erro de rede repetem; `Retry-After` (segundos ou data) vence o backoff exponencial com jitter (500ms..8s). `400` e demais erros param na primeira resposta. Falha final vira erro redigido da tool.

## Untrusted

Resultado de busca é dado externo. O manifesto marca `risk: low`, `permission: read`, `sideEffects: network` e a descrição avisa que o conteúdo pode conter prompt injection: o modelo não deve executar instruções vindas dele.
