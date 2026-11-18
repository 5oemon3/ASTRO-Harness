/**
 * Fan-out de subagentes (A11, ADR-0008): executa jobs independentes com um
 * teto de concorrência e serializa jobs da mesma conta (A4). Cada job recebe
 * um sinal próprio: abortar ou falhar um filho não toca nos irmãos.
 */
import { redactSecrets } from "./sanitize-external";

export interface FanOutJob<T> {
  id: string;
  /** Conta exclusiva do job; jobs da mesma conta nunca rodam juntos. */
  account: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export type FanOutOutcome<T> =
  | { id: string; ok: true; value: T }
  | { id: string; ok: false; error: string };

export interface FanOutOptions {
  /** `false` = serial (default do v1); `true` = paralelo com limite. */
  parallel: boolean;
  /** Teto de jobs simultâneos; inteiro positivo. */
  maxActive: number;
  signal?: AbortSignal;
  /** Só no caminho serial: interrompe a fila (ex.: pausa de permissão). */
  stopOnError?: (error: unknown) => boolean;
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Valida o teto antes de qualquer job começar. */
export function assertFanOutBound(maxActive: number): void {
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new RangeError(`fan-out: maxActive deve ser inteiro positivo (recebido ${String(maxActive)})`);
  }
}

/** Executa jobs em ordem de entrada; resultados também saem na ordem de entrada. */
export async function runFanOut<T>(
  jobs: readonly FanOutJob<T>[],
  opts: FanOutOptions,
): Promise<FanOutOutcome<T>[]> {
  assertFanOutBound(opts.maxActive);
  const results: FanOutOutcome<T>[] = new Array(jobs.length);
  if (jobs.length === 0) return results;

  const controllers = jobs.map(() => new AbortController());
  const abortAll = (): void => {
    for (const controller of controllers) controller.abort();
  };
  opts.signal?.addEventListener("abort", abortAll, { once: true });

  const runOne = async (job: FanOutJob<T>, index: number, stopOnError?: (error: unknown) => boolean): Promise<void> => {
    if (opts.signal?.aborted === true) {
      results[index] = { id: job.id, ok: false, error: "aborted" };
      return;
    }
    try {
      results[index] = { id: job.id, ok: true, value: await job.run(controllers[index]!.signal) };
    } catch (error) {
      results[index] = { id: job.id, ok: false, error: errorMessage(error) };
      if (stopOnError?.(error) === true) throw error;
    }
  };

  try {
    if (!opts.parallel) {
      for (const [index, job] of jobs.entries()) await runOne(job, index, opts.stopOnError);
      return results;
    }

    // Uma fila por conta: jobs da mesma conta são sequenciais; contas distintas
    // disputam os `maxActive` slots. A ordem de entrada é preservada.
    const groups = new Map<string, number[]>();
    for (const [index, job] of jobs.entries()) {
      const group = groups.get(job.account);
      if (group === undefined) groups.set(job.account, [index]);
      else group.push(index);
    }

    let active = 0;
    const waiters: Array<() => void> = [];
    const acquire = async (): Promise<void> => {
      while (active >= opts.maxActive) await new Promise<void>((resolve) => waiters.push(resolve));
      active++;
    };
    const release = (): void => {
      active--;
      waiters.shift()?.();
    };

    await Promise.all([...groups.values()].map(async (indexes) => {
      await acquire();
      try {
        for (const index of indexes) await runOne(jobs[index]!, index);
      } finally {
        release();
      }
    }));
  } finally {
    opts.signal?.removeEventListener("abort", abortAll);
  }
  return results;
}
