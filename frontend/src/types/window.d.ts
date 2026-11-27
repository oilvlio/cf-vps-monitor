import type { DisplayTheme } from '../utils/displayTheme';
import type { ThemeMode } from '../utils/themeAppearance';

declare global {
  interface Window {
    /** Set by main.tsx so theme contexts can update the Radix appearance. */
    __setThemeAppearance?: (theme: ThemeMode) => void;
    /** Set by main.tsx so theme contexts can update the Radix accent color. */
    __setRadixAccentColor?: (theme: DisplayTheme) => void;
  }
}

export {};
