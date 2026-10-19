import englishData from "emojibase-data/en/compact.json" with { type: "json" };
import germanData from "emojibase-data/de/compact.json" with { type: "json" };
interface Entry { unicode: string; label: string; tags?: string[]; group?: number; skins?: Entry[]; }
export const EMOJI_GROUPS = ["Smileys", "People", "Components", "Nature", "Food", "Travel", "Activities", "Objects", "Symbols", "Flags"];
const german = new Map<string, Entry>();
for (const entry of germanData as Entry[]) {
  german.set(entry.unicode, entry);
  for (const skin of entry.skins ?? []) german.set(skin.unicode, skin);
}
export const EMOJIS = (englishData as Entry[]).flatMap(parent => [parent, ...(parent.skins ?? [])].map(entry => {
  const de = german.get(entry.unicode);
  return {
    emoji: entry.unicode,
    name: entry.label,
    category: EMOJI_GROUPS[entry.group ?? parent.group ?? 2]!,
    search: [entry.label, de?.label, ...(parent.tags ?? []), ...(entry.tags ?? []), ...(de?.tags ?? [])].filter(Boolean).join(" ").toLocaleLowerCase(),
  };
}));
