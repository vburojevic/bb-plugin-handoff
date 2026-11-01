import { describe, expect, it } from "vitest";
import { providerIconTint, providerMarkColor, providerMarkStyle } from "../lib/provider-icon";

describe("providerIconTint", () => {
  it("reads bb's per-scheme tint", () => {
    expect(providerIconTint({ strings: { iconTint: { light: "#111827", dark: "#F5F5F5" } } })).toEqual({
      light: "#111827",
      dark: "#F5F5F5",
    });
  });

  it("is null when the provider has no tint", () => {
    expect(providerIconTint({ id: "codex", strings: { signInHint: "Run codex" } })).toBeNull();
    expect(providerIconTint({ id: "codex" })).toBeNull();
    expect(providerIconTint(null)).toBeNull();
  });

  it("rejects values that are not hex colors", () => {
    expect(providerIconTint({ strings: { iconTint: { light: "red; background: url(x)", dark: "#fff" } } })).toBeNull();
    expect(providerIconTint({ strings: { iconTint: { light: "#fff" } } })).toBeNull();
    expect(providerIconTint({ strings: { iconTint: "#fff" } })).toBeNull();
  });
});

describe("providerMarkColor", () => {
  it("inherits the text color without a tint", () => {
    expect(providerMarkColor(null)).toBeUndefined();
  });

  it("uses one color when both schemes share it", () => {
    expect(providerMarkColor({ light: "#D97757", dark: "#D97757" })).toBe("#D97757");
  });

  it("follows the theme's color scheme when the tints differ", () => {
    expect(providerMarkColor({ light: "#111827", dark: "#F5F5F5" })).toBe("light-dark(#111827, #F5F5F5)");
  });
});

describe("providerMarkStyle", () => {
  it("paints the logo as a mask filled with currentColor", () => {
    const style = providerMarkStyle("/api/v1/system/providers/codex/logo?h=1", null);
    expect(style.backgroundColor).toBe("currentColor");
    expect(style.maskImage).toBe('url("/api/v1/system/providers/codex/logo?h=1")');
    expect(style.WebkitMaskImage).toBe(style.maskImage);
    expect(style.color).toBeUndefined();
  });

  it("keeps a quote in the URL inside the CSS string", () => {
    expect(providerMarkStyle('/logo?a="b"', null).maskImage).toBe('url("/logo?a=\\"b\\"")');
  });
});
