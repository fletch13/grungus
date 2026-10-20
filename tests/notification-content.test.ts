import test from "node:test";
import assert from "node:assert/strict";
import { notificationContent } from "../src/renderer/services/notification-content.ts";
test("private desktop notifications disclose no room, sender, or message content", () => {
  assert.deepEqual(notificationContent(false, "Private room", "Alice", "Secret message"), { title: "Grungus", body: "You have a new message." });
  assert.deepEqual(notificationContent(true, "Lounge", "Alice", "Hello"), { title: "Lounge — Alice", body: "Hello" });
  assert.equal(notificationContent(true, "Lounge", "Alice", "x".repeat(500)).body.length, 120);
});
