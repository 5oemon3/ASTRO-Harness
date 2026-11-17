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

## `web_fetch`

`{url, maxLength? (50000), format? ("markdown"|"text")}` baixa uma URL `http(s)` e devolve o texto limpo. `outboundUrlProblem` recusa loopback, faixas privadas e hosts de metadados; cada hop de redirect (máximo 3) é revalidado pelo literal e pelos endereços resolvidos via DNS. HTML remove as tags reais primeiro e só então decodifica entidades; todo `<` seguido de tag-like é escapado (`&lt;div>`), inclusive dentro de outro trecho ou sem `>`, então markup codificado com `href`/`onerror` não vira tag, e comparações como `a < b` ficam intactas. `href` é decodificado até estabilizar, removendo todo C0 (tab/LF/CR inclusive) a cada passe, antes de checar uma allowlist de schemes (`http`/`https`/relativo), fechando double/triple-encoded e controles entre entidades, e `script`/`style`/`iframe`/`object`/`embed`/`noscript`/`svg`/`template`/`base` e handlers são removidos; bloco `script`/`style` sem fechamento (corte do cap) é descartado até o EOF, então o cap não devolve JS/CSS cru (#57). Títulos, listas e links são preservados em markdown. A leitura é limitada a `maxLength * 4` bytes (teto de 1MB) antes do corte; conteúdo não textual é recusado, `text/plain` volta como está e `Content-Type` ausente é tratado como HTML. Audit `web.fetch {url, status, contentLength, duration}` sem query/hash.

## Opt-in de dev (saída)

`ASTRO_ALLOW_PRIVATE_URLS=1` (por processo e filhos, só dev) libera loopback, RFC1918, ULA e faixas reservadas (`0.0.0.0/8`, multicast) nas URLs validadas por `outboundUrlProblem`; CGNAT (100.64/10), metadados (ULA `fd00:ec2::/64` e `fd20:ce::/64`, IPv4 mapeado e hosts conhecidos) e link-local continuam bloqueados. `webSearch.baseUrl` usa só `urlProblem` (qualquer provider): aceita loopback/RFC1918/ULA; `baseUrl` de provider plugin em `astro.config.json` não passa por `outboundUrlProblem` (limite pré-existente).
