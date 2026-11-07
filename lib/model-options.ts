import { REASONING_LEVELS, type ReasoningLevel } from "../handoff";

/** What `bb.sdk.providers.models()` reports per model, as far as the picker reads it. */
export interface ProviderModel {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: readonly { reasoningEffort: string; description: string }[];
}

export interface ModelOption {
  model: string;
  displayName: string;
  isDefault: boolean;
  /** null when the provider's default is a level this plugin does not know yet. */
  defaultReasoningEffort: ReasoningLevel | null;
  supportedReasoningEfforts: { reasoningEffort: ReasoningLevel; description: string }[];
}

function knownLevel(level: string): ReasoningLevel | null {
  return (REASONING_LEVELS as readonly string[]).includes(level) ? (level as ReasoningLevel) : null;
}

/**
 * bb reports reasoning efforts as plain strings, so a provider can list a
 * level newer than REASONING_LEVELS. Offer the levels a handoff can pass on
 * and leave the rest out, rather than failing the whole model list.
 */
export function knownModelOptions(models: readonly ProviderModel[]): ModelOption[] {
  return models.map((model) => ({
    model: model.model,
    displayName: model.displayName,
    isDefault: model.isDefault,
    defaultReasoningEffort: knownLevel(model.defaultReasoningEffort),
    supportedReasoningEfforts: model.supportedReasoningEfforts.flatMap((effort) => {
      const reasoningEffort = knownLevel(effort.reasoningEffort);
      return reasoningEffort ? [{ reasoningEffort, description: effort.description }] : [];
    }),
  }));
}
