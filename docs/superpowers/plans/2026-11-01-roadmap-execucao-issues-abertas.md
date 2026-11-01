# Roadmap de execução — issues abertas (Harness 0.2)

> Resumo: 17 issues abertas (10 no milestone "Harness 0.2"); roadmap em 5 ondas por prioridade × complexidade, com protocolo de 2 revisores (segurança + correctness) antes de cada merge.

**Data:** 2026-11-01 · **Base:** `main` @ `224c7e4` · **Milestone:** Harness 0.2 (10 issues no milestone, 17 abertas no total). #112/#137/#148 foram fechadas por #314/#315/#317 e saíram deste plano.

## 1. Análise das issues abertas

| # | Título | Fase | Prioridade | Risco | Complexidade | Depende de | O que implementa |
|---|--------|------|-----------|-------|--------------|------------|------------------|
| #135 | Loop, checkpoint, no-progress guard | C0 | alta | seguranca | Alta | S-10, S-14, ADR-0014 | Loop robusto: maxTurns, checkpoint 80%, guarda no-progress, parada segura (I-19) |
| #265 | Tool/file approval prompt TUI+REPL | C0 | alta | — | Média | #259 (done) | mesmo prompt de permissão em TUI e REPL (yes/no/session/once) |
| #311 | Credential vault (frente B) | C0/B | alta* | seguranca | Alta | ADR-0019 (done) | `~/.astro/vault.json`, DPAPI/0600, refs `vault:<id>` |
| #267 | Trusted folders | C0 | media | seguranca | Média | #259 (done) | trust por pasta em `~/.astro/trusted.json`, prompt no 1º open, revogável |
| #270 | Permission mode indicator TUI | T2 | media | — | Baixa | #259 (done) | modo ativo sempre visível no footer/banner, alerta em `bypass` |
| #271 | /mode slash command | T2 | media | — | Baixa | #259 (done) | `/mode` lista/troca bypass/allow-edits/ask, auditado |
| #273 | /config screen TUI | T2 | media | — | Média | #259, #267 | tela `/config` com maxTurns, custos, modo, trusted folders |
| #63 | T2 TUI com Ink | T2 | alta | — | Alta | T1 (done) | TUI completa: painéis, comandos de barra, keybinds, persistência |
| #64 | T3 UX refinements | T3 | media | — | Alta | #63 | streaming, temas, toasts, diff viewer, session picker, acessibilidade |
| #65 | T4 sessões e memória (prep) | T4 | baixa | — | Alta | T1, T2 | modelo de sessão + API + SQLite + hooks (sem memória multi-agente) |
| #58 | C4 Multi-agente e perfis | C4 | media | — | Alta | F-02..F-26, #128 | permissões por agent, tool `task`, roteamento cheap/strong |
| #57 | C3 Web tools | C3 | baixa | — | Média | F-00, F-09, F-11 | `web_search` + `web_fetch` com backends, rate limit, untrusted |
| #59 | C5 Qualidade e benchmark | C5 | baixa | — | Média | F-14, F-15 | golden expandido, bench com success rate, CI matriz, docs |
| #61 | C7 Organização/segurança | C7 | baixa | seguranca | Alta | C1–C6 | refatoração modular, política de segurança, `astro doctor` |
| #316 | Implementation guide doc | docs | — | — | Baixa | — | guia consolidado de implementação (fechada pelo PR deste plano) |
| #138 | v2 backlog umbrella | C0 | baixa | — | Nenhuma | — | tracking apenas; sem implementação |
| #230 | Execution roadmap (tracking) | docs | alta | — | Nenhuma | — | issue de tracking do ciclo; estado vive aqui e no milestone |

\* #311 sem label de prioridade, mas ADR-0019 + risco de segurança a colocam efetivamente como alta.

## 2. Matriz prioridade × complexidade

```
                 Complexidade
                 Baixa        Média         Alta
              ┌────────────┬─────────────┬─────────────┐
   Alta       │ #316       │ #265        │ #135, #63   │
 Prioridade   │            │ #267, #273  │ #311       │
              ├────────────┼─────────────┼─────────────┤
   Média      │ #270, #271 │             │ #64, #58    │
              ├────────────┼─────────────┼─────────────┤
   Baixa      │            │ #57, #59    │ #65, #61    │
              └────────────┴─────────────┴─────────────┘
   Tracking: #230, #138 (sem implementação)
```

## 3. Roadmap em 5 ondas

### Onda 1 — Quick wins e docs (semana 1) — CONCLUÍDA

Objetivo: fechar bugs pequenos e atualizar docs, sem risco.

| Ordem | Issue | Ação | Estado |
|-------|-------|------|--------|
| 1 | #112 | fix parser skills over-indent | merged (#314) |
| 2 | #137 | refresh invariants.md coverage | merged (#315) |
| 3 | #148 | fix MCP backoff counting | merged (#317) |
| 4 | #316 | implementation guide doc | neste PR (#318) |

**Critério de saída da onda:** atendido — 3 PRs mergeados com CI verde, nenhum risco novo; #316 fecha com este PR.

### Onda 2 — Segurança e robustez do núcleo (semanas 2–3)

Objetivo: fechar os itens `risco:seguranca` de prioridade alta/média.

| Ordem | Issue | Ação | Dependência |
|-------|-------|------|-------------|
| 4 | #135 | loop + checkpoint + no-progress guard | S-10/S-14 já entregues? verificar |
| 5 | #265 | approval prompt unificado TUI+REPL | #259 done |
| 6 | #267 | trusted folders | #259 done |
| 7 | #311 | credential vault B.1 | ADR-0019 done |

**Ordem interna:** #135 primeiro (maior risco operacional), depois #265/#267 (UX de segurança), #311 por último (maior mudança, isola em frente própria).

### Onda 3 — TUI: modo de permissão e config (semana 3–4)

Objetivo: entregar os comandos de governance visíveis na TUI.

| Ordem | Issue | Ação | Depende de |
|-------|-------|------|------------|
| 8 | #270 | indicador de modo sempre visível | #259 done |
| 9 | #271 | comando `/mode` | #270 |
| 10 | #273 | tela `/config` | #267, #271 |

### Onda 4 — TUI completa e refinamentos (semanas 4–6)

| Ordem | Issue | Ação | Depende de |
|-------|-------|------|------------|
| 11 | #63 | T2 TUI completa (se ainda houver residual vs. #230) | T1 done |
| 12 | #64 | T3 streaming/temas/diff viewer | #63 |

> Nota: #63/#64 podem estar parcialmente entregues (TUI já existe em `src/tui/`). Auditar antes: o que #230 marca como residual em Block 1.

### Onda 5 — Capacidades e polimento (semanas 6–8)

| Ordem | Issue | Ação | Depende de |
|-------|-------|------|------------|
| 13 | #58 | C4 multi-agente + perfis | ondas 1–2 |
| 14 | #57 | C3 web tools | F-00/F-09/F-11 |
| 15 | #59 | C5 qualidade/benchmark | #57, F-14/F-15 |
| 16 | #65 | T4 sessões/memória (prep) | #63 |
| 17 | #61 | C7 organização + doctor (por último) | todas as anteriores |

**Tracking (não implementar agora):** #230, #138.

## 4. Protocolo de execução por issue

Seguindo `docs/workflow.md` + regra do dono (2 revisores):

1. **Issue** — confirmar que existe com critério de aceite testável. Se não existir, criar antes de começar.
2. **Branch** — `git worktree add .worktrees/<tipo>-<n>-<slug> -b <tipo>/<n>-<slug> origin/main`.
3. **RED→GREEN** — teste que falha primeiro (`test:`), depois implementação (`feat:`/`fix:`), ambos com `Refs #n`.
4. **PR** — draft enquanto trabalha; `Closes #n`; alvo 200 linhas, teto 400.
5. **2 revisores em paralelo, contexto fresco:**
   - **Revisor A (segurança):** I-03 (segredo), I-01 (allowlist), I-11 (caminho/sandbox), vazamento em log/audit/ledger, bypass de permissão. Achado de segurança **sempre bloqueia**.
   - **Revisor B (correctness/contrato):** testes, tipos, edge cases, critérios de aceite da issue, docs atualizados.
   - Ambos postam `Revisão: APPROVE` ou `Revisão: REQUEST_CHANGES` no PR. Bloqueante cita `arquivo:linha` + cenário concreto.
6. **Merge** — squash, CI verde, 2 aprovações, docs no mesmo PR.

## 5. Gate de release (npm) — inalterado de #230

- [ ] Todas as ondas 1–4 mergeadas (TUI + providers + context/cost)
- [ ] `bun test` verde em 10 runs consecutivos; `bun run typecheck` verde
- [ ] `bun run build` + `bun run smoke` verdes
- [ ] `npm pack` em dir limpo: `astro --help`, TUI abre, mock provider funciona
- [ ] Versão bumpada e publicada como `@umtioai/astro-harness`
- [ ] #58 e #138 explicitamente fora do gate

## 6. Riscos e mitigações

| Risco | Issue afetada | Mitigação |
|-------|--------------|-----------|
| #135 depende de S-10/S-14 não entregues | #135 | verificar estado real antes de iniciar; se pendente, abrir issue de dependência |
| #311 muda modelo de credencial (breaking) | #311 | frente B isolada; B.1 só módulo + storage, B.2/B.3 depois |
| #63/#64 podem estar parcialmente feitos | #63, #64 | auditar residual vs. #230 Block 1 antes de abrir PR |
| 2 revisores no mesmo PR podem travar | todas | revisores em paralelo, não sequencial; autor corrige e re-review só no commit novo |
| Onda 5 muito grande para o ciclo 0.2 | #58, #61 | #58 e #61 podem ser empurrados para 0.3 se o gate npm apertar |
