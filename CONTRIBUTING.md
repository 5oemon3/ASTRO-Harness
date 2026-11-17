# Contribuindo com o ASTRO

1. Abra ou escolha uma issue. Toda mudança tem issue.
2. Crie branch `<tipo>/<n>-<slug>` a partir de `main`.
3. Escreva o teste antes do código e registre o RED no PR.
4. Abra PR pelo template, com `Closes #n`.
5. O PR só entra com revisão `APPROVE` e CI verde.

Fluxo completo: [docs/workflow.md](docs/workflow.md). Regras para agentes de código: [AGENTS.md](AGENTS.md).

## Nova tool ou skill

- **Tool:** manifesto com `class` explícita, allowlist do agente, teste de negação (I-01), de confinamento de caminho (I-11) e saída sanitizada sem segredo (I-03). Dependência nova só com ADR.
- **Skill:** `SKILL.md` + sidecar `.sha256`; skill com sidecar divergente é ignorada na carga com warn, skill manual sem sidecar continua carregando. `permissions.tools` ⊆ allowlist do agente; teste de loader para skill inválida.
- Comportamento novo exige teste RED antes do GREEN; docs do dono atualizados no mesmo PR.

## Release

O gate, o bump, a tag e o rollback estão em [docs/release.md](docs/release.md). Nenhuma publicação npm sem o gate completo.
