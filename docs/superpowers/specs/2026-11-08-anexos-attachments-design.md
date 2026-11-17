# Spec — anexos (ADR-0026, #392)

> Resumo: modelo tipado de anexo, paths/limites, store de imagem, superfícies REPL+TUI e ciclo de vida, em 4 fatias.
> Status: aprovado para implementação · Data: 2026-11-08 · Base: `main` @ `8070a98` · ADR: `0026-anexos-modelo-limites-paths.md`

## Objetivo

Implementar o ADR-0026 por inteiro em fatias sequenciais. Um anexo nasce **só** de superfície humana (`/attach`, `/paste`); nunca de modelo, tool, plugin, skill ou subagente (I-01/I-02). `@path` no editor continua sendo só menção.

**Fora de escopo:** event bus/timeline (ADR-0020/0021 não implementados) e imagem do clipboard (adiada pelo ADR).

## Modelo (`src/attachments/model.ts`, puro)

```ts
type AttachmentKind = "text" | "image" | "directory";

interface Attachment {
  kind: AttachmentKind;
  path?: string;      // realpath canônico; ausente só p/ imagem reidratada por ref
  name: string;
  sizeBytes: number;  // payload que entra no prompt
  mediaType: string;  // text/*, image/png|jpeg|webp|gif, inode/directory
  range?: { start: number; end: number };  // 1-based, só texto
  ref?: string;       // opaco, só imagem persistida
  hash?: string;      // SHA-256 dos bytes gravados, só imagem com ref
}

interface LoadedAttachment extends Attachment {
  data: string;       // texto redigido | base64 | listagem; nunca persistido
}

type AttachmentMeta = Pick<Attachment, "kind" | "name" | "sizeBytes" | "mediaType" | "range" | "ref" | "hash">;
```

- `detectKind(header)`: assinatura PNG/JPEG/WEBP/GIF; senão UTF-8 válido sem NUL → `text/plain`; senão binário rejeitado. SVG é texto.
- `parseRange("10:40", total)`: 1-based inclusivo; `10` = linha 10.
- `dedupeKey()`: texto/diretório `realpath+range`; imagem/clipboard `hash`. Conta uma vez no cap do turno.

| Limite | Valor |
|---|---|
| por anexo | 20 MiB |
| por turno | 40 MiB |
| diretório | 500 entradas após filtros |
| imagem | 25 MPx, 8192 px no lado maior, 20 MiB decodificados |

## Mensagem e providers

`ChatMessage` ganha dois campos **aditivos**; `content: string` não muda (consumido por `context-guard`, `compaction/engine`, `export`, `chat/store`, `agent-session`).

```ts
interface ChatMessage {
  content: string;
  attachments?: AttachmentMeta[];  // metadado persistível
  images?: ImagePart[];            // só runtime: { mediaType, dataBase64 }
}
```

- Texto e diretório são materializados em `content` com cabeçalho `[anexo: <path> (linhas a-b)]`.
- Imagem vai em `images[]` + `attachments[]`; nunca em `content`.
- `openai-compat.ts`: `content: [{type:"text",text},{type:"image_url",image_url:{url:"data:<mt>;base64,<b64>"}}]`.
- `codex-oauth.ts`: `content: [{type:"input_text",text},{type:"input_image",image_url:"data:..."}]`.
- `vision` entra em `CAPABILITY_KEYS` (`src/capabilities.ts`). Mensagem com imagem e modelo sem `capabilities.vision === true` → `vision_unsupported` antes da chamada.
- `context-guard.ts`: custo fixo por imagem (`ceil(bytes/4)`), sem decodificar.

## Paths (`src/attachments/load.ts`)

1. expande `~`, resolve relativo ao cwd;
2. `classify(realpath)` com **`artifactRoot: null`** — a raiz é destino/`ref`, nunca fonte;
3. `hard-block` → `attachment_hard_blocked`, sem override (nem `bypass`);
4. fora do cwd (case-fold win32/darwin) → `confirmOutsideCwd(realpath absoluto)`, callback injetado pela superfície; negado/sem TTY → `attachment_outside_denied` e para (I-19);
5. diretório → listagem não recursiva, 500 após filtros, ocultos só com `attachments.directory.showHidden`;
6. arquivo → header → texto (range, `redactSecrets`, UTF-8; 0 byte ok) | imagem (valida header; 0 byte rejeita) | binário (`attachment_unsupported_binary`);
7. valida limites de anexo e de turno.

`loadPastedText(text)`: clipboard sem path, dedupe por hash.

**Erros tipados** (`AttachmentError`): `attachment_hard_blocked`, `attachment_outside_denied`, `attachment_too_large`, `attachment_turn_too_large`, `attachment_unsupported_binary`, `attachment_image_invalid`, `attachment_artifact_missing`, `attachment_range_invalid`, `attachment_directory_too_large`, `attachment_root_invalid`. Mensagem cita caminho, nunca conteúdo.

## Config (`src/config.ts`, seção `attachments`)

`image.autoResize` (false), `directory.showHidden` (false), `artifactTtlDays` (7), `artifactMaxBytes` (1 GiB). `artifactRoot` **não** é chave de config.

## Store e imagem (`src/attachments/store.ts`)

- `resolveArtifactRoot({flag, env})`: **flag > env > `join(ASTRO_HOME,"attachments")`**; `~` expandido; env vazio/só espaços = ausente; flag `--artifact-root` em `src/cli.ts`.
- `validateArtifactRoot()`: absoluto após expand; ≠ `$ASTRO_HOME`; fora do cwd/worktree/`.git`; não ancestral/descendente de `vault.json`, `providers.json`, `trusted.json`, ledger, sessions, `.astro` do cwd; dedicado (sem arquivo de estado); privado (0700 POSIX / ACL owner-only no Windows).
- Layout: `session-<sha256("session\0"+id)>/` ou `run-<sha256("run\0"+runId)>/`; arquivo = SHA-256 dos bytes após `autoResize`; sidecar `meta.json` com `{ref,hash,bytes,mediaType,sessionId,lineage,createdAt}`; 0600/0700 no POSIX.
- GC: TTL 7 dias por mtime, só `session-*`/`run-*` com metadado do harness; nunca o ref do turno atual nem arquivo alheio; no teto de 1 GiB **rejeita o novo anexo**.
- Reidratação revalida raiz e SHA-256; ausente/expirado → erro tipado e parada.
- Aprovação por turno: um lote com path/bytes/MPx e "não redigível"; qualquer rejeição rejeita o turno; sem TTY nega e para. Audit `attachment.approved` com `ref`/hash/bytes, sem conteúdo.

## Superfícies

- `/attach <path> [start:end]`; sem args lista pendentes; `/detach [n|all]` remove antes do envio; `/paste` texto do clipboard.
- REPL: `src/chat/commands.ts` + `src/chat/repl.ts`. TUI: `src/tui/editor.ts` + `src/tui/app.tsx`, completion de `/attach` pelo fuzzy de `src/tui/files.ts`; `Ctrl+V` de texto continua no prompt.
- Pendentes aparecem com nome/tamanho e limpam após o turno.

## Ciclo de vida

`chat/store.ts` e `chat/export.ts` guardam só metadado; `resume.ts`/`session-api.ts` reidratam imagem do store e validam hash; `doctor` mostra realpath da raiz, motivo de invalidez, TTL e último GC. Compactação descarta bytes de imagem; o metadado permanece.

## Fatias (4 PRs, RED antes de GREEN)

| Fatia | Entrega | RED |
|---|---|---|
| 1 | modelo + paths + limites + config | `tests/attachment-model.test.ts`, `tests/attachment-load.test.ts` |
| 2 | texto ponta a ponta (REPL+TUI) | `tests/attachment-commands.test.ts`, `tests/attachment-session.test.ts` |
| 3 | imagem + store + providers | `tests/attachment-artifact.test.ts`, `tests/attachment-vision.test.ts` |
| 4 | resume/export/doctor/audit | `tests/attachment-resume.test.ts`, `tests/attachment-doctor.test.ts` |

## Critérios de aceite

- [ ] Anexo só por `/attach`/`/paste`; `@path` não lê.
- [ ] Hard-block sem override; fora do cwd exige confirmação; sem TTY nega e para.
- [ ] Limites de 20/40 MiB, 500 entradas, 25 MPx/8192 px aplicados com erro tipado.
- [ ] Texto redigido antes de entrar no prompt.
- [ ] Imagem só em modelo com `capabilities.vision`; wire correto nos dois providers.
- [ ] Store: flag>env>default, raiz validada, hash verificado, TTL/GC, teto de 1 GiB.
- [ ] Aprovação de imagem por turno, uma por lote, audit sem conteúdo.
- [ ] Resume reidrata e falha tipado se ausente/expirado; `doctor` reporta.
- [ ] Store/export/ledger só metadado; sem segredo em log/erro/prompt (I-03).
- [ ] `bun test` e `bun run typecheck` verdes em cada fatia.
