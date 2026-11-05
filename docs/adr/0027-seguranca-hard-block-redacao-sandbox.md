# ADR-0027: segurança — classes de path, hard-block, redação e sandbox

- Status: aceita
- Data: 2026-11-05
- Issue: #384
- Decisões relacionadas: ADR-0019, ADR-0023, ADR-0026, I-01, I-03, I-11

## Contexto

O classificador atual (`src/permissions.ts`) trata `.astro`/`.git`, nomes críticos e padrões de segredo, mas a matriz de permissões ainda libera `read_critical`/`critical_write` em `bypass`; `redactSecrets` cobre prefixo/env conhecidos, não entropia; `run_command` trunca antes de redigir; e o sandbox não monta hard-block. O ADR-0026 depende deste para implementar leitura de anexo com path seguro. Redação é defesa em camadas, nunca cobertura: lista de padrões não substitui bloqueio de path.

## Decisão

**Classes e precedência.** `hard-block > sensitive > normal`, sobre o `realpath`, com case-folding em win32/darwin e `~` expandido; symlink resolvido antes. Sobreposição entre as listas default é resolvida pela precedência. Entrada **literal** de allowlist (sem glob) ou qualquer entrada de `allow-critical` que sobreponha o tier imutável é rejeitada com `allow_invalid`, e o CLI sai antes de iniciar o run. Match de **glob** em tier de hard-block invalida a entrada inteira de `allow-sensitive`, que é ignorada (fail-closed) com aviso e audit, sem abortar; o mesmo vale para literal inexistente no load.

- **hard-block imutável (sem override):** `.env` e `.env.*` exceto os templates nomeados abaixo; `.ssh/`; `id_rsa`; `id_ed25519`; `*.pem`; `*.key`; `.aws/credentials`; `.gnupg/`; `.kube/config`; `$ASTRO_HOME/keys/`; `vault.json`; `auth.json`; `astro.config.json`; `~/.netrc`; `~/.npmrc`; `~/.docker/config.json`; `~/.config/gh/hosts.yml`; `*.p12`; `*.pfx`; `*.jks`; `*.kdbx`; `.astro` do cwd; `.git`; `protectedPaths`; todo `$ASTRO_HOME` fora do `artifactRoot`. Nenhuma tool lê, escreve, lista conteúdo ou faz diff; vale em **todos** os modos, `bypass` incluído. Negar cita path e classe, nunca conteúdo.
- **hard-block configurável (padrão, liberável por path exato):** caminhos que casam `CRITICAL_PATH_PATTERN` (`src/permissions.ts`, referência por símbolo, sem transcrever o regex) e não estão no tier imutável. Hard-block por padrão; só `allow-critical` os reclassifica.
- **sensitive:** `.env.example` e nomes terminados em `.env.example`, `.example`, `.sample`, `.template` ou `.dist`, além do que o usuário declarar em `allow-sensitive`. Saída sempre redigida por padrões + entropia; nunca verbatim.
- **normal:** sem gate de classe; a redação de padrões continua em toda saída e diff (abaixo).

**Isenção única (ADR-0026).** O `artifactRoot` validado é o único subtree isento do hard-block, só como destino de artefato e leitura por `ref` revalidado (hash, sessão/linhagem, raiz revalidada); nunca fonte de `/attach`, drag-drop, `read_file` ou shell. O regime da raiz (dedicação, permissão, TTL/GC, revalidação) é dono do ADR-0026; aqui fica só a isenção e a comparação por segmento no realpath (`isWithin`/`relative` sem `..`, nunca `startsWith`).

**Liberação.** `allow-sensitive` (globs, até 64 entradas) e `allow-critical --i-understand` (realpath absoluto de arquivo, sem diretório, basename ou glob, até 64 entradas; `--i-understand` obrigatório em toda invocação) vêm **só de flag de CLI**; não há arquivo de config de segurança nesta versão (schema futuro é dono do ADR-0028). `allow-sensitive` só promove para sensitive e nunca libera hard-block. `allow-critical` é avaliada antes da classificação, só no tier configurável; entrada inválida (formato, limite, diretório, glob) ou que case o tier imutável falha `allow_invalid`, e o CLI sai antes do run; entrada que não casa o tier configurável é ignorada com aviso. Path liberado vira `normal` (só padrões, sem entropia). Cada liberação emite `security.allowlist_applied` no load (entrada e resultado) e por match (realpath resolvido e classe), com motivo fixo da regra e origem (flag), sem segredo.

**Redação.** Vale para **toda** saída e **todo** diff: `read_file` aplica padrões sempre e padrões + entropia em sensitive (`security.entropyThreshold`, dono ADR-0028/`src/config.ts`); entropia é best-effort e, quando inconclusiva, a leitura é **negada** (fail-closed), nunca devolvida sem redação; `run_command` redige stdout/stderr **antes** do truncamento, usa só padrões (entropia em shell gera falso positivo em hash/UUID/base64) e grava o artefato do `output-limit` já redigido; `grep`, `lsp`, web, saída de tool e compactação redigem antes do contexto/prompt/sumário. Escrita em sensitive segue a matriz como `critical_write` (aprovação fora do `bypass`) e o diff sai redigido. Segredo nunca em contexto, log, audit, ledger ou memória (I-03). A exceção de imagem não redigível é a única do I-03 e segue o ADR-0026.

**Diffs.** hard-block (imutável e configurável): nenhum conteúdo; a timeline grava `[arquivo crítico alterado — conteúdo omitido]` com path e tool call na tentativa negada. Sensitive: diff linha a linha redigido. Normal: redigido por padrões.

**Shell e sandbox.** Shell exige sandbox (I-11). A imagem carrega **só** toolchain (`bun`, `tsc`) e dependências instaladas a partir de `package.json`/lockfile — **nunca** código do projeto nem item do hard-block; o código vem do bind do cwd, o `.dockerignore` espelha a lista de hard-block e um teste de CI prova a ausência de cópia na imagem (build fixado por digest, reportado no `doctor`). O container roda com `--tmpfs /tmp` e cache/HOME gravável para `bun test` e `bun run typecheck` funcionarem como hoje. O sandbox monta, para cada item do hard-block **dentro do cwd** (recursivo, qualquer profundidade, inclusive submódulos), uma máscara conforme o `stat` — arquivo vira arquivo vazio `ro`, diretório vira árvore vazia `ro` — e reavalia o cwd a cada execução; item criado depois do start fica fora do mount (as fontes são vazias, então não há conteúdo pré-existente a vazar). `.git` é mascarado do mesmo jeito (arquivo em worktree, árvore em repo): **git não roda no sandbox**, nem para leitura, e o gitdir de worktree não é montado; worktree e commits são do usuário no host. O `artifactRoot` também é mascarado onde estiver (nunca é fonte de shell). Itens fora do cwd (`~/.ssh`, `.aws`, `$ASTRO_HOME/keys`) não são montados; o hard-block vale no dispatch e o `doctor` declara a ausência de mount. As fontes das máscaras são criadas pelo harness com 0700 no POSIX ou ACL owner-only no Windows, fora do cwd e do `artifactRoot`. O scan de substring cobre todos os itens do hard-block e é defesa em profundidade/UX, nunca a fronteira. Com `sandbox: false`, `run_command` **não executa** (`sandbox_required_for_shell`, I-19); as file tools mantêm hard-block + redação, e o boot/banner avisa.

**Erros.** `path_hard_blocked`, `allow_invalid`, `sandbox_required_for_shell` — classes tipadas (donos `src/permissions.ts`/`src/tools/`), mensagem em português: path relativo dentro do cwd, `<fora do cwd>` para path externo, entrada crua quando não há realpath (glob/diretório/relativo), e o modo em `sandbox_required_for_shell`; nunca ecoa conteúdo.

## Consequências

- Ganho: classes explícitas, bloqueio impossível de contornar por modo e redação em toda saída; ADR-0026 destravado.
- Custo: `sandbox: false` perde o shell e o agente não executa git (worktree/commit do usuário); imagem/toolchain com cadeia de suprimentos; listas/entropia no config; mounts no sandbox; testes POSIX/Windows.
- Invariantes afetadas: I-03 (dono do texto), I-11 (path/sandbox), I-01 (allowlist); I-19 (parada graciosa) nas recusas.

## Alternativas descartadas

- Redação como cobertura: não detecta segredo sem padrão conhecido.
- `allow-critical` removendo o hard-block imutável: transforma config clonada em bypass.
- Gate de git dentro do sandbox: flags, hooks e gitdir de worktree reabrem leitura de conteúdo.
- Entropia no `run_command`: falso positivo em hash/UUID/base64.
- Só mount, sem hard-block no dispatch: arquivos fora do container escapam.
- Manter `bypass` lendo caminho crítico: o modo vira bypass de I-03.
