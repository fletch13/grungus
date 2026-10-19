import test from "node:test";
import assert from "node:assert/strict";
import { EMOJIS } from "../src/renderer/services/emoji-catalog.ts";
test("full emoji catalog includes skin tones, flags, ZWJ sequences, and bilingual search", () => {
  assert.ok(EMOJIS.length > 3500);
  for (const emoji of ["👍", "👍🏽", "🧑🏽‍🚀", "🏳️‍🌈", "🇩🇪"]) assert.ok(EMOJIS.some(entry => entry.emoji === emoji), emoji);
  assert.ok(EMOJIS.some(entry => entry.emoji === "👍" && entry.search.includes("daumen")));
});
