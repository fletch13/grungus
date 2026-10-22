import test from "node:test";
import assert from "node:assert/strict";
import { PushToTalk } from "../src/renderer/services/push-to-talk.ts";
test("push-to-talk mutes on release, blur, visibility loss and stop", t => {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win }); Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  t.after(() => { delete (globalThis as any).window; delete (globalThis as any).document; });
  const muted: boolean[] = []; const ptt = new PushToTalk();
  const key = (type: string) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { code: "Space", repeat: false }); win.dispatchEvent(event); };
  ptt.configure(true, "Space", value => muted.push(value)); assert.deepEqual(muted, [true]);
  key("keydown"); assert.equal(muted.at(-1), false); key("keyup"); assert.equal(muted.at(-1), true);
  key("keydown"); win.dispatchEvent(new Event("blur")); assert.equal(muted.at(-1), true);
  key("keydown"); doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange")); assert.equal(muted.at(-1), true);
  key("keydown"); ptt.stop(); assert.equal(muted.at(-1), true);
  const count = muted.length; key("keydown"); assert.equal(muted.length, count, "Stopped listeners must not unmute");
});
