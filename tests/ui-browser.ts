import "../src/renderer/components/message-item.ts";
import { ChatView } from "../src/renderer/components/chat-view.ts";
import { renderCapturePicker } from "../src/renderer/capture-picker.ts";
import type { MatrixClient, Room, MessageItem } from "../src/renderer/services/matrix-client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function clickByText(root: HTMLElement, text: string): void {
  const button = [...root.querySelectorAll("button")].find(node => node.textContent === text);
  assert(button, `Missing button: ${text}`);
  button.click();
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function run(): Promise<{ message: string }> {
  const root = document.createElement("main");
  document.body.append(root);
  const choices: Array<{ id: string | null; audio: boolean }> = [];
  await renderCapturePicker(root, {
    sources: async () => ({ audioAvailable: true, sources: [{ id: "window:1", name: "<script>untrusted window name</script>", thumbnail: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" }] }),
    choose: async (id, audio) => { choices.push({ id, audio }); },
  });
  assert(root.querySelectorAll("script").length === 0, "Picker names must render as text");
  assert((root.querySelectorAll("button")[1] as HTMLButtonElement).disabled, "Share must require a selection");
  const radio = root.querySelector('input[type="radio"]') as HTMLInputElement;
  radio.click();
  clickByText(root, "Share");
  await tick();
  assert(choices[0]?.id === "window:1" && choices[0].audio === false, "Audio must default off");
  clickByText(root, "Cancel");
  assert(choices[1]?.id === null, "Cancel must deny capture");
  await renderCapturePicker(root, {
    sources: async () => ({ audioAvailable: true, sources: [{ id: "screen:1", name: "Display", thumbnail: "" }] }),
    choose: async (id, audio) => { choices.push({ id, audio }); },
  });
  (root.querySelector('input[type="radio"]') as HTMLInputElement).click();
  (root.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  clickByText(root, "Share");
  assert(choices.at(-1)?.audio === true, "Selected audio must be passed explicitly");
  root.remove();

  const chat = new ChatView();
  document.body.append(chat);
  const timeline: MessageItem[] = Array.from({ length: 350 }, (_, index) => ({
    kind: "message", id: `$${index}`, sender: "@sender:test", senderName: "Sender", ts: 1_000_000 + index,
    body: `message-${index}`, msgtype: "m.text", media: null,
  }));
  const room = { id: "!test:example.org", title: "Test", timeline, isEncrypted: false, members: new Map(), readReceipts: new Map(), isDirect: false, atLiveEdge: true, historyCursor: "cursor" } as unknown as Room;
  let historyLoads = 0;
  const client = {
    avatarSrc: async () => null,
    loadOlderMessages: async () => { historyLoads++; room.historyCursor = null; },
  } as unknown as MatrixClient;
  chat.setRoom(room, client, "@me:test");
  assert(chat.querySelectorAll("message-item").length === 100, "Timeline must render at most 100 messages");
  assert(chat.textContent?.includes("message-349"), "Initial window must show newest messages");
  clickByText(chat, "Earlier messages");
  await tick();
  assert(!chat.textContent?.includes("message-349"), "Earlier control must navigate history");
  assert(chat.querySelectorAll("message-item").length <= 100, "History window must stay bounded");
  clickByText(chat, "Newer messages");
  assert(chat.textContent?.includes("message-349"), "Newer control must return to newer messages");
  for (let page = 0; page < 5; page++) { clickByText(chat, "Earlier messages"); await tick(); }
  assert(historyLoads === 1, "Earlier control must fetch once local history is exhausted");
  clickByText(chat, "Latest messages");
  await tick();
  assert(chat.textContent?.includes("message-349"), "Latest must return to newest messages");
  chat.clearRoom();
  assert(!chat.querySelector(".history-controls")?.textContent, "History controls must clear with the room");
  let attempts = 0;
  const imageClient = {
    avatarSrc: async () => null,
    mediaSrc: async () => ++attempts === 1 ? null : "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  } as unknown as MatrixClient;
  const imageRoom = { ...room, id: "!image:test", historyCursor: null, timeline: [{ ...timeline[0]!, media: { mxc: "mxc://test/image", name: "image.png", mimetype: "image/png", width: 1, height: 1, size: 1 } }] };
  chat.setRoom(imageRoom, imageClient, "@me:test");
  await tick();
  clickByText(chat, "Image unavailable — retry");
  await tick();
  assert(attempts === 2 && chat.querySelector(".msg-media-img"), "Failed images must support an explicit retry");
  chat.remove();
  return { message: "UI tests passed: capture selection, cancellation, audio consent, safe text, bounded history, and paging controls" };
}

(window as unknown as { uiTestResult: Promise<unknown> }).uiTestResult = run().catch(error => ({ error: error instanceof Error ? error.stack : String(error) }));
