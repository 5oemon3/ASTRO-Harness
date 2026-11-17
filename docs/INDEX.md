# Mapa da documentação

Objetivo: apontar o documento certo para cada tarefa.

| Cobre | Não cobre |
|---|---|
| Índice dos documentos de `docs/` | Conteúdo dos próprios documentos |

| Arquivo | Quando ler | Linhas |
|---|---|---|
| `AGENTS.md` | Sempre, no início de qualquer sessão | ~110 |
| `docs/CONTRIBUTING-DOCS.md` | Antes de escrever ou revisar qualquer documento | ~25 |
| `docs/implementation-guide.md` | **Primeiro doc ao implementar uma issue**: TDD, fluxo, revisão dupla, padrões de código | ~130 |
| `docs/workflow.md` | Ao abrir branch, commit ou PR (detalhe do fluxo) | ~90 |
| `docs/review-checklist.md` | Ao revisar um PR | ~50 |
| `docs/invariants.md` | Ao tocar em segredo, tool, caminho, custo, aprovação ou auditoria | ~50 |
| `docs/security-threat-matrix.md` | Ao avaliar ameaça, mitigação ou cobertura de segurança (I-01/I-03/I-11/I-15) | ~45 |
| `docs/decisions.md` | Ao precisar do motivo de uma escolha (D-xx) | ~100 |
| `docs/adr/` | Decisão arquitetural nova ou revisão de uma antiga | 1 por arquivo |
| `docs/adr/0029-config-global-home.md` | Configuração global, precedência e migração de `$ASTRO_HOME` (#401) | S1 |
| `docs/superpowers/plans/` | Ao executar uma frente do planejamento; roadmap de issues abertas em `2026-11-01-roadmap-execucao-issues-abertas.md` | 1 por frente |
| `docs/superpowers/specs/` | Antes de implementar uma frente aprovada; anexos em `2026-11-08-anexos-attachments-design.md` (#392) | 1 por frente |
| `docs/roadmap.md` | Histórico das fases concluídas (F0–F7) | ~70 |
| `docs/roadmap-complementar.md` | Itens planejados das camadas 0–3 (F-xx, T, C, P) | ~120 |
| `docs/providers.md` | Ao construir provider, validar credencial ou usar os SDKs | ~90 |
| `docs/skills.md` | Ao criar, instalar, revisar ou invocar uma skill (`/<nome>`) | ~100 |
| `docs/ci.md` | Ao mexer em workflow, investigar falha de CI ou decidir merge | ~35 |
| `docs/release.md` | Ao preparar, publicar ou reverter uma versão npm (#230) | ~150 |
| `docs/mcp.md` | Ao configurar servidores MCP, transports, reconexão ou modelo de confiança | ~60 |
| `docs/web-tools.md` | Ao configurar `webSearch` ou usar `web_search`/`web_fetch` | ~50 |

Referências usadas nos documentos:

- `D-xx`: decisão, em `docs/decisions.md`.
- `I-xx`: invariante, em `docs/invariants.md`.
- `ADR-NNNN`: decisão arquitetural, em `docs/adr/`.
- `#n`: issue ou PR no GitHub.
- `F0`–`F7`: fase concluída, em `docs/roadmap.md`.
- `F-xx`: item da Camada 0, em `docs/roadmap-complementar.md`.
- `T1`–`T4`, `C1`–`C7`, `P-01`–`P-04`: itens das camadas 1–3, em `docs/roadmap-complementar.md`.
