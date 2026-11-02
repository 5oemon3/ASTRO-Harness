/** Resumo da config do harness para `/config` (#273): puro, sem I/O. */
import type { AstroConfig, BudgetConfig } from "../config";
import type { PermissionMode } from "../permissions";

export interface CostLine {
  /** Modelo `provider/id`. */
  ref: string;
  inputPerM: number;
  outputPerM: number;
}

export interface ConfigSummary {
  configPath: string;
  /** `run.maxTurns` como texto; ausente = "unlimited" (o run usa só o teto de agent.maxSteps). */
  maxTurns: string;
  permissionMode: PermissionMode;
  /** Um linha por modelo com preço declarado (`pricing` sobrescreve `model.price`). */
  costs: CostLine[];
  budget: string;
}

function budgetText(budget: BudgetConfig | undefined): string {
  if (budget === undefined) return "sem budget";
  const limit = budget.limitUsd === null
    ? "sem limite (use-as-you-go)"
    : `US$ ${budget.limitUsd.toFixed(2)}`;
  const ceiling = budget.hardCeilingUsd === undefined
    ? ""
    : ` · teto US$ ${budget.hardCeilingUsd.toFixed(2)}`;
  return `${budget.scope} · limite ${limit} · aviso em ${Math.round(budget.warnAt * 100)}% · ao exceder: ${budget.onExceed}${ceiling}`;
}

/** Monta o resumo a partir da config carregada; `mode` é o modo ativo da sessão. */
export function configSummaryOf(config: AstroConfig, configPath: string, mode: PermissionMode): ConfigSummary {
  const costs: CostLine[] = [];
  for (const model of config.models) {
    const ref = `${model.provider}/${model.id}`;
    const price = config.pricing?.[ref] ?? model.price; // pricing global vence model.price (C6)
    if (price === undefined) continue;
    costs.push({ ref, inputPerM: price.inputPerM, outputPerM: price.outputPerM });
  }
  return {
    configPath,
    maxTurns: config.run?.maxTurns === undefined ? "unlimited" : String(config.run.maxTurns),
    permissionMode: mode,
    costs,
    budget: budgetText(config.budget),
  };
}

/** Linhas exibidas no REPL (`/config`) e na tela da TUI. */
export function configLines(summary: ConfigSummary, trustedFolders: readonly string[]): string[] {
  const money = (value: number): string => `US$ ${value.toFixed(2)}/M`;
  return [
    `config: ${summary.configPath}`,
    `run.maxTurns: ${summary.maxTurns}`,
    `permissions.mode: ${summary.permissionMode}`,
    `budget: ${summary.budget}`,
    ...(summary.costs.length === 0
      ? ["custos: nenhum preço declarado"]
      : [
          "custos por modelo:",
          ...summary.costs.map((cost) => `  ${cost.ref}: in ${money(cost.inputPerM)} · out ${money(cost.outputPerM)}`),
        ]),
    ...(trustedFolders.length === 0
      ? ["pastas confiáveis: nenhuma"]
      : ["pastas confiáveis:", ...trustedFolders.map((folder) => `  ${folder}`)]),
  ];
}
