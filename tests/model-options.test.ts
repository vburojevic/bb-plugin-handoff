import { describe, expect, it } from "vitest";
import { knownModelOptions } from "../lib/model-options";

const model = (defaultReasoningEffort: string, efforts: string[]) => ({
  model: "m",
  displayName: "M",
  isDefault: true,
  defaultReasoningEffort,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
});

describe("knownModelOptions", () => {
  it("passes known levels through unchanged", () => {
    expect(knownModelOptions([model("high", ["low", "high", "max"])])).toEqual([
      {
        model: "m",
        displayName: "M",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "low" },
          { reasoningEffort: "high", description: "high" },
          { reasoningEffort: "max", description: "max" },
        ],
      },
    ]);
  });

  it("drops a level the plugin does not know instead of failing the list", () => {
    const [option] = knownModelOptions([model("hyper", ["low", "hyper"])]);
    expect(option.defaultReasoningEffort).toBeNull();
    expect(option.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(["low"]);
  });
});
