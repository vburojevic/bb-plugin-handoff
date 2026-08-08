import type { AgentAdapter, AgentId } from "../transcript";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { geminiAdapter } from "./gemini";

export const ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter];

const ALIASES: Record<string, AgentId> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
};

export function resolveAgentId(value: string): AgentId | null {
  return ALIASES[value.toLowerCase()] ?? null;
}

export function getAdapter(id: AgentId): AgentAdapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`No adapter for agent ${id}`);
  return adapter;
}
