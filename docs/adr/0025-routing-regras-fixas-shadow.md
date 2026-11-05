# ADR-0025: routing — regras fixas, matriz e shadow

- Status: aceita
- Data: 2026-11-05
- Issue: #380
- Decisões relacionadas: ADR-0007, ADR-0011, ADR-0024, I-06, I-21, C5, F-07

## Contexto

I-06/ADR-0011 exigem escolha reproduzível e registrada; o plano v3.0 acrescenta rótulo de tarefa, matriz de capability, shadow routing, filtro `vision` e política de custo. Um classificador LLM quebraria replay e I-06. `free` não pode virar tag sem violar o vocabulário fechado (D-17/I-21): é preço, não capacidade.

## Decisão

**Classificador fixo.** O rótulo da tarefa é uma função determinística de: tamanho do prompt, presença de imagem, presença de `@path`, tipo de comando e histórico de sucesso por tag no ledger. O rótulo e a escolha vão para o ledger; nenhum LLM participa da decisão. O mesmo rótulo + mesma config + mesma matriz reproduzem a escolha (I-06).

**Camadas.** 1) rótulo da tarefa (regra fixa); 2) matriz de capability F-07 (força por tipo, custo 1M in/out, latência p50/p90 alimentada pelo ledger); 3) política declarativa: teto de custo filtra, modelo fixo respeita, sem restrição escolhe o mais barato que limpa a barra de qualidade — **só depois de C5**. A matriz é curada; o ledger só calibra.

**Visão e free.** Prompt com imagem restringe a pool a modelos com tag `vision` antes da política de custo; se nenhum cabe no teto, o run para com mensagem explícita. `free` é filtro de preço (`pricing.prompt == 0 && pricing.completion == 0`) ou slug `:free`, não tag; `:free` não herda rate limit/contexto do base. Tags continuam papel/capacidade (I-21).

**Shadow.** Duas semanas registrando o que teria sido escolhido (`routing.shadow`) sem alterar a execução; o enforcement só entra após C5 + calibração contra o ledger. O shadow não troca provider/credencial (I-08/ADR-0009).

**Ledger.** `routing.label`, `routing.choice`, `routing.shadow`, `routing.reason` e o snapshot de candidatos; replay usa o rótulo e o snapshot, nunca um classificador. Fallback de profile continua em ADR-0009.

## Consequências

- Ganho: custo/qualidade determinísticos, shadow seguro e replay sem LLM.
- Custo: manter regras/matriz curada; rodar shadow antes de enforcement; campos de routing no ledger.
- Invariantes afetadas: I-06 (replay), I-21 (tags), I-08 (identidade/fallback).

## Alternativas descartadas

- Classificador LLM: não reproduzível (I-06).
- Só o mais barato: ignora a barra de qualidade.
- Modelo fixo sempre: não adapta a tarefa.
- `free` como tag: mistura preço com capacidade (I-21).
