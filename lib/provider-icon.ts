// Provider marks that stay legible in every theme.
//
// bb serves provider logos as monochrome SVGs drawn in `currentColor`. An
// <img> loads the SVG as its own document, where `currentColor` is black, so
// the mark vanishes on a dark theme. bb draws these logos as a mask filled
// with the provider's tint, or with the text color when there is no tint.
// These helpers do the same for the plugin's own provider marks.
import type { CSSProperties } from "react";

/** bb's per-provider brand color, one per color scheme. */
export interface ProviderIconTint {
  light: string;
  dark: string;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Read bb's optional `strings.iconTint` from a provider record. Only well-formed
 * hex colors pass, since the value ends up in an inline style.
 */
export function providerIconTint(provider: unknown): ProviderIconTint | null {
  if (!provider || typeof provider !== "object") return null;
  const strings = (provider as { strings?: unknown }).strings;
  if (!strings || typeof strings !== "object") return null;
  const tint = (strings as { iconTint?: unknown }).iconTint;
  if (!tint || typeof tint !== "object") return null;
  const { light, dark } = tint as { light?: unknown; dark?: unknown };
  if (typeof light !== "string" || typeof dark !== "string") return null;
  if (!HEX_COLOR.test(light) || !HEX_COLOR.test(dark)) return null;
  return { light, dark };
}

/**
 * The mark's fill color. `light-dark()` follows the theme's `color-scheme`, so a
 * dark custom theme picks the dark tint even when the OS is in light mode.
 * Undefined means "inherit the surrounding text color".
 */
export function providerMarkColor(tint: ProviderIconTint | null): string | undefined {
  if (!tint) return undefined;
  return tint.light === tint.dark ? tint.light : `light-dark(${tint.light}, ${tint.dark})`;
}

/** Inline style that paints `logoUrl` as a mask filled with the mark's color. */
export function providerMarkStyle(logoUrl: string, tint: ProviderIconTint | null): CSSProperties {
  const image = `url(${JSON.stringify(logoUrl)})`;
  return {
    color: providerMarkColor(tint),
    backgroundColor: "currentColor",
    maskImage: image,
    maskRepeat: "no-repeat",
    maskPosition: "center",
    maskSize: "contain",
    WebkitMaskImage: image,
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    WebkitMaskSize: "contain",
  };
}
