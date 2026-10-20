import type { ThemeName } from "./settings.ts";
export function applyTheme(theme: ThemeName): void {
  document.body.classList.toggle("theme-light", theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches));
}
