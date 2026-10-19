/*
 * Grungus — DOM-free name helpers (deterministic colors, initials).
 * Kept separate from components/ui.ts so call services can use them
 * in DOM-less environments (the Node test suite) too.
 */

/** Deterministic hue from a string — Discord-style per-user colors. */
export function colorFor(seed: string | null | undefined): string {
  const str = String(seed || "?");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 58%, 48%)`;
}

/** Up to two uppercase initials ("grungus HQ" -> "GH"). */
export function initials(name: string | null | undefined): string {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}
