import "../src/renderer/components/session-recovery-view.ts";
import Olm from "@matrix-org/olm";
import "../src/renderer/components/app-shell.ts";
import "../src/renderer/components/space-rail.ts";
import "../src/renderer/components/room-list.ts";
import "../src/renderer/components/member-list.ts";
import "../src/renderer/components/login-view.ts";
import { SettingsView } from "../src/renderer/components/settings-view.ts";
import { SettingsStore } from "../src/renderer/services/settings.ts";
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
  const recovery = document.createElement("session-recovery-view");
  document.body.append(recovery);
  recovery.show();
  let resets = 0;
  recovery.addEventListener("session-reset", () => { resets++; });
  clickByText(recovery, "I cannot recover my keys");
  const password = recovery.querySelector<HTMLInputElement>('input[type="password"]')!;
  password.value = "account-password";
  const form = recovery.querySelector("form")!;
  form.requestSubmit();
  assert(resets === 0, "Deleting backup must require explicit loss acknowledgment");
  recovery.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
  form.requestSubmit();
  assert(Number(resets) === 1, "Confirmed reset must dispatch exactly once");
  assert(password.value === "", "Password must be cleared after submission");
  recovery.setStatus("Working…", true);
  assert([...recovery.querySelectorAll("button")].every(button => button.disabled), "Busy reset must prevent duplicate actions");
  recovery.setStatus("Incorrect password");
  clickByText(recovery, "Back");
  clickByText(recovery, "Use recovery passphrase or key");
  let restored = "";
  recovery.addEventListener("session-restore", event => { restored = (event as CustomEvent<string>).detail; });
  recovery.querySelector<HTMLInputElement>("input")!.value = "backup phrase";
  recovery.querySelector("form")!.requestSubmit();
  assert(restored === "backup phrase", "Recovery credentials must reach restore handler");
  recovery.hide();
  assert(getComputedStyle(recovery).display === "none", "Closed recovery must not cover verification");
  recovery.remove();
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
  await Olm.init();
  const identity = new Olm.Account();
  identity.create();
  assert(JSON.parse(identity.identity_keys()).curve25519, "Vite must load working Olm WASM on the secure app origin");
  identity.free();
  const worker = new Worker(new URL("/livekit-client.e2ee.worker.js", location.href));
  await new Promise<void>((resolve, reject) => {
    worker.onerror = error => reject(new Error(`E2EE worker failed: ${error.message}`));
    setTimeout(resolve, 100);
  });
  worker.terminate();
  showPreview("workspace");
  const shell = document.querySelector("app-shell")!;
  assert(getComputedStyle(shell).display === "grid", "Vite must include the Tailwind component styles");
  const filter = shell.querySelector<HTMLInputElement>("#room-filter")!;
  filter.value = "design";
  filter.dispatchEvent(new Event("input"));
  assert(shell.querySelectorAll(".room-row:not(.hidden)").length === 1, "Conversation filter must match room names");
  filter.value = "";
  filter.dispatchEvent(new Event("input"));
  return { message: "UI tests passed: Vite/Tailwind build, Olm WASM, E2EE worker, capture consent, message history, room filtering, and image retry" };
}

(window as unknown as { uiTestResult: Promise<unknown> }).uiTestResult = run().catch(error => ({ error: error instanceof Error ? error.stack : String(error) }));

function showPreview(scene: string): void {
  document.body.replaceChildren();
  document.body.classList.toggle("theme-light", scene === "light");
  if (scene === "login") { document.body.appendChild(document.createElement("login-view")); return; }
  const shell = document.createElement("app-shell");
  document.body.appendChild(shell);
  const me = "@alex:matrix.org";
  const peer = "@sam:matrix.org";
  const titles = ["General", "Design studio", "Development", "Random", "Sam Rivera", "Morgan Chen"];
  const rooms = titles.map((title, index) => ({
    id: `!room${index}:matrix.org`, title, name: title, isEncrypted: true, isSpace: false,
    isDirect: index > 3, directUserId: index > 3 ? peer : null,
    topic: index === 0 ? "A place for everything we're working on." : "",
    joinedMemberCount: 3, members: new Map([
      [me, { userId: me, displayname: "Alex Morgan", avatarMxc: null, membership: "join" }],
      [peer, { userId: peer, displayname: "Sam Rivera", avatarMxc: null, membership: "join" }],
      ["@morgan:matrix.org", { userId: "@morgan:matrix.org", displayname: "Morgan Chen", avatarMxc: null, membership: "join" }],
    ]),
    avatarMxc: null, children: new Set<string>(), unread: index === 2 ? 3 : 0,
    readReceipts: new Map(), historyCursor: null, atLiveEdge: true,
    timeline: [], lastActivityTs: Date.now(),
  } as unknown as Room));
  const time = Date.now() - 15 * 60_000;
  const conversations = [
    [peer, "Sam Rivera", "Morning everyone! The new workspace is ready to explore."],
    [me, "Alex Morgan", "Love how this is coming together. Everything has a little more room to breathe."],
    [peer, "Sam Rivera", "Exactly. Keeping the things we use every day close, and letting the conversations take center stage."],
    ["@morgan:matrix.org", "Morgan Chen", "Just finished testing the encrypted calls. Working beautifully 🎉"],
    [me, "Alex Morgan", "Nice! I'll share the latest notes in Design studio after lunch."],
    [peer, "Sam Rivera", "Sounds good. See you there."],
  ];
  rooms[0]!.timeline = conversations.map(([sender, senderName, body], index) => ({ kind: "message", id: `$preview${index}`, sender: sender!, senderName: senderName!, body: body!, ts: time + index * 120000, msgtype: "m.text", media: null }));
  const client = { avatarSrc: async () => null, mediaSrc: async () => null, getDevices: async () => [], getProfile: async () => ({ displayname: "Alex Morgan" }), getIgnoredUsers: () => [], getAccountData: () => null, userId: me } as unknown as MatrixClient;
  const spaces = ["Studio", "Friends", "Open source"].map((title, index) => ({ ...rooms[0]!, id: `!space${index}:matrix.org`, title, isSpace: true }));
  shell.querySelector("space-rail")!.update(spaces, null, client);
  const sidebar = shell.querySelector("room-list")!;
  sidebar.update(rooms, spaces, rooms[0]!.id, null, client);
  sidebar.setUser({ userId: me, displayname: "Alex Morgan", avatarMxc: null });
  sidebar.setConnection("online");
  shell.querySelector("chat-view")!.setRoom(rooms[0]!, client, me);
  shell.querySelector("member-list")!.update(rooms[0]!, client, me);
  if (scene === "settings") {
    const settings = new SettingsView();
    document.body.appendChild(settings);
    settings.update(client, new SettingsStore(), { userId: me, displayname: "Alex Morgan", avatarMxc: null });
    settings.show();
  }
  if (scene === "mobile") shell.classList.add("show-rooms");
}
(window as unknown as { showPreview: typeof showPreview }).showPreview = showPreview;
