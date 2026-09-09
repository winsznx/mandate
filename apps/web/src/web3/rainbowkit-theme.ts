import { lightTheme } from "@rainbow-me/rainbowkit";
import type { Theme } from "@rainbow-me/rainbowkit";

/**
 * RainbowKit theme customized for Duna design system.
 * Achromatic, Espresso accent, Paper White surface, subtle hairline borders.
 */
export const dunaRainbowTheme: Theme = lightTheme({
  accentColor: "#160f0c",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
  fontStack: "system",
  overlayBlur: "small",
});
