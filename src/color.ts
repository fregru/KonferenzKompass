/** "#rrggbb" mixed `amount` (0–1) toward white. */
export function lighten(hex: string, amount: number): string {
  const mix = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0");
  };
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

/**
 * Darkmode colour for a brand colour: the admin's own choice if set, otherwise the colour lightened so it stays
 * readable on the black background (text on primary fills is dark in darkmode).
 */
export const darkColor = (hex: string, own: string | undefined) => own || lighten(hex, 0.45);
