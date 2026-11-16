/** Bootstrap da TUI: Ink é carregado por import dinâmico só neste comando. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ConfigError } from "../config";
import { ProfileManager } from "../provider/profile-manager";
import { NoProviderError, NO_PROVIDER_MESSAGE, loadProjectConfig } from "../provider/profiles";
import { redactSecrets } from "../sanitize-external";
import { trustChoice, trustPrompt } from "../trust";
import { Vault, vaultPath } from "../vault";
import { createSecretHandlers } from "./vault-secret";
import { createApprovalBridge } from "./approvals";
import { createShellRunner, type ShellRunner } from "./shell";
import { getThemeColors, loadTuiConfig } from "./theme";

export interface RunTuiOptions {
  configPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  allowMissingConfig?: boolean;
  /** `allow-critical` da CLI (ADR-0027 slice 5a): vai à sessão e ao shell `!cmd`. */
  allowCritical?: readonly string[];
  /** `allow-sensitive` da CLI (ADR-0027): promove normal para sensitive no gate/read_file. */
  allowSensitive?: readonly string[];
  /** `--artifact-root` (ADR-0026): raiz do artifact store de imagens; ausente usa env/default. */
  artifactRoot?: string;
}

/** Ink desmontaria no ctrl+c antes do handler da app; a app decide a saída. */
export const TUI_RENDER_OPTIONS = { exitOnCtrlC: false } as const;

/** Abre a sessão já com o último modelo; modelo removido da config cai no default. */
export function openSession<T>(create: (model?: string) => T, cwd: string): T {
  const saved = loadTuiConfig(cwd).lastModel;
  if (saved === undefined) return create();
  try {
    return create(saved);
  } catch (error) {
    if (error instanceof ConfigError) return create();
    throw error;
  }
}

/** Branch git do cwd; ausente fora de um repositório. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" || out === "HEAD" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Primeiro run: tenta criar a sessão. Só quando falta provider e a config é
 * implícita abre o setup; qualquer outro erro segue o caminho normal.
 */
export async function withProviderSetup<T>(
  create: () => T,
  setup: () => Promise<boolean>,
  allowMissingConfig: boolean,
): Promise<T | undefined> {
  try {
    return create();
  } catch (error) {
    if (!allowMissingConfig || !(error instanceof NoProviderError)) throw error;
    if (!(await setup())) return undefined;
    return create();
  }
}

export interface TuiBootstrapOptions<T> {
  createSession(): T;
  setup(): Promise<boolean>;
  createShell(): ShellRunner;
  allowMissingConfig: boolean;
}

export interface TuiBootstrap<T> {
  session: T;
  shell: ShellRunner;
}

/**
 * Bootstrap testável da TUI: sessão e shell só são criados depois que o
 * provider existe. O shell carrega a config efetiva, então criá-lo antes do
 * setup escondia a tela de providers (#348).
 */
export async function bootstrapTui<T>(opts: TuiBootstrapOptions<T>): Promise<TuiBootstrap<T> | undefined> {
  return await withProviderSetup(
    () => ({ session: opts.createSession(), shell: opts.createShell() }),
    opts.setup,
    opts.allowMissingConfig,
  );
}

/** Tela de providers standalone; resolve true quando um perfil foi ativado. */
export async function setupProvider(
  manager: ProfileManager,
  cwd: string,
  onSaveSecret?: (providerId: string, secret: string) => string,
  onDiscardSecret?: (ref: string) => void,
): Promise<boolean> {
  const [{ render }, { ProviderScreen }] = await Promise.all([
    import("ink"),
    import("./provider-screen"),
  ]);
  const colors = getThemeColors(loadTuiConfig(cwd).theme);
  return await new Promise<boolean>((resolveSetup) => {
    let instance: ReturnType<typeof render> | undefined;
    let settled = false;
    const finish = (configured: boolean): void => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolveSetup(configured);
    };
    instance = render(
      <ProviderScreen
        manager={manager}
        colors={colors}
        onClose={() => finish(false)}
        onActivate={() => finish(true)}
        onChanged={() => undefined}
        {...(onSaveSecret === undefined ? {} : { onSaveSecret })}
        {...(onDiscardSecret === undefined ? {} : { onDiscardSecret })}
      />,
      TUI_RENDER_OPTIONS,
    );
  });
}

export async function runTui(opts: RunTuiOptions): Promise<number> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error("erro: tui precisa de um terminal interativo; use `chat` para stdin em pipe");
    return 1;
  }
  try {
    const [{ render }, { AgentSession }, { openSessionApi }, { TuiApp }] = await Promise.all([
      import("ink"),
      import("../chat/agent-session"),
      import("../chat/session-api"),
      import("./app"),
    ]);
    const cwd = resolve(opts.cwd);
    const approvals = createApprovalBridge();
    // Chave digitada no setup vai para o cofre (ADR-0019); o perfil guarda só o ref.
    const vault = new Vault(vaultPath(opts.env ?? process.env));
    const { saveSecret, discardSecret } = createSecretHandlers(vault);
    const configPath = resolve(opts.configPath);
    const project = loadProjectConfig(configPath, { env: opts.env });
    const manager = new ProfileManager({
      project,
      env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    });
    const createSession = (model?: string) => new AgentSession({
      configPath, cwd, env: opts.env ?? process.env,
      ...(opts.provider === undefined ? {} : { provider: opts.provider }),
      allowMissingConfig: opts.allowMissingConfig === true,
      approveSwap: approvals.approveSwap,
      onBudgetExceeded: approvals.onBudgetExceeded,
      approveTool: approvals.approveTool,
      trustAsk: async (dir) => trustChoice(await approvals.askText(trustPrompt(dir))),
      ...(opts.allowCritical === undefined ? {} : { allowCritical: opts.allowCritical }),
      ...(opts.allowSensitive === undefined ? {} : { allowSensitive: opts.allowSensitive }),
      ...(opts.artifactRoot === undefined ? {} : { artifactRoot: opts.artifactRoot }),
      ...(model === undefined ? {} : { model }),
    });
    // `--provider` explícito vence o último modelo salvo em .astro/tui.json.
    const boot = await bootstrapTui({
      createSession: () => (opts.provider === undefined ? openSession(createSession, cwd) : createSession()),
      setup: () => setupProvider(manager, cwd, saveSecret, discardSecret),
      createShell: () => createShellRunner({
        configPath, cwd, env: opts.env ?? process.env,
        allowMissingConfig: opts.allowMissingConfig === true,
        ...(opts.allowCritical === undefined ? {} : { allowCritical: opts.allowCritical }),
        ...(opts.allowSensitive === undefined ? {} : { allowSensitive: opts.allowSensitive }),
      }),
      allowMissingConfig: opts.allowMissingConfig === true,
    });
    if (boot === undefined) {
      console.error(`erro: ${NO_PROVIDER_MESSAGE}`);
      return 1;
    }
    const { session, shell } = boot;
    for (const warning of session.warnings) console.error(`aviso: ${warning}`);
    let sessionApi: ReturnType<typeof openSessionApi>;
    let instance: ReturnType<typeof render> | undefined;
    const branch = gitBranch(cwd);
    try {
      sessionApi = openSessionApi(resolve(cwd, ".astro"));
      instance = render(
        <TuiApp
          session={session}
          cwd={cwd}
          {...(branch === undefined ? {} : { branch })}
          {...(sessionApi === undefined ? {} : { sessionApi })}
          approvals={approvals}
          shell={shell}
          manager={manager}
          saveSecret={saveSecret}
          discardSecret={discardSecret}
          onExit={() => instance?.unmount()}
        />,
        TUI_RENDER_OPTIONS,
      );
      await instance.waitUntilExit();
      return 0;
    } finally {
      try {
        session.close();
      } catch {
        // turno abortado ainda em curso: o sinal já foi enviado
      }
      sessionApi?.close();
    }
  } catch (error) {
    console.error(`erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}
