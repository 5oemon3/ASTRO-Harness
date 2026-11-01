/** Interactive deciders for chat (TTY): same readline as the REPL, no extra TTY. */
import type { SwapApprover, SwapRequest } from "../approval";
import type { BudgetDecider, BudgetStatus } from "../budget";
import type { PermissionApproval, ToolPermissionRequest } from "../permissions";
import type { ToolApprover } from "../tools/executor";
import type { ReplIO } from "./repl";

export function isYes(answer: string | null): boolean {
  return answer !== null && /^(s|sim|y|yes)$/i.test(answer.trim());
}

export function budgetChoice(answer: string | null): "continue_same" | "lower_effort" | "stop" {
  const choice = (answer ?? "").trim().toLowerCase();
  if (choice === "c" || choice === "continuar" || choice === "continue") return "continue_same";
  if (choice === "l" || choice === "baixar" || choice === "lower") return "lower_effort";
  return "stop";
}

export function swapPrompt(request: SwapRequest): string {
  const from = `${request.from.provider}/${request.from.model ?? "?"}`;
  const to = `${request.to.provider}/${request.to.model ?? "?"}`;
  const cost = request.costDeltaUsd === undefined || request.costDeltaUsd === null
    ? ""
    : `; custo delta US$${request.costDeltaUsd.toFixed(2)}/1M`;
  return `troca ${from} -> ${to} (${request.reason}${cost}). aprovar? [s/N] `;
}

export function budgetPrompt(status: BudgetStatus): string {
  const limit = status.limitUsd === null ? "sem limite" : `US$ ${status.limitUsd}`;
  return `budget esgotado (${status.estimate} / ${limit}). [c] continuar, [l] baixar, [p] parar: `;
}

/** Prompt de aprovação de tool/file (PERM-04, #265): 4 opções na mesma linha. */
export function toolPrompt(request: ToolPermissionRequest): string {
  return `tool "${request.name}" (ação ${request.action}, modo ${request.mode}). [s] aprovar, [n] negar, [S] aprovar nesta sessão, [o] só esta vez: `;
}

/**
 * Mapeia a resposta do prompt de tool (PERM-04, #265). `S` maiúsculo é sessão;
 * `s` minúsculo é aprovação única (once → true no gate).
 */
export function toolChoice(answer: string | null): PermissionApproval {
  const raw = (answer ?? "").trim();
  const lower = raw.toLowerCase();
  if (raw === "S" || lower === "sessao" || lower === "session") return "session";
  if (lower === "o" || lower === "once" || lower === "vez" || lower === "uma vez") return "once";
  if (isYes(raw)) return true;
  return false;
}

export function chatApprovers(
  io: ReplIO,
  interactive: boolean,
): { approveSwap?: SwapApprover; onBudgetExceeded?: BudgetDecider; approveTool?: ToolApprover } {
  if (!interactive) return {};
  const ask = (prompt: string): Promise<string | null> => (io.readFresh ?? io.read).call(io, prompt);
  return {
    approveSwap: async (request) => isYes(await ask(swapPrompt(request))),
    onBudgetExceeded: async (status) => budgetChoice(await ask(budgetPrompt(status))),
    approveTool: async (request) => toolChoice(await ask(toolPrompt(request))),
  };
}
