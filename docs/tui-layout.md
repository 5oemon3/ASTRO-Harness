# Layout da TUI

Onde cada informação da TUI vive: header de identidade, footer de números, erro com próximo passo e log sob demanda (#480).

## Princípios

- Uma informação, um lugar. Se o header mostra, o footer não repete.
- Cor tem significado: vermelho é erro ou risco, amarelo é aviso, cinza é estado.
- Silêncio por padrão: nada é reimpresso; o que já foi dito vai para `/log`.

## Antes e depois

| Elemento | Hoje | Depois |
|---|---|---|
| Header | Caixa com versão, provider, modelo, endpoint, estado e modo; pode passar de 80 colunas | Uma linha sem caixa: versão, provider/modelo e saúde |
| Footer | Repete provider, modelo, saúde e modo; mostra `0 turno(s)`, `0/0 tokens`, `n/d` e nenhum orçamento quando não há | Só campos com valor; modo sempre; bypass em vermelho |
| Erro | Linha vermelha sem saída + toast com o mesmo texto | Linha vermelha com próximo passo, uma vez, sem toast |
| Estado | Aviso reimpresso a cada turno e às vezes em toast | Uma linha cinza, uma vez por sessão |
| Progresso | `pensando…`, sem passo | `pensando… passo n/max` |
| Status do turno | Entrada `[modelo] N step(s) · tokens · total` na conversa + toast | Só em `/log`; o footer já tem os números |
| Endpoint | No header, competindo com modelo | `/log`, no cabeçalho da sessão |
| Modo | No header e no footer | Só no footer; bypass também pinta a borda do input |

## Header

Formato: `ASTRO v<versão> · <provider>/<modelo> · <saúde>`

| Caso | Linha | Colunas |
|---|---|---|
| Par mais longo do catálogo: `nvidia/meta/llama-3.3-70b-instruct` | `ASTRO v0.1.0-alpha.4 · nvidia/meta/llama-3.3-70b-instruct · ok` | 62 |
| Limite sintético: provider `openai-compatible` (sem modelos) com o modelo mais longo | `ASTRO v0.1.0-alpha.4 · openai-compatible/meta/llama-3.3-70b-instruct · ok` | 73 |
| O mesmo, sem check | `… · n/d` | 74 |
| O mesmo, provider fora | `… · down` | 75 |

- Teto de 80 colunas. Versão, provider, modelo e saúde são os únicos campos.
- Acima de 80, o modelo é cortado no meio com `…` até sobrar 8 colunas para ele; se ainda passar, o provider é cortado no meio. A saúde nunca é cortada e a linha nunca quebra.
- Um id de provider pode chegar a 64 colunas (limite do slug); é por isso que o corte do provider existe, mesmo sem caso no catálogo.
- Saúde é `ok`, `n/d` ou `down`; `down` em vermelho, `n/d` em cinza.
- Endpoint sai do header e aparece no cabeçalho da sessão em `/log`: é dado de diagnóstico, não de estado. A versão fica porque é o primeiro dado de um bug report.
- A borda da caixa sai; a cor do texto segue a saúde.

## Footer

Formato: `pasta · N turno(s) · in/out tokens · custo · orçamento · modo`

| Campo | Quando aparece |
|---|---|
| pasta | Sempre; `~` para o home |
| turnos | Só com `N > 0` |
| tokens | Só quando `in + out > 0` |
| custo | Só quando o preço é conhecido; sem `n/d` |
| orçamento | Só quando há orçamento configurado; vermelho no teto, amarelo no aviso |
| modo | Sempre: `ask`, `auto` ou `bypass` |

- `bypass` sai em vermelho e pinta a borda do input de vermelho; é o único modo com cor.
- Nenhum campo do header reaparece aqui.

## Erro

Formato: `erro: <mensagem> · <próximo passo>`, em vermelho, uma vez, na ordem em que aconteceu.

| Classe | Próximo passo |
|---|---|
| `auth` | `revise a credencial com /provider` (ou `defina <VAR> no ambiente`) |
| `hard_quota` | `troque de modelo com /model` |
| `transient_rate_limit` | `aguarde e repita; o retry já tentou` |
| `network_timeout` | `repita; se persistir, aumente providers.<nome>.timeoutMs` (#475) |
| `outage` | `repita ou troque com /model` |
| `invalid_request` | `ajuste o pedido; /help lista os comandos` |
| configuração inválida | `rode astro doctor` |
| tool negada | `ajuste permissions.tools ou aprove a chamada` |
| sem provider | `configure com /provider` |

- Mensagem continua redigida (I-03); o próximo passo nunca repete segredo nem URL com chave.
- Erro fatal encerra a sessão depois de imprimir a linha; não vira toast.

## Estado

- Uma linha cinza, uma vez por sessão: provider ativado, modelo trocado, sessão retomada.
- Texto idêntico não se repete na mesma sessão.
- Aviso que muda a resposta (contexto ≥80%) fica amarelo, inline, uma vez; as repetições vão para `/log`.

## Progresso

- `pensando… passo n/max`, com `max = agent.maxSteps`.
- Lacuna conhecida: `ChatSession.send` devolve `steps` só no fim, sem evento de passo. A implementação exige um `onStep` na sessão e precisa de issue própria; este desenho não muda por causa disso.

## /log

| Move para `/log` | Fica inline |
|---|---|
| Cabeçalho da sessão: versão, provider, modelo e endpoint | mensagens do usuário e do assistente |
| `turno concluído · N step(s)` | erro com próximo passo |
| Linha `[modelo] N step(s) · tokens · total` por turno | pergunta de aprovação e diff |
| Transições de saúde do provider | progresso `passo n/max` |
| Avisos de orçamento repetidos | aviso de contexto, uma vez |
| Repetições do aviso de contexto | |
| Detalhe de tool: nome, duração, custo | |

- `/log` abre a tela com o buffer da sessão; `/log <n>` mostra as últimas `n` linhas.
- O buffer é de memória: a fonte durável continua sendo audit/ledger.

## Estados removidos

- Endpoint no header.
- Provider, modelo, saúde e modo repetidos no footer.
- Toast de turno concluído.
- Toast de erro duplicando a linha de erro.
- Linha de status por turno na área de conversa.
- `pensando…` coexistindo com toast de conclusão.

## Como verificar

- Header: a tabela acima é o teste; 62 no par real mais longo do catálogo e 73 no limite sintético, ambos abaixo de 80.
- Footer: nenhum campo do header aparece nele.
- Avisos: nenhum texto aparece nos dois lugares; o de contexto tem a primeira ocorrência inline e as repetições em `/log`.

## Fora de escopo

- Tema, mouse e novos keybinds.
