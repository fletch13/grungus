import { StartupScreen } from "../src/renderer/services/startup-screen.ts";
import { RoomFeatures } from "../src/renderer/services/room-features.ts";
import { showUserMenu } from "../src/renderer/components/user-menu.ts";
import "../src/renderer/components/room-settings.ts";
import { showSpaceInvite } from "../src/renderer/components/space-invite.ts";
import { formatMessage, emojiOnlyCount } from "../src/renderer/services/message-format.ts";
import { applyTheme } from "../src/renderer/services/appearance.ts";
import { applyBackground, prepareBackground } from "../src/renderer/services/background.ts";
import "../src/renderer/components/call-view.ts";
import "../src/renderer/components/room-browser.ts";
import "../src/renderer/components/new-dm-view.ts";
import { configuredKlipyApiKey, sharedKlipyApiKey } from "../src/renderer/services/gif-config.ts";
import { createRoomRecord, resolveRoomMeta } from "../src/renderer/services/matrix-rooms.ts";
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
  const startupFixture = document.createElement("section"); startupFixture.className = "startup-screen";
  const startupStatus = document.createElement("p"); startupStatus.dataset.startupStatus = "";
  const startupAction = document.createElement("button"); startupAction.hidden = true;
  startupFixture.append(startupStatus, startupAction); document.body.append(startupFixture);
  const appFixture = document.createElement("div"); appFixture.id = "root"; document.body.append(appFixture);
  const startup = new StartupScreen(startupFixture);
  startup.show("Restoring your session…");
  assert(!startupFixture.hidden && appFixture.inert && startupStatus.textContent === "Restoring your session…", "Startup must display real initialization status and prevent interacting with unfinished UI");
  startup.finish(); startup.show("Loading your conversations…");
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  assert(!startupFixture.hidden && appFixture.inert, "A stale finish must not dismiss a newer startup stage");
  startup.finish();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  assert(startupFixture.hidden && !appFixture.inert, "Startup must reveal the ready UI after it has laid out");
  startup.fail(); assert(!startupFixture.hidden && !startupAction.hidden && startupAction.textContent === "Try again", "Startup failures must present a retry action instead of spinning forever");
  startupFixture.remove(); appFixture.remove();
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

  const sidebar = document.createElement("room-list");
  document.body.append(sidebar);
  const recentBar = document.createElement("recent-dms"); document.body.append(recentBar);
  const dm = createRoomRecord("!dm:test"); dm.name = "A named DM"; dm.avatarMxc = "mxc://test/room";
  dm.members.set("@me:test", { userId: "@me:test", displayname: "Me", avatarMxc: "mxc://test/me", membership: "join" });
  dm.members.set("@peer:test", { userId: "@peer:test", displayname: "Peer", avatarMxc: "mxc://test/peer", membership: "join" });
  resolveRoomMeta(dm, "@me:test", { "@peer:test": [dm.id] });
  assert(dm.directUserId === "@peer:test", "Named DMs must resolve their peer from m.direct");
  const group = createRoomRecord("!group:test"); group.title = "Group"; group.avatarMxc = "mxc://test/group";
  const requestedAvatars: Array<string | null | undefined> = [];
  let profileCalls = 0;
  let peerPresence: "online" | "offline" | "unavailable" | null = "online";
  const avatarClient = {
    userId: "@me:test",
    getPresence: () => peerPresence,
    avatarSrc: async (mxc: string | null) => { requestedAvatars.push(mxc); return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; },
    getProfile: async () => { profileCalls++; return { avatar_url: "mxc://test/global-peer" }; },
  } as unknown as MatrixClient;
  sidebar.update([dm, group], [], dm.id, null, avatarClient);
  recentBar.update([dm, group], dm.id, avatarClient);
  await tick();
  assert(requestedAvatars.includes("mxc://test/peer") && !requestedAvatars.includes("mxc://test/room"), "DM sidebar must use the other person's avatar instead of the room image");
  assert(requestedAvatars.includes("mxc://test/group"), "Group rooms must keep their room image");
  assert(recentBar.querySelector('.recent-dm-tile[data-room-id="!dm:test"] g-avatar img'), "DM avatar must render the authenticated image");
  assert(recentBar.querySelector('.recent-dm-tile[data-room-id="!dm:test"] .avatar-presence.online'), "DM avatar must show a green online dot");
  const memberPane = document.createElement("member-list");
  document.body.append(memberPane);
  memberPane.update(dm, avatarClient, "@me:test");
  assert(memberPane.querySelector(".avatar-presence.online"), "Member avatars must show online dots");
  peerPresence = "offline";
  memberPane.update(dm, avatarClient, "@me:test");
  assert(!memberPane.querySelector(".avatar-presence.online") && memberPane.querySelector('[aria-label="Offline"]'), "Presence changes must refresh the member list without membership changes");
  sidebar.update([dm, group], [], dm.id, null, avatarClient);
  recentBar.update([dm, group], dm.id, avatarClient);
  assert(recentBar.querySelector('.recent-dm-tile[data-room-id="!dm:test"] [aria-label="Offline"]'), "DM sidebar must refresh offline status");
  assert(!sidebar.querySelector('.room-row[data-room-id="!group:test"] .avatar-presence'), "Group room images must not show a person's status");
  peerPresence = null;
  memberPane.update(dm, avatarClient, "@me:test");
  assert(memberPane.querySelector('[aria-label="Presence unavailable"]'), "Unknown presence must not falsely claim offline");
  let nicknameValue: string | null = null, blockedUser = false, failUserSave = false;
  const userClient = {
    ...avatarClient, getUserNickname: () => nicknameValue,
    getIgnoredUsers: () => blockedUser ? ["@peer:test"] : [],
    setUserNickname: async (_id: string, value: string) => { if (failUserSave) throw new Error("Save failed"); nicknameValue = value.trim() || null; },
    ignoreUser: async (id: string) => { assert(id === "@peer:test", "Block must target the clicked person"); blockedUser = true; },
    unignoreUser: async () => { blockedUser = false; },
  } as unknown as MatrixClient;
  memberPane.update(dm, userClient, "@me:test");
  const roleSpace = createRoomRecord("!roles:test"); roleSpace.isSpace = true; roleSpace.title = "Friends";
  roleSpace.creator = "@peer:test";
  roleSpace.powerLevels = { users: { "@peer:test": 100, "@me:test": 50 } };
  memberPane.update(dm, userClient, "@me:test", roleSpace);
  assert(memberPane.querySelector('[data-user-id="@peer:test"] .member-owner-crown[aria-label="Space owner"] svg') && memberPane.querySelectorAll(".member-owner-crown").length === 1, "The space creator must have exactly one small accessible crown");
  assert(memberPane.querySelector('[data-user-id="@peer:test"] .member-role-badge.admin') && memberPane.querySelector('[data-user-id="@me:test"] .member-role-badge.moderator'), "Space admins and moderators must have separate role badges");
  assert([...memberPane.querySelectorAll(".member-role-heading")].map(node => node.textContent).join(",").includes("Admins — 1,Moderators — 1"), "Member lists must group admins before moderators");
  roleSpace.powerLevels = { users: { "@peer:test": 50, "@me:test": 0 } }; memberPane.update(dm, userClient, "@me:test", roleSpace);
  assert(!memberPane.querySelector(".member-role-badge.admin") && memberPane.querySelector('[data-user-id="@peer:test"] .member-role-badge.moderator'), "Changed power levels must refresh badges without membership changes");
  roleSpace.creator = "@me:test"; memberPane.update(dm, userClient, "@me:test", roleSpace);
  assert(memberPane.querySelector('[data-user-id="@me:test"] .member-owner-crown') && !memberPane.querySelector('[data-user-id="@peer:test"] .member-owner-crown'), "Changing space context must update the crowned identity");
  dm.powerLevels = { users: { "@peer:test": 100 } }; memberPane.update(dm, userClient, "@me:test");
  assert(!memberPane.querySelector(".member-owner-crown"), "Room admins outside a space must not get a space-owner crown");
  assert(memberPane.querySelector('[data-user-id="@peer:test"] .member-role-badge.admin'), "Outside a space, labels must use room roles");
  const userTile = memberPane.querySelector<HTMLElement>('[aria-label="User settings for Peer"]')!;
  userTile.click();
  assert(!document.querySelector(".user-settings-overlay"), "Left-click must not open user settings");
  userTile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const userDialog = document.querySelector<HTMLElement>('[aria-label="User settings"][role="dialog"]')!;
  assert(userDialog?.textContent?.includes("@peer:test"), "Right-clicking a member tile must open settings for that Matrix identity");
  const userPopover = document.querySelector<HTMLElement>(".user-settings-overlay")!;
  const popoverBounds = userPopover.getBoundingClientRect();
  assert(userPopover.matches(":popover-open") && popoverBounds.width <= 302 && popoverBounds.left >= 0 && popoverBounds.right <= innerWidth && popoverBounds.bottom <= innerHeight, "User settings must be a compact popover constrained to the viewport");
  assert(userDialog.getAttribute("aria-modal") === "false", "User settings must not block the interface with a modal overlay");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }));
  document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 2 }));
  assert(userPopover.matches(":popover-open"), "Opening pointer events must not immediately dismiss user settings");

  const nicknameInput = userDialog.querySelector<HTMLInputElement>('[aria-label="Nickname"]')!;
  nicknameInput.value = "Buddy"; userDialog.querySelector("form")!.requestSubmit(); await tick();
  memberPane.update(dm, userClient, "@me:test");
  assert(nicknameValue === "Buddy" && memberPane.textContent?.includes("Buddy"), "Saved nicknames must replace the visible member label");
  clickByText(userDialog, "Block user"); await tick();
  assert(blockedUser && userDialog.textContent?.includes("Unblock user"), "Blocking must persist and offer unblock");
  const blockedMessage = document.createElement("message-item"); document.body.append(blockedMessage);
  const blockedItem = { kind: "message" as const, id: "$blocked", sender: "@peer:test", senderName: "Peer", ts: Date.now(), msgtype: "m.text", body: "Hidden content", media: null };
  blockedMessage.update(blockedItem, { client: userClient, room: null });
  assert(blockedMessage.hidden && !blockedMessage.textContent, "Blocked messages must not expose content or load media");
  clickByText(userDialog, "Unblock user"); await tick(); blockedMessage.update(blockedItem, { client: userClient, room: null });
  assert(!blockedUser && !blockedMessage.hidden && blockedMessage.textContent?.includes("Buddy"), "Unblocking must restore messages with the saved nickname");
  failUserSave = true; nicknameInput.value = "Lost"; userDialog.querySelector("form")!.requestSubmit(); await tick();
  assert(userDialog.textContent?.includes("Save failed") && nicknameValue === "Buddy", "Failed saves must report errors and preserve the prior nickname");
  clickByText(userDialog, "Close"); assert(!document.querySelector(".user-settings-overlay"), "User settings must close cleanly");
  showUserMenu(userClient, "@peer:test", "Peer", userTile);
  const persistentPopover = document.querySelector<HTMLElement>(".user-settings-overlay")!;
  await new Promise(resolve => setTimeout(resolve, 3050));
  persistentPopover.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  assert(persistentPopover.matches(":popover-open"), "The popover must remain open while the user interacts inside it after three seconds");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  assert(!document.querySelector(".user-settings-overlay"), "Outside clicks must dismiss the popover after its three-second grace period");
  showUserMenu(userClient, "@peer:test", "Peer", userTile);
  const hoverPopover = document.querySelector<HTMLElement>(".user-settings-overlay")!;
  hoverPopover.dispatchEvent(new PointerEvent("pointerenter"));
  assert(hoverPopover.matches(":popover-open"), "Entering the popover must keep it open");
  hoverPopover.dispatchEvent(new PointerEvent("pointerleave"));
  assert(!document.querySelector(".user-settings-overlay"), "Leaving after entering must close immediately even within the opening three seconds");
  showUserMenu(userClient, "@me:test", "Me"); assert(!document.querySelector(".user-settings-overlay"), "Users must not be able to block themselves");
  const renamedTile = memberPane.querySelector<HTMLElement>('[aria-label="User settings for Buddy"]')!;
  renamedTile.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  assert(document.querySelector(".user-settings-overlay")?.matches(":popover-open"), "Shift+F10 must open user settings beside a focused tile");
  document.querySelector(".user-settings-overlay")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(!document.querySelector(".user-settings-overlay"), "Escape must dismiss user settings");
  blockedMessage.remove();
  memberPane.remove();
  dm.members.get("@peer:test")!.avatarMxc = null;
  sidebar.update([dm], [], dm.id, null, avatarClient);
  recentBar.update([dm], dm.id, avatarClient);
  await tick();
  sidebar.update([dm], [], dm.id, null, avatarClient);
  recentBar.update([dm], dm.id, avatarClient);
  await tick();
  assert(profileCalls === 1 && requestedAvatars.includes("mxc://test/global-peer"), "Missing room-member avatar must fall back to a cached profile lookup");
  dm.members.set("@third:test", { userId: "@third:test", displayname: "Third", avatarMxc: null, membership: "join" });
  resolveRoomMeta(dm, "@me:test", { "@peer:test": [dm.id] });
  assert(!dm.isDirect && dm.directUserId === null, "A group room must not retain a stale DM peer");
  group.members.set("@peer:test", { userId: "@peer:test", displayname: "Peer", avatarMxc: "mxc://test/peer", membership: "join" });
  group.members.set("@invited:test", { userId: "@invited:test", displayname: "Not joined", avatarMxc: null, membership: "invite" });
  const videoSpace = createRoomRecord("!video-space:test"); videoSpace.isSpace = true; videoSpace.title = "Our space";
  const videoRoom = createRoomRecord("!video:test"); videoRoom.roomType = "org.matrix.msc3417.call"; videoRoom.title = "Video lounge";
  videoSpace.children.add(group.id); videoSpace.children.add(videoRoom.id);
  sidebar.update([group, videoRoom], [videoSpace], group.id, videoSpace.id, avatarClient);
  assert([...sidebar.querySelectorAll(".sidebar-section")].some(node => node.textContent === "Text rooms"), "Spaces must label text room sections");
  assert([...sidebar.querySelectorAll(".sidebar-section")].some(node => node.textContent === "Video rooms"), "Spaces must label video room sections");
  assert(sidebar.querySelector('.room-row[data-room-id="!video:test"] [aria-label="Video room"]'), "Video rooms must have a distinct camera icon");
  const spaceHeader = sidebar.querySelector(".sidebar-head")!;
  assert(spaceHeader.querySelectorAll("button").length === 2 && spaceHeader.querySelector('[aria-label="Space settings"]') && spaceHeader.querySelector('[aria-label="Invite to space"] svg'), "Space header must contain only settings and an invite plus");
  assert(!sidebar.querySelector(".space-manage") && !sidebar.querySelector(".space-browse-rooms"), "Space management and discovery must not clutter the room list");
  let roomMenuAction: { spaceId: string; action: string } | null = null;
  sidebar.addEventListener("grungus:space-action", event => { roomMenuAction = (event as CustomEvent).detail; });
  const blankRoomList = sidebar.querySelector<HTMLElement>(".room-scroll")!;
  blankRoomList.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 150, clientY: 300 }));
  const roomMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Space room actions"]')!;
  assert(roomMenu?.textContent === "Create a room", "Right-clicking empty room-list space must offer room creation");
  clickByText(roomMenu, "Create a room");
  assert((roomMenuAction as { spaceId: string; action: string } | null)?.spaceId === videoSpace.id && (roomMenuAction as { action: string } | null)?.action === "create-room", "Blank-area room creation must target the selected space");
  sidebar.querySelector(".room-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert(!document.querySelector('[aria-label="Space room actions"]'), "Right-clicking an existing room must not open the empty-area menu");
  blankRoomList.focus(); blankRoomList.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  document.querySelector('[aria-label="Space room actions"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(document.activeElement === blankRoomList && !document.querySelector('[aria-label="Space room actions"]'), "Keyboard dismissal must restore focus to the room list");
  const testRail = document.createElement("space-rail"); document.body.append(testRail);
  const otherSpace = createRoomRecord("!other-space:test"); otherSpace.isSpace = true; otherSpace.title = "Other space";
  testRail.update([videoSpace, otherSpace], videoSpace.id, avatarClient);
  const otherIcon = testRail.querySelector<HTMLElement>('[aria-label="Other space"]')!;
  let spaceAction: { spaceId: string; action: string } | null = null;
  testRail.addEventListener("grungus:space-action", event => { spaceAction = (event as CustomEvent).detail; });
  otherIcon.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: innerWidth - 1, clientY: innerHeight - 1 }));
  const spaceMenu = document.querySelector<HTMLElement>(".space-context-menu")!;
  assert(spaceMenu?.querySelectorAll('[role="menuitem"]').length === 6 && otherIcon.getAttribute("aria-expanded") === "true", "Right-clicking a space picture must open its actions menu");
  assert(spaceMenu.getBoundingClientRect().right <= innerWidth && spaceMenu.getBoundingClientRect().bottom <= innerHeight, "Space menu must remain inside the viewport");
  spaceMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert(document.activeElement?.textContent === "New direct message", "Menu keyboard navigation must reach the last action");
  clickByText(spaceMenu, "Create a room");
  assert((spaceAction as { spaceId: string; action: string } | null)?.spaceId === otherSpace.id && (spaceAction as { action: string } | null)?.action === "create-room" && !document.querySelector(".space-context-menu"), "Menu actions must target the right-clicked space even when another space is selected");
  otherIcon.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  document.querySelector(".space-context-menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(!document.querySelector(".space-context-menu") && document.activeElement === otherIcon, "Keyboard menu dismissal must restore focus to the space picture");
  otherIcon.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  assert(!document.querySelector(".space-context-menu"), "Clicking outside the space menu must close it");
  testRail.remove();
  await tick();
  assert(!sidebar.querySelector('.sidebar-room[data-room-id="!group:test"] .sidebar-participants'), "Text rooms must never show sidebar participants");
  videoRoom.members = new Map(group.members);
  videoRoom.members.set("@idle:test", { userId: "@idle:test", displayname: "Idle member", avatarMxc: null, membership: "join" });
  const callMembership = { sender: "@peer:test", deviceId: "ONE", callId: "", expiresTs: Date.now() + 60000, focusUrl: null };
  videoRoom.rtcMemberships = [callMembership, { ...callMembership, deviceId: "TWO" }, { ...callMembership, sender: "@idle:test", expiresTs: Date.now() - 1000 }];
  sidebar.update([group, videoRoom], [videoSpace], group.id, videoSpace.id, avatarClient); await tick();
  const participants = sidebar.querySelector('.sidebar-room[data-room-id="!video:test"] .sidebar-participants')!;
  assert(participants.querySelectorAll("li").length === 1 && participants.textContent === "Peer" && participants.querySelector("g-avatar img"), "Video rooms must show only active call members, deduplicated across devices, with pictures and names");
  const roomFilter = sidebar.querySelector<HTMLInputElement>("#room-filter")!;
  roomFilter.value = "group"; roomFilter.dispatchEvent(new Event("input"));
  assert(sidebar.querySelector('.sidebar-room[data-room-id="!video:test"]')?.classList.contains("hidden"), "Filtering a video room must also hide its call participants");
  videoRoom.rtcMemberships = [{ ...callMembership, expiresTs: Date.now() + 50 }];
  sidebar.update([group, videoRoom], [videoSpace], group.id, videoSpace.id, avatarClient);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(sidebar.querySelector<HTMLElement>('.sidebar-room[data-room-id="!video:test"] .sidebar-participants')?.hidden, "Expired call participants must disappear even without another sync update");
  videoRoom.rtcMemberships = [];
  sidebar.update([group, videoRoom], [videoSpace], group.id, videoSpace.id, avatarClient);
  assert(sidebar.querySelector<HTMLElement>('.sidebar-room[data-room-id="!video:test"] .sidebar-participants')?.hidden, "Empty calls must show no participants");
  const recentFixtures = Array.from({ length: 7 }, (_, index) => {
    const fixture = createRoomRecord(`!recent${index}:test`); fixture.isDirect = true; fixture.title = `Friend ${index}`; fixture.lastActivityTs = index;
    fixture.members.set(`@friend${index}:test`, { userId: `@friend${index}:test`, displayname: `Friend ${index}`, avatarMxc: "mxc://test/peer", membership: "join" });
    return fixture;
  });
  recentBar.update(recentFixtures, recentFixtures[6]!.id, avatarClient);
  assert(recentBar.querySelectorAll(".recent-dm-tile").length === 5 && recentBar.querySelector(".recent-dm-tile")?.getAttribute("data-room-id") === "!recent6:test", "Recent DM box must show exactly five conversations in activity order");
  assert(recentBar.querySelector('.recent-dm-tile[data-room-id="!recent6:test"] button[aria-current="page"]'), "The selected recent DM must be marked active");
  const retainedTile = recentBar.querySelector('.recent-dm-tile[data-room-id="!recent3:test"]')!;
  recentBar.getAnimations({ subtree: true }).forEach(animation => animation.finish());
  recentFixtures[3]!.lastActivityTs = 100;
  recentBar.update(recentFixtures, recentFixtures[3]!.id, avatarClient);
  assert(recentBar.querySelector(".recent-dm-tile") === retainedTile, "Activity updates must reorder existing tiles rather than recreate them");
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) assert(recentBar.getAnimations({ subtree: true }).length > 0, "Recent DM reordering must animate movement");
  const runningAnimation = retainedTile.getAnimations()[0];
  recentBar.update(recentFixtures, recentFixtures[3]!.id, avatarClient);
  if (runningAnimation) assert(retainedTile.getAnimations().includes(runningAnimation), "Unchanged sync updates must not cancel the reorder animation");
  let recentSelection = "";
  recentBar.addEventListener("grungus:select-room", event => { recentSelection = (event as CustomEvent<{ roomId: string }>).detail.roomId; });
  retainedTile.querySelector<HTMLButtonElement>("button")!.click();
  assert(recentSelection === "!recent3:test", "Recent DM tiles must open their own conversation");
  const savedMatchMedia = window.matchMedia;
  window.matchMedia = query => query === "(prefers-reduced-motion: reduce)" ? { matches: true } as MediaQueryList : savedMatchMedia.call(window, query);
  recentFixtures[2]!.lastActivityTs = 101; recentBar.update(recentFixtures, null, avatarClient);
  assert(recentBar.getAnimations({ subtree: true }).length === 0, "Reduced-motion settings must disable reorder animations");
  window.matchMedia = savedMatchMedia;
  recentBar.update([], null, avatarClient); assert(recentBar.hidden, "The recent-DM box must hide when there are no conversations");
  sidebar.remove(); recentBar.remove();

  if (import.meta.env.VITE_EXPECT_KLIPY_KEY) assert(sharedKlipyApiKey === import.meta.env.VITE_EXPECT_KLIPY_KEY, "The build must include the configured application key");
  assert(configuredKlipyApiKey("") === sharedKlipyApiKey, "Friends must use the app owner's bundled KLIPY key without entering it again");
  assert(configuredKlipyApiKey("personal-key") === "personal-key", "A personal KLIPY override must take priority");
  const browser = document.createElement("room-browser");
  document.body.append(browser);
  let roomPage = 0;
  let joinedRoom = "";
  let directoryTerm = "";
  let failJoin = true;
  const directoryClient = {
    avatarSrc: () => Promise.resolve(null), getRoom: (id: string) => id === "!joined:test" ? {} : null,
    publicRooms: async (term: string, since?: string) => {
      directoryTerm = term;
      roomPage++;
      if (term === "empty") return { chunk: [] };
      if (term === "broken") throw new Error("Directory disabled");
      return since ? { chunk: [{ room_id: "!second:test", name: "Second room", num_joined_members: 2, join_rule: "public" }] } : {
        chunk: [
          { room_id: "!public:test", name: "Public lounge", topic: "Welcome everyone", num_joined_members: 12, join_rule: "public" },
          { room_id: "!locked:test", name: "Private club", num_joined_members: 3, join_rule: "invite" },
          { room_id: "!joined:test", name: "Already joined", num_joined_members: 5, join_rule: "public" },
        ], next_batch: "page-two",
      };
    },
    joinRoom: async (id: string) => { if (failJoin) throw new Error("Join forbidden"); return id; },
  } as unknown as MatrixClient;
  browser.addEventListener("grungus:room-joined", event => { joinedRoom = (event as CustomEvent<{ roomId: string }>).detail.roomId; });
  browser.show(directoryClient); await tick();
  assert(browser.textContent?.includes("Welcome everyone") && browser.textContent.includes("12 members"), "Directory must show room metadata");
  assert(browser.querySelector<HTMLButtonElement>('button[aria-label="Join Private club"]')?.disabled, "Restricted rooms must not offer an unconditional join");
  clickByText(browser, "Load more rooms"); await tick();
  assert(roomPage === 2 && browser.textContent?.includes("Second room") && browser.textContent.includes("Public lounge"), "Pagination must append rooms");
  browser.querySelector<HTMLButtonElement>('button[aria-label="Join Public lounge"]')!.click(); await tick();
  assert(browser.textContent?.includes("Join forbidden") && !browser.hidden, "Join failures must remain visible and retryable");
  assert(browser.querySelector<HTMLButtonElement>('button[aria-label="Join Private club"]')?.disabled, "Failed joins must preserve restricted buttons");
  failJoin = false;
  browser.querySelector<HTMLButtonElement>('button[aria-label="Join Public lounge"]')!.click(); await tick();
  assert(joinedRoom === "!public:test" && browser.hidden, "Joining must select the room and close discovery");
  browser.show(directoryClient); await tick();
  const directorySearch = browser.querySelector<HTMLInputElement>("input")!;
  directorySearch.value = "empty"; directorySearch.dispatchEvent(new Event("input"));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(directoryTerm === "empty" && browser.textContent?.includes("No rooms found"), "Search must replace results and show empty state");
  directorySearch.value = "broken"; directorySearch.dispatchEvent(new Event("input"));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(browser.textContent?.includes("Directory disabled"), "Directory errors must be visible");
  browser.hide();
  let hierarchySpace = "";
  let hierarchyFrom: string | undefined;
  let routedVia: string[] = [];
  const space = createRoomRecord("!space:test"); space.title = "Friends";
  const spaceClient = {
    ...directoryClient,
    publicRooms: async () => { throw new Error("Space browsing must not use the public directory"); },
    spaceHierarchy: async (id: string, from?: string) => {
      hierarchySpace = id; hierarchyFrom = from;
      return from ? { rooms: [{ room_id: "!later:test", name: "Later room", num_joined_members: 1, join_rule: "public", children_state: [] }] } : {
        rooms: [
          { room_id: space.id, name: "Friends", room_type: "m.space", children_state: [{ type: "m.space.child", state_key: "!members:remote.test", content: { via: ["remote.test"] } }] },
          { room_id: "!nested:test", room_type: "m.space", name: "Nested space", children_state: [] },
          { room_id: "!members:remote.test", name: "Members lounge", num_joined_members: 7, join_rule: "restricted", children_state: [] },
        ], next_batch: "space-next",
      };
    },
    joinRoom: async (id: string, via: string[]) => { routedVia = via; return id; },
  } as unknown as MatrixClient;
  let joinedSpace: string | null = null;
  browser.addEventListener("grungus:room-joined", event => { joinedSpace = (event as CustomEvent<{ spaceId: string }>).detail.spaceId; });
  browser.show(spaceClient, space); await tick();
  assert(hierarchySpace === space.id && browser.textContent?.includes("Rooms in Friends"), "Space discovery must fetch the selected space hierarchy");
  assert(!browser.textContent?.includes("Nested space"), "Space room list must exclude spaces themselves");
  assert(!browser.querySelector<HTMLButtonElement>('button[aria-label="Join Members lounge"]')?.disabled, "Space-restricted rooms must allow a join attempt");
  clickByText(browser, "Load more rooms"); await tick();
  assert(hierarchyFrom === "space-next" && browser.textContent?.includes("Later room"), "Space hierarchy pagination must append children");
  const spaceSearch = browser.querySelector<HTMLInputElement>("input")!;
  spaceSearch.value = "Members"; spaceSearch.dispatchEvent(new Event("input"));
  assert(browser.querySelectorAll(".room-directory-entry:not([hidden])").length === 1, "Space search must filter loaded rooms");
  browser.querySelector<HTMLButtonElement>('button[aria-label="Join Members lounge"]')!.click(); await tick();
  assert(String(joinedRoom) === "!members:remote.test" && joinedSpace === space.id && routedVia[0] === "remote.test", "Joining a space room must retain the selected space and route via the child's server");
  browser.remove();

  const newDm = document.createElement("new-dm-view");
  document.body.append(newDm);
  let openedDm = "";
  let createdDm = "";
  let searchedFor = "";
  let failSearch = false;
  let failStart = false;
  const dmClient = {
    userId: "@me:test", avatarSrc: async () => null,
    searchUsers: async (term: string) => {
      searchedFor = term;
      if (failSearch) throw new Error("Directory disabled");
      return { results: [{ user_id: "@friend:test", display_name: "<script>Friend</script>" }], limited: false };
    },
    startDirectMessage: async (user: string) => { if (failStart) throw new Error("Invite forbidden"); createdDm = user; return "!new-dm:test"; },
  } as unknown as MatrixClient;
  newDm.addEventListener("grungus:dm-created", event => { openedDm = (event as CustomEvent<{ roomId: string }>).detail.roomId; });
  newDm.show(dmClient);
  let dmSearch = newDm.querySelector<HTMLInputElement>("input")!;
  dmSearch.value = "friend"; dmSearch.dispatchEvent(new Event("input"));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(searchedFor === "friend" && newDm.querySelector(".dm-search-result"), "New DM search must show homeserver directory results");
  assert(!newDm.querySelector("script"), "Directory display names must render as text");
  newDm.querySelector<HTMLButtonElement>(".dm-search-result")!.click();
  await tick();
  assert(createdDm === "@friend:test" && openedDm === "!new-dm:test" && newDm.hidden, "Selecting a user must open their DM and close the dialog");
  failSearch = true; newDm.show(dmClient);
  dmSearch = newDm.querySelector<HTMLInputElement>("input")!;
  dmSearch.value = "@another:test"; dmSearch.dispatchEvent(new Event("input"));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(newDm.textContent?.includes("Directory disabled"), "Directory failures must be visible");
  clickByText(newDm, "Start chat with @another:test");
  await tick();
  assert(String(createdDm) === "@another:test", "A full Matrix ID must work even when the directory is unavailable");
  failStart = true; newDm.show(dmClient);
  dmSearch = newDm.querySelector<HTMLInputElement>("input")!;
  dmSearch.value = "@blocked:test"; dmSearch.dispatchEvent(new Event("input"));
  clickByText(newDm, "Start chat with @blocked:test");
  await tick();
  assert(!newDm.hidden && newDm.textContent?.includes("Invite forbidden") && !dmSearch.disabled, "Failed invitations must show an error and allow retry");
  failStart = false;

  newDm.show(dmClient);
  dmSearch = newDm.querySelector<HTMLInputElement>("input")!;
  dmSearch.value = "cancelled"; dmSearch.dispatchEvent(new Event("input"));
  newDm.hide();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(String(searchedFor) !== "cancelled", "Closing the dialog must cancel debounced search");
  newDm.remove();

  const sessionSettings = new SettingsView();
  document.body.append(sessionSettings);
  const devices = [
    { deviceId: "SELF", displayName: "This laptop", lastSeenTs: null, lastSeenIp: null },
    { deviceId: "OTHER", displayName: "Old phone", lastSeenTs: null, lastSeenIp: null },
  ];
  let renamedDevice = "";
  let clearedMedia = 0;
  let deleteCalls = 0;
  let releaseDelete: (() => void) | undefined;
  const settingsClient = {
    deviceId: "SELF", userId: "@me:test", accessToken: "token",
    getDevices: async () => [...devices], getIgnoredUsers: () => [], getProfile: async () => ({}),
    crypto: { getKeyBackupVersion: async () => ({ version: "1" }) },
    setDeviceName: async (id: string, name: string) => { assert(id === "SELF", "Rename must target the selected session"); renamedDevice = name; devices[0]!.displayName = name; },
    clearMediaCache: () => { clearedMedia++; },
    deleteDevices: async (ids: string[], password: string) => {
      deleteCalls++;
      assert(ids.length === 1 && ids[0] === "OTHER", "Session logout must target the selected device");
      if (password === "wrong") throw new Error("Incorrect password");
      assert(password === "correct", "Password must reach the existing UIA device logout flow");
      await new Promise<void>(resolve => { releaseDelete = resolve; });
      devices.splice(1, 1);
    },
  } as unknown as MatrixClient;
  sessionSettings.update(settingsClient, new SettingsStore(), null);
  sessionSettings.show("sessions");
  await tick();
  clickByText(sessionSettings, "Rename");
  const sessionName = sessionSettings.querySelector<HTMLInputElement>('[aria-label="Session name"]')!;
  sessionName.value = "My workstation";
  sessionSettings.querySelector<HTMLFormElement>('[aria-label="Rename this session"]')!.requestSubmit(); await tick();
  assert(renamedDevice === "My workstation" && sessionSettings.textContent?.includes("Device renamed"), "Session renaming must work through an inline form");
  clickByText(sessionSettings, "Log out");
  let devicePassword = sessionSettings.querySelector<HTMLInputElement>('input[type="password"]')!;
  assert(devicePassword && document.activeElement === devicePassword, "Session logout must display and focus an inline password field");
  clickByText(sessionSettings, "Cancel");
  assert(!sessionSettings.querySelector("form") && deleteCalls === 0, "Cancel must leave the device signed in");
  clickByText(sessionSettings, "Log out");
  devicePassword = sessionSettings.querySelector<HTMLInputElement>('input[type="password"]')!;
  devicePassword.value = "wrong";
  sessionSettings.querySelector("form")!.requestSubmit();
  await tick();
  assert(sessionSettings.textContent?.includes("Incorrect password"), "Failed session logout must show the server error");
  assert(devices.length === 2, "Failed authentication must preserve the session");
  clickByText(sessionSettings, "Log out");
  devicePassword = sessionSettings.querySelector<HTMLInputElement>('input[type="password"]')!;
  devicePassword.value = "correct";
  const logoutForm = sessionSettings.querySelector("form")!;
  logoutForm.requestSubmit(); logoutForm.requestSubmit();
  assert(Number(deleteCalls) === 2, "Pending session logout must prevent duplicate submissions");
  assert(devicePassword.value === "", "Submitted password must be cleared immediately");
  releaseDelete!();
  await tick();
  assert(sessionSettings.querySelectorAll(".device-row").length === 1, "Logged out device must disappear from the session list");
  assert(sessionSettings.textContent?.includes("Device logged out."), "Successful logout must show confirmation");
  let accountLogout = false;
  sessionSettings.addEventListener("grungus:logout", () => { accountLogout = true; });
  sessionSettings.show("account");
  await tick();
  clickByText(sessionSettings, "Log out");
  assert(accountLogout, "Account logout must dispatch the application's shared logout action");
  sessionSettings.show("security"); await tick();
  assert(sessionSettings.textContent?.includes("A recovery backup is available"), "Security settings must show actual server backup availability");
  let recoveryOpened = false;
  let verificationOpened = false;
  sessionSettings.addEventListener("grungus:open-backup", () => { recoveryOpened = true; });
  sessionSettings.addEventListener("grungus:verify-session", () => { verificationOpened = true; });
  clickByText(sessionSettings, "Manage recovery backup"); clickByText(sessionSettings, "Verify this session");
  assert(recoveryOpened && verificationOpened, "Security actions must open the app's real recovery and verification flows");
  const settingSearch = sessionSettings.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!;
  settingSearch.focus();
  settingSearch.value = "microphone"; settingSearch.dispatchEvent(new Event("input"));
  assert(document.activeElement?.getAttribute("aria-label") === "Search settings", "Settings search must preserve keyboard focus while filtering");
  assert(sessionSettings.querySelector(".settings-search-result")?.textContent === "Voice & Video", "Settings search must find controls by keyword");
  clickByText(sessionSettings, "Voice & Video"); await tick();
  assert(sessionSettings.querySelector('[aria-label="Microphone"]') && sessionSettings.textContent?.includes("Test camera"), "Device settings must expose selectors and explicit previews");
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia;
  const previewCanvas = document.createElement("canvas"); previewCanvas.width = 160; previewCanvas.height = 90;
  previewCanvas.getContext("2d")!.fillRect(0, 0, 160, 90);
  const previewStream = previewCanvas.captureStream(1);
  let previewRequests = 0;
  navigator.mediaDevices.getUserMedia = async constraints => {
    previewRequests++;
    assert(constraints?.audio === false && !!constraints?.video, "Camera test must not capture microphone audio");
    return previewStream;
  };
  try {
    assert(previewRequests === 0, "Opening device settings must not capture devices automatically");
    clickByText(sessionSettings, "Test camera"); await tick();
    assert(Number(previewRequests) === 1 && !sessionSettings.querySelector<HTMLVideoElement>(".settings-camera-preview")!.hidden, "Camera preview must start only after an explicit click");
    sessionSettings.show("advanced"); await tick();
    assert(previewStream.getTracks().every(track => track.readyState === "ended"), "Leaving Voice & Video must stop every preview track");
  } finally { navigator.mediaDevices.getUserMedia = nativeGetUserMedia; previewStream.getTracks().forEach(track => track.stop()); }

  clickByText(sessionSettings, "Clear downloaded media");
  assert(clearedMedia === 1 && settingsClient.accessToken === "token", "Clearing media must preserve the active session");
  assert(!sessionSettings.textContent?.includes("Reset device data & log out"), "Advanced settings must not offer the broken destructive cache reset");
  sessionSettings.show("notifications"); await tick();
  assert(sessionSettings.querySelector('[aria-label="Show message previews in notifications"]'), "Notifications must offer a private-preview control");
  sessionSettings.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(sessionSettings.hidden, "Escape must close settings");
  sessionSettings.remove();
  applyTheme("system");
  assert(document.body.classList.contains("theme-light") === matchMedia("(prefers-color-scheme: light)").matches, "System theme must follow the operating system");
  applyTheme("dark");
  const formatting = document.createElement("div");
  formatting.append(formatMessage('**bold** *italic* `code` ~~old~~ [safe](https://example.org) <img src=x onerror=alert(1)> [unsafe](javascript:alert(1))'));
  assert(formatting.querySelector("strong")?.textContent === "bold" && formatting.querySelector("code")?.textContent === "code", "Markdown must render supported formatting");
  assert(formatting.querySelectorAll("a").length === 1 && !formatting.querySelector("img"), "Markdown must never interpret HTML or unsafe URL schemes");
  formatting.replaceChildren(formatMessage("# Heading\n> Quote\n- First\n- Second\n1. Ordered\n```js\n<script>unsafe()</script>\n```"));
  assert(formatting.querySelector("h1")?.textContent === "Heading" && formatting.querySelectorAll("ul li").length === 2 && formatting.querySelector("ol li")?.textContent === "Ordered" && formatting.querySelector("blockquote")?.textContent === "Quote", "Block Markdown must render headings, quotes and both list styles");
  assert(!formatting.querySelector("script") && formatting.querySelector("pre code")?.textContent === "<script>unsafe()</script>", "Fenced code must stay literal");
  assert(emojiOnlyCount("👨‍👩‍👧‍👦 👍🏽 🇩🇪 1️⃣") === 4 && emojiOnlyCount("hello 😀") === 0 && emojiOnlyCount("123") === 0 && emojiOnlyCount("😀😀😀😀😀😀") === 0, "Large emojis must count complete graphemes and reject normal text");


  const callScreen = document.createElement("call-view");
  document.body.append(callScreen);
  let pickedMic = "";
  let pickedSpeaker = "";
  let failDevice = false;
  let savedDevice = "";
  const callController = {
    localCameraEnabled: false,
    setCameraEnabled: async (enabled: boolean) => { callController.localCameraEnabled = enabled; },
    localScreenStream: null as MediaStream | null, localStream: null, setMuted: () => {}, hangUp: () => {}, startScreenshare: () => {}, stopScreenshare: () => {},
    switchAudioInput: async (id: string) => { if (failDevice) throw new Error("Microphone disconnected"); pickedMic = id; },
    switchAudioOutput: async (id: string) => { pickedSpeaker = id; },
  };
  const callMuteChanges: boolean[] = [];
  callController.setMuted = (muted?: boolean) => { callMuteChanges.push(!!muted); };
  const callState = { active: true, roomId: "!call:test", participants: [], notice: null, localMuted: true, localSharing: false, localKey: "me" };
  callScreen.addEventListener("grungus:call-device", event => { savedDevice = (event as CustomEvent<{ deviceId: string }>).detail.deviceId; });
  callScreen.update(callState, callController); await tick();
  assert(callScreen.querySelector('[aria-label="Microphone"]') && callScreen.querySelector('[aria-label="Speaker"]'), "Call screen must expose microphone and speaker selectors");
  assert(callScreen.querySelector('[aria-label="Turn camera on"]') && !callController.localCameraEnabled, "Calls must enter with an optional camera disabled");
  callScreen.querySelector<HTMLButtonElement>('[aria-label="Turn camera on"]')!.click(); await tick();
  assert(callController.localCameraEnabled && callScreen.querySelector('[aria-label="Turn camera off"]'), "Camera must enable only through the explicit control");
  callScreen.querySelector<HTMLButtonElement>('[aria-label="Turn camera off"]')!.click(); await tick();
  assert(!callController.localCameraEnabled, "Camera control must allow returning to audio-only");
  assert(callScreen.querySelector(".call-avatar") && callScreen.textContent?.includes("1 participant"), "Audio-only calls must have an avatar and participant count");
  const pickCallDevice = async (label: string, value: string): Promise<void> => {
    const select = callScreen.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.append(new Option("Test device", value)); select.value = value; select.dispatchEvent(new Event("change")); await tick();
  };
  await pickCallDevice("Microphone", "test-microphone");
  assert(pickedMic === "test-microphone" && savedDevice === pickedMic, "Microphone selection must switch the live input and persist after success");
  failDevice = true;
  await pickCallDevice("Microphone", "unavailable-mic");
  assert(callScreen.textContent?.includes("Microphone disconnected") && savedDevice === "test-microphone", "Failed device changes must show an error and preserve the saved device");
  await pickCallDevice("Speaker", "test-speaker");
  assert(pickedSpeaker === "test-speaker", "Speaker selection must route through the active backend");
  await pickCallDevice("Speaker", "");
  assert(String(pickedSpeaker) === "", "System default must reset the speaker route");
  const pttCheckbox = callScreen.querySelector<HTMLInputElement>('[aria-label="Push to talk"]')!;
  pttCheckbox.click();
  assert(callMuteChanges.at(-1) === true, "Enabling push-to-talk must start muted");
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }));
  assert(callMuteChanges.at(-1) === false, "Holding the push-to-talk key must unmute");
  document.body.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true, cancelable: true }));
  assert(callMuteChanges.at(-1) === true, "Releasing the push-to-talk key must mute");
  const typingPtt = document.createElement("textarea"); document.body.append(typingPtt); typingPtt.focus();
  const muteCount = callMuteChanges.length;
  typingPtt.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }));
  assert(callMuteChanges.length === muteCount, "Typing into a textarea must not enable transmission"); typingPtt.remove();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })); window.dispatchEvent(new Event("blur"));
  assert(callMuteChanges.at(-1) === true, "Losing application focus must mute held push-to-talk");
  callScreen.querySelector<HTMLInputElement>('[aria-label="Push to talk"]')!.click();
  const callRoom = createRoomRecord("!call:test");
  callRoom.members.set("@video:test", { userId: "@video:test", displayname: "Video Friend", avatarMxc: "mxc://test/video-avatar", membership: "join" });
  callRoom.members.set("@second:test", { userId: "@second:test", displayname: "Second Friend", avatarMxc: "mxc://test/second-avatar", membership: "join" });
  callRoom.members.set("@me:test", { userId: "@me:test", displayname: "Me", avatarMxc: "mxc://test/my-avatar", membership: "join" });
  const callAvatars: string[] = [];
  callScreen.setClient({
    userId: "@me:test", getRoom: () => callRoom,
    avatarSrc: async (mxc: string) => { callAvatars.push(mxc); return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; },
    getProfile: async () => ({ avatar_url: "mxc://test/profile-fallback" }),
  } as unknown as MatrixClient);
  const cameraFixture = (): MediaStream => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    canvas.getContext("2d")!.fillRect(0, 0, 160, 90);
    return canvas.captureStream(1);
  };
  const cameraOne = cameraFixture();
  const cameraTwo = cameraFixture();
  const participant = { key: "friend-one", userId: "@video:test:DEVICE", deviceId: "DEVICE", name: "Video Friend", stream: cameraOne, screenStream: null, sharing: false, connectionState: "connected" };
  callScreen.update({ ...callState, participants: [participant] }, callController); await tick();
  assert(callScreen.querySelector(".call-layout.has-stage"), "A remote camera must activate the main stage and participant rail");
  assert(callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraOne, "The remote camera must move to the centre");
  const stageRect = callScreen.querySelector(".call-stage")!.getBoundingClientRect();
  const railRect = callScreen.querySelector(".call-grid")!.getBoundingClientRect();
  assert(stageRect.right <= railRect.left && stageRect.width > railRect.width, "Desktop layout must place the large video to the left of the participant column");
  assert([...callScreen.querySelectorAll("video")].filter(video => video.srcObject === cameraOne).length === 1, "Featuring a camera must not duplicate its audio or video playback");
  assert(callScreen.querySelector('.call-grid [data-participant-key="friend-one"] g-avatar img'), "Featured participants must remain identifiable by their avatar in the right column");
  assert(callAvatars.includes("mxc://test/video-avatar") && callAvatars.includes("mxc://test/my-avatar"), "Call avatars must resolve MatrixRTC user/device identities to room-member profile pictures");
  callScreen.update({ ...callState, localMuted: false, localSpeaking: true, participants: [{ ...participant, speaking: true }] }, callController);
  assert(callScreen.querySelector(".call-stage .call-tile.speaking"), "The main camera must highlight the speaking participant");
  assert(callScreen.querySelector('.call-grid [data-participant-key="friend-one"].speaking'), "The same participant must also highlight in the right column");
  assert(callScreen.querySelector('.call-grid [data-speaker-key="local"].speaking'), "Local speech must highlight the user's own tile");
  assert(callScreen.querySelector('.call-stage .call-speaking-indicator:not([hidden])')?.textContent === "Speaking", "Speech must have a visible text indicator as well as color");
  callScreen.update({ ...callState, localSpeaking: true, participants: [{ ...participant, speaking: false }] }, callController);
  assert(!callScreen.querySelector(".call-tile.speaking"), "Silent participants and a muted local microphone must not remain highlighted");
  const secondParticipant = { ...participant, key: "friend-two", userId: "@second:test", name: "Second Friend", stream: cameraTwo };
  callScreen.update({ ...callState, participants: [participant, secondParticipant] }, callController); await tick();
  assert(callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraTwo, "A newly started remote camera must be featured automatically");
  assert(callScreen.querySelectorAll(".call-stage .call-tile").length === 2 && callScreen.querySelector(".call-stage.multiple-streams"), "Multiple cameras must render together in the central grid");
  assert([...callScreen.querySelectorAll("video")].filter(video => video.srcObject === cameraOne).length === 1, "Moving all cameras onto the stage must not duplicate playback in the rail");

  callScreen.querySelector<HTMLButtonElement>('[aria-label="Feature Video Friend video"]')!.click();
  assert(callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraOne, "Participants must be able to choose a different camera for the stage");
  callScreen.update({ ...callState, participants: [{ ...participant, sharing: true, screenStream: cameraTwo }, secondParticipant] }, callController);
  assert(callScreen.querySelector('[aria-label="Shared screen"]') && callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraTwo, "Screen sharing must take priority over camera feeds");
  const screenOne = cameraFixture(), screenTwo = cameraFixture(), localScreen = cameraFixture();
  callController.localScreenStream = localScreen;
  callScreen.update({ ...callState, localSharing: true, participants: [{ ...participant, sharing: true, screenStream: screenOne }, { ...secondParticipant, sharing: true, screenStream: screenTwo }] }, callController);
  const allStreams = [...callScreen.querySelectorAll<HTMLVideoElement>(".call-stage video")];
  assert(allStreams.length === 5 && [cameraOne, cameraTwo, screenOne, screenTwo, localScreen].every(stream => allStreams.filter(video => video.srcObject === stream).length === 1), "Two cameras, two remote shares and the local share must all play exactly once");
  assert(allStreams.find(video => video.srcObject === localScreen)?.muted, "Local screen preview must stay muted");
  const peerVolume = callScreen.querySelector<HTMLInputElement>('[aria-label="Volume for Video Friend"]')!;
  peerVolume.value = "35"; peerVolume.dispatchEvent(new Event("input"));
  assert(allStreams.filter(video => video.srcObject === cameraOne || video.srcObject === screenOne).every(video => Math.abs(video.volume - .35) < .001), "Per-participant volume must affect both camera and shared-screen audio");
  callScreen.querySelector<HTMLButtonElement>('[aria-label="Mute Video Friend locally"]')!.click();
  assert(allStreams.find(video => video.srcObject === cameraOne)?.muted && !allStreams.find(video => video.srcObject === cameraTwo)?.muted, "Local mute must affect only the selected participant");
  clickByText(callScreen, "Deafen");
  assert([...callScreen.querySelectorAll("video")].every(video => video.muted) && callMuteChanges.at(-1) === true, "Deafen must mute incoming audio and the microphone");
  clickByText(callScreen, "Undeafen");
  assert([...callScreen.querySelectorAll("video")].find(video => video.srcObject === cameraOne)?.muted && ![...callScreen.querySelectorAll("video")].find(video => video.srcObject === cameraTwo)?.muted, "Undeafen must preserve individual participant mute choices");
  const removedShare = allStreams.find(video => video.srcObject === screenTwo)!;
  callScreen.update({ ...callState, participants: [participant] }, callController);
  assert(removedShare.srcObject === null && callScreen.querySelectorAll(".call-stage .call-tile").length === 1, "Ending shares and leaving participants must release obsolete media and restore the single stage");
  screenOne.getTracks().forEach(track => track.stop()); screenTwo.getTracks().forEach(track => track.stop()); localScreen.getTracks().forEach(track => track.stop());
  cameraOne.getVideoTracks()[0]!.enabled = false;
  cameraOne.getVideoTracks()[0]!.dispatchEvent(new Event("mute"));
  assert(!callScreen.querySelector(".call-layout.has-stage"), "Stopping the last remote camera must restore the participant grid");
  assert(callScreen.querySelector('.call-grid [data-participant-key="friend-one"] .call-avatar g-avatar'), "Camera-off tiles must show the user's profile picture");
  cameraOne.getTracks().forEach(track => track.stop()); cameraTwo.getTracks().forEach(track => track.stop());
  callScreen.update({ ...callState, active: false }, callController);
  assert(!callScreen.classList.contains("call-overlay") && !callScreen.querySelector("video"), "Ending the call must clear the call overlay and media elements");
  callScreen.remove();

  const backgroundSettings = new SettingsStore();
  const appearanceView = new SettingsView();
  document.body.append(appearanceView);
  const appearanceClient = { getDevices: async () => [], getIgnoredUsers: () => [], userId: null } as unknown as MatrixClient;
  appearanceView.update(appearanceClient, backgroundSettings, null);
  const stopBackgroundUpdates = backgroundSettings.subscribe(value => applyBackground(value.backgroundImage));
  appearanceView.show("appearance"); await tick();
  const pictureCanvas = document.createElement("canvas"); pictureCanvas.width = 2000; pictureCanvas.height = 1200;
  pictureCanvas.getContext("2d")!.fillRect(0, 0, 2000, 1200);
  const pictureBlob = await new Promise<Blob>(resolve => pictureCanvas.toBlob(blob => resolve(blob!), "image/png"));
  const pictureFile = new File([pictureBlob], "background.png", { type: "image/png" });
  const resized = await prepareBackground(pictureFile);
  const decoded = new Image(); decoded.src = resized; await decoded.decode();
  assert(decoded.naturalWidth === 1600 && decoded.naturalHeight === 960, "Background pictures must be resized before local storage");
  const backgroundInput = appearanceView.querySelector<HTMLInputElement>('[aria-label="Background picture"]')!;
  const selectedBackground = new DataTransfer(); selectedBackground.items.add(pictureFile);
  backgroundInput.files = selectedBackground.files; backgroundInput.dispatchEvent(new Event("change"));
  for (let attempt = 0; attempt < 100 && !appearanceView.querySelector(".background-preview"); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(appearanceView.querySelector(".background-preview") && document.body.classList.contains("custom-background"), "Choosing a background must save it, show a preview, and enable translucent panels");
  assert(new SettingsStore().get("backgroundImage") === backgroundSettings.get("backgroundImage"), "Custom backgrounds must survive a settings reload");
  assert(getComputedStyle(document.body, "::before").filter === "blur(4px)", "The background picture must be only slightly diffused");
  const glassProbe = document.createElement("room-list"); document.body.append(glassProbe);
  assert(getComputedStyle(glassProbe).backgroundColor.includes("0.52"), "Dark panels must become translucent");
  assert(getComputedStyle(glassProbe).borderRightWidth === "1px", "Glass panels must retain distinct box outlines");
  document.body.classList.add("theme-light");
  assert(getComputedStyle(glassProbe).backgroundColor.includes("0.62"), "Light mode must use its own translucent surface");
  document.body.classList.remove("theme-light"); glassProbe.remove();
  clickByText(appearanceView, "Remove background");
  assert(!document.body.classList.contains("custom-background") && !document.body.style.getPropertyValue("--app-background-image"), "Removing a background must restore the original solid interface");
  assert(!new SettingsStore().get("backgroundImage"), "Removing a background must persist across reloads");
  let badImageRejected = false;
  try { await prepareBackground(new File(["invalid image"], "broken.png", { type: "image/png" })); } catch { badImageRejected = true; }
  assert(badImageRejected, "Invalid images must be rejected without changing the saved background");
  stopBackgroundUpdates(); appearanceView.hide(); appearanceView.remove();

  {
  // Room navigation features: mention selection, message context, media and organization.
  const featureRoom = createRoomRecord("!features:test"); featureRoom.title = "Features";
  featureRoom.members.set("@friend:test", { userId: "@friend:test", displayname: "Friend", avatarMxc: null, membership: "join" });
  featureRoom.members.set("@blocked:test", { userId: "@blocked:test", displayname: "Buddy blocked", avatarMxc: null, membership: "join" });
  featureRoom.timeline = Array.from({ length: 140 }, (_, index) => ({ kind: "message", id: `$feature${index}`, sender: "@friend:test", senderName: "Friend", ts: 1000 + index, msgtype: "m.text", body: `Feature ${index}`, media: null }));
  featureRoom.timeline.push({ kind: "message", id: "$file", sender: "@friend:test", senderName: "Friend", ts: 2000, msgtype: "m.file", body: "notes.txt", media: { name: "notes.txt", mimetype: "text/plain", mxc: "mxc://test/file", width: null, height: null, size: 12 } } as MessageItem);
  const contextItem = { ...featureRoom.timeline[0]!, id: "$remote-target", body: "Old context target" } as MessageItem;
  let contextRequests = 0;
  const featureClient = { userId: "@me:test", avatarSrc: async () => null, mediaSrc: async () => null, getRoom: () => featureRoom,
    getIgnoredUsers: () => ["@blocked:test"], getUserNickname: (id: string) => id === "@friend:test" ? "Buddy" : null,
    getMessageContext: async () => { contextRequests++; return { items: [contextItem], before: "context-back", after: undefined }; },
    getContextPage: async () => ({ items: [{ ...contextItem, id: "$older-context", body: "Earlier context" }], next: undefined }),
  } as unknown as MatrixClient;
  const featureChat = new ChatView(); document.body.append(featureChat); featureChat.setRoom(featureRoom, featureClient, "@me:test");
  const mentionInput = featureChat.querySelector<HTMLTextAreaElement>("textarea")!;
  let accidentalSends = 0; featureChat.addEventListener("grungus:send", () => { accidentalSends++; });
  mentionInput.value = "Hello @Bud"; mentionInput.setSelectionRange(10, 10); mentionInput.dispatchEvent(new Event("input"));
  assert(featureChat.querySelectorAll('.mention-suggestions [role="option"]').length === 1 && featureChat.querySelector(".mention-suggestions")?.textContent?.includes("Buddy"), "Mention completion must search nicknames and omit blocked members");
  mentionInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert(mentionInput.value === "Hello @friend:test " && accidentalSends === 0 && !featureChat.querySelector(".mention-suggestions"), "Enter must insert a real Matrix identity without sending the message");
  featureChat.dispatchEvent(new CustomEvent("grungus:jump-message", { detail: { eventId: "$feature1" } })); await tick();
  assert(featureChat.querySelector<HTMLElement>('.message-jump-target')?.dataset.eventId === "$feature1" && contextRequests === 0, "Jumps must reveal and highlight loaded messages outside the visible window");
  featureChat.dispatchEvent(new CustomEvent("grungus:jump-message", { detail: { eventId: "$remote-target" } })); await tick();
  assert(Number(contextRequests) === 1 && featureChat.textContent?.includes("Old context target") && featureRoom.timeline.length === 141, "Unloaded jumps must show server context without replacing the live timeline");
  clickByText(featureChat, "Earlier messages"); await tick();
  assert(featureChat.textContent?.includes("Earlier context"), "Context view must support fetching surrounding history");
  clickByText(featureChat, "Latest messages");
  assert(featureChat.textContent?.includes("Feature 139") && !featureChat.textContent?.includes("Old context target"), "Latest messages must return from context to the live timeline");
  featureChat.querySelector<HTMLButtonElement>('[aria-label="Room media gallery"]')!.click();
  const mediaTools = featureChat.querySelector("room-tools")!;
  assert(mediaTools.querySelectorAll(".media-gallery message-item").length === 1 && mediaTools.textContent?.includes("notes.txt"), "Room gallery must list attachments and omit ordinary text");
  const mediaFilter = mediaTools.querySelector<HTMLSelectElement>('[aria-label="Media type"]')!; mediaFilter.value = "m.image"; mediaFilter.dispatchEvent(new Event("change"));
  assert(mediaTools.querySelectorAll(".media-gallery message-item").length === 0, "Gallery filtering must separate media types");
  clickByText(mediaTools, "Close"); featureChat.remove();
  const organized = document.createElement("room-list"); document.body.append(organized);
  const orgRooms = ["One", "Two", "Three"].map(title => { const value = createRoomRecord(`!order-${title}:test`); value.title = title; return value; });
  organized.update(orgRooms, [], null, null, featureClient);
  organized.querySelector<HTMLButtonElement>('[aria-label="Move up: Three"]')!.click();
  assert([...organized.querySelectorAll<HTMLElement>(".sidebar-room")].map(node => node.dataset.roomId).join(",") === [orgRooms[0]!.id, orgRooms[2]!.id, orgRooms[1]!.id].join(","), "Move buttons must reorder rooms");
  organized.querySelector<HTMLButtonElement>('[aria-label="Favorite: Two"]')!.click();
  organized.update(orgRooms, [], null, null, featureClient);
  assert(organized.querySelector(".sidebar-section")?.textContent === "Favorites" && organized.querySelector<HTMLElement>(".sidebar-room")?.dataset.roomId === orgRooms[1]!.id, "Favorites must remain first after room-list updates");
  organized.querySelector<HTMLButtonElement>('[aria-label="Remove favorite: Two"]')!.click();
  for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i)!; if (key.startsWith("grungus.rooms.")) localStorage.removeItem(key); }
  organized.remove();
  }

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
  assert(chat.querySelector(".encryption-label")?.textContent === "Not encrypted", "Plaintext rooms must explicitly show their encryption status");
  assert(chat.querySelector(".chat-encryption-status")?.textContent?.includes("not end-to-end encrypted"), "Composer must disclose plaintext messages");
  for (const direct of [false, true]) {
    room.isDirect = direct; room.isEncrypted = true;
    chat.setRoom(room, client, "@me:test");
    assert(chat.querySelector(".encryption-label")?.textContent === "End-to-end encrypted", "Rooms and DMs must show E2EE when enabled");
    assert(chat.querySelector(".chat-encryption-status")?.textContent === "New messages are end-to-end encrypted.", "Encryption status must apply to new messages without claiming old history is encrypted");
    room.isEncrypted = false;
    chat.setRoom(room, client, "@me:test");
    assert(chat.querySelector(".encryption-label")?.textContent === "Not encrypted", "Encryption status must refresh on room state changes");
  }
  chat.clearRoom();
  assert(chat.querySelector<HTMLElement>(".chat-encryption-status")!.hidden && !chat.querySelector(".encryption-label"), "No selected room must clear encryption status");
  room.isDirect = false;
  chat.setRoom(room, client, "@me:test");
  let persistentJoins = 0;
  let adHocStarts = 0;
  chat.addEventListener("grungus:join-room-call", () => { persistentJoins++; });
  chat.addEventListener("grungus:start-call", () => { adHocStarts++; });
  for (const roomType of ["org.matrix.msc3417.call", "io.element.video"]) {
    room.roomType = roomType;
    chat.setRoom(room, client, "@me:test"); chat.setCallState(false, false);
    assert(!chat.querySelector('[aria-label="Start a call"]') && !chat.querySelector('[aria-label="Start a video call"]'), "Empty video rooms must never offer ad-hoc start buttons");
    assert(chat.querySelector('[aria-label="Start room call"]'), "Empty video rooms must offer Start call");
    chat.setCallState(true, false);
    assert(chat.querySelector('[aria-label="Join persistent call"]'), "Occupied video rooms must offer Join call");
    chat.querySelector<HTMLButtonElement>('[aria-label="Join persistent call"]')!.click();
    chat.setCallState(true, true);
    assert(!chat.querySelector('[aria-label="Join persistent call"]') && chat.textContent?.includes("in call"), "Joined video rooms must show the active call state");
    chat.setCallState(false, false);
    assert(chat.querySelector('[aria-label="Start room call"]'), "Empty video rooms must allow starting a fresh call after leaving");
  }
  assert(persistentJoins === 2 && adHocStarts === 0, "Video rooms must use the persistent join action exclusively");
  chat.setCallConnecting(true);
  assert(chat.querySelector<HTMLButtonElement>('[aria-label="Connecting to call"]')?.disabled, "Call connection must provide feedback and prevent duplicate actions");
  chat.setCallConnecting(false);
  const activityRoom = createRoomRecord("!activity:test"); activityRoom.title = "Call activity";
  activityRoom.timeline = [
    { kind: "system", id: "$started", ts: 1000, text: "Friend: Call started", callActivity: "started", matrixRtc: true },
    { kind: "system", id: "$ended", ts: 2000, text: "Friend: Call ended", callActivity: "ended", matrixRtc: true },
  ];
  chat.setRoom(activityRoom, client, "@me:test");
  assert(chat.querySelectorAll(".timeline-call-card").length === 2, "Call history must render visible activity cards");
  assert(chat.querySelectorAll('[aria-label="Open room call"]').length === 1, "Ended call history must not offer a join action");
  chat.querySelector<HTMLButtonElement>('[aria-label="Open room call"]')!.click();
  assert(Number(persistentJoins) === 3, "Call activity must connect to the actual room call");
  room.roomType = null;
  chat.setRoom(room, client, "@me:test");
  assert(chat.querySelector('[aria-label="Start a call"]'), "Text rooms must retain their ordinary call controls");
  chat.setTypingUsers(["Friend"]);
  chat.applyPreferences({ enterToSend: true, sendTyping: true, showTimestamps: true, showTyping: false });
  assert(chat.querySelector(".typing-bar")?.textContent === "", "Typing display preference must hide incoming indicators");
  chat.applyPreferences({ enterToSend: true, sendTyping: true, showTimestamps: true, showTyping: true });
  assert(chat.querySelector(".typing-bar")?.textContent?.includes("Friend"), "Re-enabling typing display must restore current indicator state");
  let typingNickname: string | null = "Buddy";
  const typingClient = { ...client, getUserNickname: (id: string) => id === "@typer:test" ? typingNickname : null, getIgnoredUsers: () => ["@blocked:test"] } as unknown as MatrixClient;
  room.members.set("@typer:test", { userId: "@typer:test", displayname: "Profile Name", avatarMxc: null, membership: "join" });
  room.typingUsers = ["@typer:test", "@blocked:test", "@me:test"];
  chat.setRoom(room, typingClient, "@me:test");
  assert(chat.querySelector(".typing-bar")?.textContent === "Buddy is typing…", "Typing must use nicknames and omit blocked users and yourself");
  typingNickname = "New Buddy"; chat.setRoom(room, typingClient, "@me:test");
  assert(chat.querySelector(".typing-bar")?.textContent === "New Buddy is typing…", "Nickname edits must refresh an already-visible typing indicator");
  typingNickname = null; chat.setTypingUsers(room.typingUsers);
  assert(chat.querySelector(".typing-bar")?.textContent === "Profile Name is typing…", "Cleared nicknames must fall back to room profile names");
  chat.setTypingUsers(["@unknown:test", "@typer:test", "@third:test"]);
  assert(chat.querySelector(".typing-bar")?.textContent === "unknown, Profile Name and others are typing…", "Multiple typers must retain the existing summary with profile and Matrix ID fallbacks");
  room.typingUsers = []; chat.setRoom(room, client, "@me:test");
  assert(chat.querySelector(".typing-bar")?.textContent === "", "Room updates must clear stale typing indicators");
  const formattedMessage = document.createElement("message-item");
  document.body.append(formattedMessage);
  const mentionRoom = createRoomRecord("!mentions:test");
  mentionRoom.members.set("@me:test", { userId: "@me:test", displayname: "Me", avatarMxc: null, membership: "join" });
  mentionRoom.members.set("@friend:test", { userId: "@friend:test", displayname: "Friend", avatarMxc: null, membership: "join" });
  const mentionOptions = { client: typingClient, room: mentionRoom, meUserId: "@me:test" };
  formattedMessage.update({ ...timeline[0]!, body: "Hi @me:test and @friend:test. `@me:test`", mentions: ["@me:test", "@friend:test"] }, mentionOptions);
  assert(formattedMessage.classList.contains("mentions-me") && formattedMessage.querySelectorAll(".message-mention").length === 2, "Mentions must render inline and highlight messages mentioning you while leaving code intact");
  assert(formattedMessage.querySelector(".message-mention.mine")?.textContent === "@Me" && formattedMessage.querySelector("code")?.textContent === "@me:test", "Mention pills must use readable profile names without modifying code");
  formattedMessage.update({ ...timeline[0]!, body: "Hello Me!", mentions: ["@me:test"] }, mentionOptions);
  assert(formattedMessage.classList.contains("mentions-me") && formattedMessage.querySelector(".message-mention.mine"), "Metadata mentions from other clients must highlight display names");
  formattedMessage.update({ ...timeline[0]!, body: "Hello @room", roomMention: true }, mentionOptions);
  assert(formattedMessage.classList.contains("mentions-me") && formattedMessage.querySelector(".message-mention")?.textContent === "@room", "Room-wide mentions must highlight their label and message");
  formattedMessage.update({ ...timeline[0]!, body: "Hi @me:testing and <script>unsafe</script>", mentions: [] }, mentionOptions);
  assert(!formattedMessage.classList.contains("mentions-me") && !formattedMessage.querySelector(".message-mention,script"), "Partial IDs and HTML must not create mentions or executable content; redraws must clear previous highlights");
  const formattedItem = { ...timeline[0]!, body: "**formatted**" };
  formattedMessage.update(formattedItem, { client: null, room: null, renderMarkdown: true });
  assert(formattedMessage.querySelector(".msg-body strong")?.textContent === "formatted", "Markdown preferences must apply to message rendering");
  formattedMessage.update(formattedItem, { client: null, room: null, renderMarkdown: false });
  assert(!formattedMessage.querySelector("strong") && formattedMessage.querySelector(".msg-body")?.textContent === "**formatted**", "Turning Markdown off must preserve literal message text");
  formattedMessage.update({ ...formattedItem, msgtype: "m.text", body: "👨‍👩‍👧‍👦 👍🏽" }, { client: null, room: null, renderMarkdown: true });
  assert(!!formattedMessage.querySelector(".msg-big-emoji"), "Emoji-only messages must use the large display style");
  formattedMessage.update({ ...formattedItem, msgtype: "m.text", body: "Hello 😀" }, { client: null, room: null, renderMarkdown: true });
  assert(!formattedMessage.querySelector(".msg-big-emoji"), "Normal messages must retain the usual text size");
  formattedMessage.remove();
  const messageInput = chat.querySelector<HTMLTextAreaElement>("textarea")!;
  messageInput.value = "hello world";
  messageInput.setSelectionRange(6, 11);
  clickByText(chat, "☺");
  const picker = chat.querySelector("emoji-picker")!;
  assert(!picker.hidden, "Composer must open the emoji picker");
  const emojiSearch = picker.querySelector<HTMLInputElement>('input[type="search"]')!;
  emojiSearch.value = "daumen";
  emojiSearch.dispatchEvent(new Event("input"));
  assert(picker.querySelectorAll(".emoji-grid button").length >= 1, "Emoji search must support German keywords");
  clickByText(picker, "👍");
  assert(messageInput.value === "hello 👍", "Emoji must replace the selected text at the cursor");
  assert(picker.hidden && document.activeElement === messageInput, "Choosing an emoji must close picker and focus composer");
  clickByText(chat, "☺");
  picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(picker.hidden, "Escape must close the emoji picker");
  clickByText(chat, "☺");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  assert(picker.hidden, "Clicking outside must close emoji picker");
  clickByText(chat, "☺");
  chat.setRoom(null, client, "@me:test");
  assert(picker.hidden, "Changing room must close emoji picker");
  chat.setRoom(room, client, "@me:test");
  messageInput.value = "";
  clickByText(chat, "GIF");
  const gifPicker = chat.querySelector("gif-picker")!;
  assert(!gifPicker.hidden && gifPicker.textContent?.includes("API key"), "GIF picker must explain missing API key");
  gifPicker.close(false);
  const originalFetch = window.fetch;
  let apiCalls = 0;
  let gifUrl: string | null = null;
  chat.addEventListener("grungus:send-gif", event => { gifUrl = (event as CustomEvent<{ url: string }>).detail.url; });
  try {
    window.fetch = async input => {
      if (String(input).startsWith("https://api.klipy.com")) {
        apiCalls++;
        return Response.json({ result: true, data: { data: [{ id: "test", title: "Test GIF", file: { sm: { gif: { url: "https://static.klipy.com/test.gif" } }, hd: { gif: { url: "https://static.klipy.com/test.gif" } } } }], has_next: false } });
      }
      return new Response("GIF89a-test");
    };
    chat.setKlipyApiKey("test-key");
    clickByText(chat, "GIF");
    for (let attempt = 0; attempt < 100 && !gifPicker.querySelector(".gif-grid button"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(apiCalls === 1 && gifPicker.querySelectorAll(".gif-grid button").length === 1, `GIF picker must load trending results: ${apiCalls} calls, ${gifPicker.querySelectorAll(".gif-grid button").length} results`);
    gifPicker.querySelector<HTMLButtonElement>(".gif-grid button")!.click();
    for (let attempt = 0; attempt < 100 && !gifUrl; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(gifUrl === "https://static.klipy.com/test.gif", "Selected GIF must share the provider URL without rehosting its media");
    assert(gifPicker.hidden, "GIF picker must close after selection");
    clickByText(chat, "GIF");
    const gifSearch = gifPicker.querySelector<HTMLInputElement>("input")!;
    gifSearch.value = "cats"; gifSearch.dispatchEvent(new Event("input"));
    chat.setRoom(null, client, "@me:test");
    const callsBefore = apiCalls;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert(gifPicker.hidden && apiCalls === callsBefore, "Room change must cancel pending GIF search");
    chat.setRoom(room, client, "@me:test");
  } finally { window.fetch = originalFetch; }


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
  const attachmentEvents: File[] = [];
  chat.addEventListener("grungus:send-media", event => attachmentEvents.push((event as CustomEvent<{ file: File }>).detail.file));
  const uploadFiles = new DataTransfer();
  uploadFiles.items.add(new File(["webm"], "clip.webm")); uploadFiles.items.add(new File(["document"], "notes.pdf", { type: "application/pdf" }));
  const attachmentInput = chat.querySelector<HTMLInputElement>('[aria-label="Choose attachments"]')!;
  attachmentInput.files = uploadFiles.files; attachmentInput.dispatchEvent(new Event("change"));
  assert(attachmentInput.multiple && attachmentEvents.length === 2 && attachmentEvents[0]?.name === "clip.webm", "Attachment picker must accept multiple files including WebM with no MIME type");
  chat.querySelector(".composer-wrap")!.dispatchEvent(new DragEvent("drop", { dataTransfer: (() => { const data = new DataTransfer(); attachmentEvents.slice(0, 2).forEach(file => data.items.add(file)); return data; })(), bubbles: true, cancelable: true }));
  assert(Number(attachmentEvents.length) === 4, "Dropping files must send each attachment");
  chat.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: (() => { const data = new DataTransfer(); attachmentEvents.slice(0, 2).forEach(file => data.items.add(file)); return data; })(), bubbles: true, cancelable: true }));
  assert(Number(attachmentEvents.length) === 6, "Pasted files must use the attachment upload path");
  const recordingStream = cameraFixture();
  const recording = new MediaRecorder(recordingStream, { mimeType: "video/webm;codecs=vp8" });
  const chunks: Blob[] = [];
  recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const recorded = new Promise<Blob>(resolve => { recording.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
  recording.start(); await new Promise(resolve => setTimeout(resolve, 200)); recording.stop();
  const playableWebm = URL.createObjectURL(await recorded);
  recordingStream.getTracks().forEach(track => track.stop());
  const uploadedMessage = document.createElement("message-item"); document.body.append(uploadedMessage);
  let mediaRequest: unknown[] = [];
  const attachmentClient = { mediaSrc: async (...args: unknown[]) => { mediaRequest = args; return playableWebm; } } as unknown as MatrixClient;
  const encryptedFile = { url: "mxc://test/video" } as import("../src/renderer/services/attachments.ts").EncryptedFile;
  uploadedMessage.update({ ...timeline[0]!, msgtype: "m.video", body: "Schicksalsschlag.webm", media: { mxc: "mxc://test/video", file: encryptedFile, mimetype: "video/webm", name: "Schicksalsschlag.webm", width: null, height: null, size: 100 } }, { client: attachmentClient, room: null });
  await Promise.resolve(); await Promise.resolve();
  const uploadedVideo = uploadedMessage.querySelector<HTMLVideoElement>("video")!;
  assert(uploadedVideo?.controls && !uploadedVideo.autoplay && uploadedMessage.querySelector<HTMLAnchorElement>("a")?.download === "Schicksalsschlag.webm", "Uploaded WebM must show a player with controls and a named download link without autoplay");
  assert(mediaRequest[1] === encryptedFile && mediaRequest[2] === "video/webm", "Video playback must use the encrypted authenticated media download path");
  uploadedVideo.muted = true;
  await uploadedVideo.play();
  assert(uploadedVideo.videoWidth > 0, "A real VP8 WebM attachment must decode under the app media security policy");

  uploadedVideo.dispatchEvent(new Event("error"));
  assert(uploadedMessage.textContent?.includes("another player") && uploadedMessage.querySelector("a"), "Unsupported codecs must retain a working download fallback");
  uploadedMessage.remove(); URL.revokeObjectURL(playableWebm);
  const reactionMessage = document.createElement("message-item");
  document.body.append(reactionMessage);
  let chosenReaction = "";
  reactionMessage.update(timeline[0]!, { client: null, room: null }, { onReact: (message, emoji) => {
    assert(message.id === timeline[0]!.id, "Reaction must target the selected message"); chosenReaction = emoji;
  } });
  reactionMessage.querySelector<HTMLButtonElement>('[aria-label="Choose a reaction"]')!.click();
  const reactionPicker = document.querySelector<HTMLElement>(".reaction-emoji-picker")!;
  assert(reactionPicker && !reactionPicker.hidden, "Messages must open the full emoji reaction picker");
  const reactionSearch = reactionPicker.querySelector<HTMLInputElement>("input")!;
  reactionSearch.value = "astronaut"; reactionSearch.dispatchEvent(new Event("input"));
  clickByText(reactionPicker, "🧑🏽‍🚀");
  assert(chosenReaction === "🧑🏽‍🚀", "Full Unicode skin-tone and ZWJ emoji must be sent as reactions");
  assert(reactionPicker.hidden, "Selecting a reaction must close the picker");
  reactionMessage.remove();
  assert(!document.querySelector(".reaction-emoji-picker"), "Removing a message must clean up its floating emoji picker");
  const youtubeMessage = document.createElement("message-item"); document.body.append(youtubeMessage);
  youtubeMessage.update({ ...timeline[0]!, msgtype: "m.text", body: "Watch https://youtu.be/M7lc1UVf-VE?t=90" }, { client: null, room: null });
  const youtubeFrame = youtubeMessage.querySelector<HTMLIFrameElement>("iframe")!;
  assert(youtubeFrame?.src === "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?playsinline=1&autoplay=0&start=90" && youtubeFrame.allowFullscreen && new URL(youtubeFrame.src).searchParams.get("autoplay") === "0", "YouTube links must embed the privacy-enhanced player, preserve timestamps and avoid autoplay");
  assert(youtubeMessage.textContent?.includes("Watch") && youtubeMessage.querySelector('a[href="https://www.youtube.com/watch?v=M7lc1UVf-VE"]'), "YouTube embeds must retain message text and an external fallback");
  youtubeMessage.update({ ...timeline[0]!, msgtype: "m.text", body: "https://www.youtube.com/watch?v=ih2xubMaZWI" }, { client: null, room: null });
  const reportedFrame = youtubeMessage.querySelector<HTMLIFrameElement>("iframe")!;
  assert(reportedFrame.src === "https://www.youtube-nocookie.com/embed/ih2xubMaZWI?playsinline=1&autoplay=0", "The reported watch URL must embed with autoplay explicitly disabled");
  clickByText(youtubeMessage, "Reload YouTube player");
  assert(new URL(reportedFrame.src).searchParams.get("autoplay") === "0", "Reloading the YouTube player must preserve manual playback");
  youtubeMessage.update({ ...timeline[0]!, msgtype: "m.text", body: "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE <iframe src=evil>" }, { client: null, room: null });
  assert(!youtubeMessage.querySelector("iframe"), "Lookalike YouTube hosts and raw iframe HTML must not create embeds");
  youtubeMessage.remove();
  const gifMessage = document.createElement("message-item");
  document.body.append(gifMessage);
  gifMessage.update({ ...timeline[0]!, body: "/gif https://static.klipy.com/test.gif?original=1" }, { client: null, room: null });
  assert(gifMessage.querySelector(".remote-gif")?.getAttribute("src") === "https://static.klipy.com/test.gif?original=1", "/gif must embed the exact provider URL automatically");
  gifMessage.querySelector(".remote-gif")!.dispatchEvent(new Event("error"));
  clickByText(gifMessage, "Retry GIF");
  assert(gifMessage.querySelector(".remote-gif"), "Failed /gif embeds must support retry");
  gifMessage.update({ ...timeline[0]!, body: "https://static.klipy.com/test.gif" }, { client: null, room: null });
  assert(!gifMessage.querySelector(".remote-gif"), "Plain GIF links must remain ordinary messages");
  gifMessage.update({ ...timeline[0]!, body: "/gif https://evil.test/test.gif" }, { client: null, room: null });
  assert(!gifMessage.querySelector(".remote-gif") && gifMessage.textContent?.includes("/gif"), "Unsupported /gif URLs must render as text");
  gifMessage.remove();
  const workspaceRoom = createRoomRecord("!workspace:test"); workspaceRoom.title = "Workspace room"; workspaceRoom.name = "Workspace room";
  const threadRoot = { ...timeline[0]!, id: "$root", body: "Planning discussion", threadReplyCount: 1 };
  const threadReply = { ...timeline[1]!, id: "$reply", body: "First thread reply", threadRootId: "$root" };
  workspaceRoom.timeline = [threadRoot, threadReply];
  let sentThread = "";
  const workspaceClient = {
    userId: "@me:test", avatarSrc: async () => null, getPresence: () => null,
    getThreads: async () => ({ items: [threadRoot] }),
    getThreadRoot: async () => threadRoot,
    getThreadReplies: async () => ({ items: [threadReply] }),
    sendThreadReply: async (id: string, rootId: string, body: string) => { assert(id === workspaceRoom.id && rootId === "$root", "Thread replies must target the selected room and root"); sentThread = body; return "$sent"; },
  } as unknown as MatrixClient;
  chat.setRoom(workspaceRoom, workspaceClient, "@me:test");
  assert(chat.querySelectorAll('[role="tab"]').length === 3, "Room workspace must expose Chat, Threads, and Info tabs");
  chat.querySelector<HTMLButtonElement>('[aria-label="Reply in thread"]')!.click(); await tick();
  assert(chat.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Threads", "Reply in thread must open the Threads view");
  assert(chat.querySelector<HTMLElement>(".composer-wrap")!.hidden && getComputedStyle(chat.querySelector(".chat-scroll")!).display === "none", "Thread mode must hide the main chat composer and timeline");
  assert(chat.querySelector("room-details")!.textContent?.includes("First thread reply"), "Threads must show their root and replies");
  const threadInput = chat.querySelector<HTMLTextAreaElement>('[aria-label="Thread reply"]')!;
  threadInput.value = "New threaded answer"; threadInput.dispatchEvent(new Event("input"));
  chat.querySelector<HTMLFormElement>(".thread-composer")!.requestSubmit(); await tick();
  assert(sentThread === "New threaded answer", "Thread composer must send a real Matrix thread reply");
  clickByText(chat.querySelector("room-details")!, "All threads"); await tick();
  assert(chat.querySelector(".thread-summary")?.textContent?.includes("Planning discussion"), "Threads tab must list discoverable thread roots");
  clickByText(chat, "Info");
  assert(chat.querySelector("room-details")!.textContent?.includes(workspaceRoom.id), "Info must show the room's actual details");
  let settingsRoomId = "";
  chat.addEventListener("grungus:room-settings", event => { settingsRoomId = (event as CustomEvent<{ roomId: string }>).detail.roomId; });
  clickByText(chat.querySelector("room-details")!, "Room settings");
  assert(settingsRoomId === workspaceRoom.id, "Info must open settings for the selected room");
  clickByText(chat, "Chat");
  assert(!chat.querySelector<HTMLElement>(".composer-wrap")!.hidden && chat.querySelector<HTMLElement>("room-details")!.hidden, "Chat tab must restore the normal composer");

  const roomSettings = document.createElement("room-settings"); roomSettings.hidden = true; document.body.append(roomSettings);
  let permissionLevel = 100;
  const writtenState: { roomId: string; type: string; content: Record<string, unknown> }[] = [];
  const childRoom = createRoomRecord("!child:test"); childRoom.title = "Child room";
  const managementClient = {
    userId: "@me:test", getRoomPowerLevels: async () => ({ users: { "@me:test": permissionLevel } }),
    api: async (_method: string, path: string) => path.includes("join_rules") ? { join_rule: "invite" } : { history_visibility: "shared" },
    sendStateEvent: async (roomId: string, type: string, _key: string, content: Record<string, unknown>) => { writtenState.push({ roomId, type, content }); return "$state"; },
    getRooms: () => [childRoom], getRoom: (id: string) => id === childRoom.id ? childRoom : null,
    addToSpace: async (space: string, child: string) => { assert(space === "!space-management:test" && child === childRoom.id, "Add must target the selected space"); },
    removeFromSpace: async (space: string, child: string) => { assert(space === "!space-management:test" && child === childRoom.id, "Remove must target the selected space"); },
  } as unknown as MatrixClient;
  roomSettings.show(workspaceRoom, managementClient); await tick();
  roomSettings.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value = "Renamed room";
  roomSettings.querySelector<HTMLTextAreaElement>('[aria-label="Topic"]')!.value = "A shared topic";
  roomSettings.querySelector<HTMLInputElement>('[aria-label="Enable encryption"]')!.checked = true;
  roomSettings.querySelector("form")!.requestSubmit(); await tick();
  assert(writtenState.some(event => event.type === "m.room.name" && event.content.name === "Renamed room") && writtenState.some(event => event.type === "m.room.encryption"), "Room settings must persist name/topic/encryption through Matrix state events");
  roomSettings.hide(); roomSettings.show(workspaceRoom, managementClient); await tick();
  permissionLevel = 0;
  roomSettings.querySelector<HTMLInputElement>('[aria-label="Name"]')!.value = "Forbidden edit";
  const previousWrites = writtenState.length;
  roomSettings.querySelector("form")!.requestSubmit(); await tick();
  assert(writtenState.length === previousWrites && roomSettings.textContent?.includes("permissions no longer allow"), "Saving must recheck permissions before sending state changes");
  roomSettings.hide(); roomSettings.show(workspaceRoom, managementClient); await tick();
  assert(roomSettings.querySelector<HTMLInputElement>('[aria-label="Name"]')?.disabled, "Read-only users must not be offered editable management controls");
  roomSettings.hide(); permissionLevel = 100;
  const managedSpace = createRoomRecord("!space-management:test"); managedSpace.isSpace = true; managedSpace.title = "Managed space";
  managedSpace.children.add(childRoom.id);
  roomSettings.show(managedSpace, managementClient); await tick();
  assert(!roomSettings.querySelector('[aria-label="Add room to space"]') && ![...roomSettings.querySelectorAll("button")].some(button => button.textContent === "Add room"), "Space settings must not display the deprecated room addition picker");
  clickByText(roomSettings, "Remove from space"); await tick();
  assert(!managedSpace.children.has(childRoom.id), "Space settings must remove room links without deleting the room");
  let createdRooms = 0;
  managementClient.createRoom = async options => { createdRooms++; assert(options?.encrypted === true && options.parentSpaceId === managedSpace.id, "Creation must enable encryption and retain the selected space"); return "!created:test"; };
  managementClient.addToSpace = async (space, child) => { assert(space === managedSpace.id && child === "!created:test", "New room must link to its selected space"); };
  clickByText(roomSettings, "Create a new room"); await tick();
  const creation = document.querySelector("room-creation")!;
  assert(roomSettings.inert && creation.querySelector<HTMLInputElement>('[aria-label="Encrypt new room"]')!.checked, "Creation must be modal and encrypted by default");
  creation.querySelector<HTMLInputElement>('[aria-label="New room name"]')!.value = "New lounge";
  creation.querySelector("form")!.requestSubmit(); await tick();
  assert(createdRooms === 1 && managedSpace.children.has("!created:test") && creation.hidden && !roomSettings.inert, "Successful creation must link once and restore the settings dialog");
  let invitations = 0;
  managementClient.invite = async (id, user) => { assert(id === managedSpace.id && user === "@friend:test", "Invitations must target the space and selected Matrix user"); invitations++; };
  showSpaceInvite(managedSpace, managementClient); await tick();
  const inviteDialog = document.querySelector<HTMLElement>('[aria-label="Invite to space"][role="dialog"]')!;
  const inviteInput = inviteDialog.querySelector<HTMLInputElement>("input")!;
  inviteInput.value = "invalid"; inviteDialog.querySelector("form")!.requestSubmit(); await tick();
  assert(invitations === 0 && inviteDialog.textContent?.includes("full Matrix ID"), "Invalid Matrix IDs must not send invitations");
  inviteInput.value = "@friend:test"; inviteDialog.querySelector("form")!.requestSubmit(); await tick();
  assert(Number(invitations) === 1 && inviteDialog.textContent?.includes("Invitation sent"), "Successful invitations must report confirmation");
  permissionLevel = 0;
  managementClient.getRoomPowerLevels = async () => ({ users: { "@me:test": 0 }, invite: 50 });
  inviteInput.value = "@friend:test"; inviteDialog.querySelector("form")!.requestSubmit(); await tick();
  assert(Number(invitations) === 1 && inviteDialog.textContent?.includes("permission"), "Inviting must recheck permission before sending");
  clickByText(inviteDialog, "Close");
  roomSettings.hide(); roomSettings.remove();
  const startupRoom = createRoomRecord("!startup-history:test"); startupRoom.title = "Quiet space room"; startupRoom.historyCursor = "older";
  let automaticLoads = 0;
  const startupMessage = { kind: "message" as const, id: "$startup", sender: "@friend:test", senderName: "Friend", ts: Date.now(), msgtype: "m.text", body: "Restored on opening the room", media: null };
  const startupClient = { ...managementClient, avatarSrc: async () => null,
    ensureRoomHistory: async (id: string) => { automaticLoads++; assert(id === startupRoom.id, "Automatic history must target the opened room"); startupRoom.timeline.push(startupMessage); },
  } as unknown as MatrixClient;
  chat.setRoom(startupRoom, startupClient, "@me:test"); await tick();
  assert(automaticLoads === 1 && chat.textContent?.includes("Restored on opening the room"), "Opening an initially empty room must show fetched history without clicking Earlier messages");
  chat.setRoom(startupRoom, startupClient, "@me:test"); await tick();
  assert(automaticLoads === 1, "Normal room redraws must not repeat automatic history requests");
  const featureRoom = createRoomRecord("!features:test"); featureRoom.title = "Feature room"; featureRoom.creator = "@me:test"; featureRoom.historyCursor = "older";
  const featureMessage = { kind: "message" as const, id: "$find", sender: "@friend:test", senderName: "Friend", ts: Date.now(), msgtype: "m.text", body: "Find this message", media: null };
  featureRoom.timeline = [featureMessage];
  const featureWrites: { type: string; content: Record<string, any> }[] = [];
  let featurePins = ["$find"], loadedOlder = 0;
  const notificationData: Record<string, unknown> = {};
  const featureClient = {
    userId: "@me:test", getRoomPowerLevels: async () => ({ users: { "@me:test": 100, "@friend:test": 0 }, events: { "m.room.name": 75 } }),
    getIgnoredUsers: () => [], getAccountData: () => notificationData, getSpaces: () => [], getRooms: () => [featureRoom], getRoom: () => featureRoom,
    avatarSrc: async () => null, getThreadRoot: async () => featureMessage,
    api: async (_method: string, path: string) => path.includes("pinned_events") ? { pinned: featurePins } : path.includes("/relations/") ? { chunk: [] } : path.includes("account_data") ? notificationData : path.includes("join_rules") ? { join_rule: "invite" } : { history_visibility: "shared" },
    sendStateEvent: async (_id: string, type: string, _key: string, content: Record<string, any>) => { featureWrites.push({ type, content }); if (type === "m.room.pinned_events") featurePins = content.pinned; return "$saved"; },
    setAccountData: async (_type: string, data: Record<string, unknown>) => { Object.assign(notificationData, data); },
    sendRoomEvent: async (_id: string, type: string, content: Record<string, any>) => { featureWrites.push({ type, content }); return `$feature-${featureWrites.length}`; },
    loadOlderMessages: async () => { loadedOlder++; featureRoom.timeline.unshift({ ...featureMessage, id: "$older", body: "Find older message" }); featureRoom.historyCursor = null; },
  } as unknown as MatrixClient;
  Object.assign(featureClient, { features: new RoomFeatures(featureClient) });
  const featureTools = document.createElement("room-tools"); document.body.append(featureTools);
  featureTools.show(featureRoom, featureClient, "search");
  featureTools.querySelector<HTMLInputElement>('[aria-label="Search message text"]')!.value = "find";
  featureTools.querySelector("form")!.requestSubmit();
  assert(featureTools.querySelectorAll(".tools-results message-item").length === 1, "Search must render matching message contents");
  clickByText(featureTools, "Load and search older messages"); await tick();
  assert(loadedOlder === 1 && featureTools.querySelectorAll(".tools-results message-item").length === 2, "Searching older history must fetch and search additional decrypted messages");
  featureTools.show(featureRoom, featureClient, "pins"); await tick();
  assert(featureTools.querySelector(".pinned-message")?.textContent?.includes("Find this message"), "Pins must load their original message contents");
  clickByText(featureTools, "Unpin"); await tick();
  assert(featurePins.length === 0, "Unpin must update Matrix pinned-event state");
  featureTools.show(featureRoom, featureClient, "polls");
  featureTools.querySelector<HTMLInputElement>('[aria-label="Poll question"]')!.value = "Tonight?";
  featureTools.querySelector<HTMLTextAreaElement>('[aria-label="Poll answers"]')!.value = "Game\nFilm";
  featureTools.querySelector("form")!.requestSubmit(); await tick();
  const pollStart = featureWrites.find(write => write.type === "org.matrix.msc3381.poll.start")!;
  assert(pollStart?.content["org.matrix.msc3381.poll.start"].answers.length === 2, "Poll creation must send Matrix poll choices");
  const pollRoot = { ...featureMessage, id: "$poll", sender: "@me:test", body: "Tonight?", pollEvent: { type: pollStart.type, content: pollStart.content } };
  featureTools.show(featureRoom, featureClient, "polls", pollRoot); await tick();
  featureTools.querySelector<HTMLInputElement>('input[name="vote"]')!.checked = true;
  featureTools.querySelector("form")!.requestSubmit(); await tick();
  assert(featureWrites.some(write => write.type === "org.matrix.msc3381.poll.response"), "Poll voting must send a Matrix response relation");
  clickByText(featureTools, "End voting"); clickByText(featureTools, "Confirm end voting"); await tick();
  assert(featureWrites.some(write => write.type === "org.matrix.msc3381.poll.end"), "Poll creator must be able to confirm and end voting");
  featureTools.hide(); featureTools.remove();
  const inlineMessage = document.createElement("message-item");
  Object.assign(inlineMessage.style, { position: "fixed", top: "10px", left: "10px", width: "500px" }); document.body.append(inlineMessage);
  const inlineRoot = { ...pollRoot, id: "$inline-poll" };
  inlineMessage.update(inlineRoot, { client: featureClient, room: featureRoom, meUserId: featureClient.userId });
  await new Promise(resolve => setTimeout(resolve, 70));
  const inline = inlineMessage.querySelector("message-poll")!;
  assert(inline.querySelector(".inline-poll-question")?.textContent === "Tonight?" && inline.querySelectorAll('input[name="inline-vote"]').length === 2, "Poll messages must show answer choices inline without a dialog");
  assert(!inlineMessage.querySelector("room-tools") && !inlineMessage.textContent?.includes("Open poll"), "Inline polls must not require opening a separate poll window");
  const firstReadyDeadline = Date.now() + 2500;
  while (inline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!.disabled && Date.now() < firstReadyDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  const firstChoice = inline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!;
  assert(!firstChoice.disabled, "Inline poll choices must become available after results load");
  const responsesBefore = featureWrites.filter(write => write.type === "org.matrix.msc3381.poll.response").length;
  firstChoice.checked = true; firstChoice.dispatchEvent(new Event("change", { bubbles: true })); await tick();
  assert(featureWrites.filter(write => write.type === "org.matrix.msc3381.poll.response").length === responsesBefore + 1, "Selecting a poll answer must submit it immediately without a separate button");
  assert(!inline.querySelector('[aria-label="Submit poll vote"]'), "Inline polls must not display a separate vote button");
  inlineMessage.update(inlineRoot, { client: featureClient, room: featureRoom, meUserId: featureClient.userId });
  await new Promise(resolve => setTimeout(resolve, 70));
  const rebuiltInline = inlineMessage.querySelector("message-poll")!;
  const inlineReadyDeadline = Date.now() + 2500;
  while (rebuiltInline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!.disabled && Date.now() < inlineReadyDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert(!rebuiltInline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!.disabled, "Rebuilt inline poll must load its vote state when visible");
  assert(rebuiltInline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!.checked, "Selected poll choices must survive timeline redraws");
  assert(rebuiltInline.querySelector<HTMLProgressElement>('progress[aria-label="Game: 100% of voters"]')?.value === 100 && rebuiltInline.textContent?.includes("1 vote · 100%"), "A server-confirmed local vote must immediately show its share even when the relation index is still empty");
  const remoteResponse = { ...inlineRoot, id: "$remote-response", sender: "@other:test", ts: Date.now() + 1, msgtype: "org.matrix.msc3381.poll.response", pollEvent: { type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": { rel_type: "m.reference", event_id: inlineRoot.id }, "org.matrix.msc3381.poll.response": { answers: ["answer-1"] } } } };
  featureClient.features.recordPollEvent(featureRoom.id, remoteResponse); await tick();
  assert(rebuiltInline.querySelectorAll("progress").length === 2 && [...rebuiltInline.querySelectorAll<HTMLProgressElement>("progress")].every(bar => bar.value === 50), "A remote vote arriving through sync must update both inline shares without waiting for the next polling interval");
  const endInline = rebuiltInline.querySelector<HTMLButtonElement>('[aria-label="End poll voting"]')!;
  endInline.click(); rebuiltInline.querySelector<HTMLButtonElement>('[aria-label="End poll voting"]')!.click(); await tick();
  assert(featureWrites.filter(write => write.type === "org.matrix.msc3381.poll.end").length === 2, "The poll creator must be able to end voting directly in chat");
  assert(rebuiltInline.textContent?.includes("Voting ended") && rebuiltInline.querySelector<HTMLInputElement>('input[name="inline-vote"]')?.disabled, "Confirmed poll closure must update inline controls while server indexing catches up");
  const multiRoot = { ...inlineRoot, id: "$inline-multiple", pollEvent: { type: pollStart.type, content: { ...pollStart.content, "org.matrix.msc3381.poll.start": { ...pollStart.content["org.matrix.msc3381.poll.start"], max_selections: 2 } } } };
  inlineMessage.update(multiRoot, { client: featureClient, room: featureRoom, meUserId: featureClient.userId });
  const multiInline = inlineMessage.querySelector("message-poll")!;
  const multiDeadline = Date.now() + 2500;
  while (multiInline.querySelector<HTMLInputElement>('input[name="inline-vote"]')!.disabled && Date.now() < multiDeadline) await new Promise(resolve => setTimeout(resolve, 30));
  const lastVoteAnswers = () => featureWrites.filter(write => write.type === "org.matrix.msc3381.poll.response").at(-1)!.content["org.matrix.msc3381.poll.response"].answers as string[];
  multiInline.querySelector<HTMLInputElement>('input[value="answer-0"]')!.click(); await tick();
  multiInline.querySelector<HTMLInputElement>('input[value="answer-1"]')!.click(); await tick();
  assert(lastVoteAnswers().length === 2, "Each checkbox change must cast the entire updated multiple-choice ballot");
  multiInline.querySelector<HTMLInputElement>('input[value="answer-0"]')!.click(); await tick();
  assert(lastVoteAnswers().join() === "answer-1", "Unchecking an answer must update the cast ballot immediately");
  clickByText(multiInline, "Clear selection"); await tick();
  assert(lastVoteAnswers().length === 0 && [...multiInline.querySelectorAll<HTMLProgressElement>("progress")].every(bar => bar.value === 0), "Clearing a selection must withdraw the vote and refresh vote shares");
  inlineMessage.remove();
  const featureSettings = document.createElement("room-settings"); document.body.append(featureSettings); featureSettings.show(featureRoom, featureClient); await tick();
  featureSettings.querySelector<HTMLSelectElement>('[aria-label="Room notification mode"]')!.value = "mentions";
  clickByText(featureSettings, "Save notifications"); await tick();
  assert(notificationData[featureRoom.id] === "mentions", "Room notifications must persist independently of global settings");
  featureSettings.querySelector<HTMLInputElement>('[aria-label="Manage member ID"]')!.value = "@friend:test";
  featureSettings.querySelector<HTMLSelectElement>('[aria-label="Member role"]')!.value = "50";
  clickByText(featureSettings, "Assign role"); await tick();
  assert(featureWrites.some(write => write.type === "m.room.power_levels" && write.content.users["@friend:test"] === 50 && write.content.events["m.room.name"] === 75), "Role editing must preserve unrelated permission rules");
  featureSettings.hide(); featureSettings.remove();
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
  assert(shell.querySelector(".chat-column recent-dms") && shell.querySelector(".chat-column chat-view"), "Recent DMs must sit above the chat within the main conversation column");
  const recentBox = shell.querySelector("recent-dms")!;
  assert(parseFloat(getComputedStyle(recentBox).marginBottom) >= 12, "Recent DMs must have a visible gap above the chat");
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
  document.body.classList.toggle("theme-light", scene === "light" || scene === "background-light");
  applyBackground("");
  if (scene.startsWith("background")) {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1000;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 1400, 1000);
    gradient.addColorStop(0, "#ee8b66"); gradient.addColorStop(.4, "#647bb1"); gradient.addColorStop(1, "#1e605d");
    context.fillStyle = gradient; context.fillRect(0, 0, 1600, 1000);
    context.fillStyle = "#183e4e"; context.beginPath(); context.moveTo(0, 1000); context.lineTo(0, 700); context.lineTo(450, 320); context.lineTo(1000, 1000); context.fill();
    context.fillStyle = "#42695f"; context.beginPath(); context.moveTo(500, 1000); context.lineTo(1100, 450); context.lineTo(1600, 900); context.lineTo(1600, 1000); context.fill();
    applyBackground(canvas.toDataURL("image/jpeg"));
  }
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
  const client = { getRoomPowerLevels: async () => ({ users: { [me]: 100 } }), api: async (_method: string, path: string) => path.includes("join_rules") ? { join_rule: "invite" } : { history_visibility: "shared" },
    getRooms: () => rooms, getRoom: (id: string) => rooms.find(room => room.id === id) ?? null,
    getThreads: async () => ({ items: [{ ...rooms[0]!.timeline[0]!, threadReplyCount: 2 }] }),
    avatarSrc: async () => null, mediaSrc: async () => null, getDevices: async () => [], getProfile: async () => ({ displayname: "Alex Morgan" }), getIgnoredUsers: () => [], getAccountData: () => null, userId: me } as unknown as MatrixClient;
  const spaces = ["Studio", "Friends", "Open source"].map((title, index) => ({ ...rooms[0]!, id: `!space${index}:matrix.org`, title, isSpace: true }));
  shell.querySelector("space-rail")!.update(spaces, null, client);
  const sidebar = shell.querySelector("room-list")!;
  sidebar.update(rooms, spaces, rooms[0]!.id, null, client);
  shell.querySelector("recent-dms")!.update(rooms, rooms[0]!.id, client);
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
  if (scene === "info" || scene === "threads") clickByText(shell.querySelector("chat-view")!, scene === "info" ? "Info" : "Threads");
  if (scene === "room-settings" || scene === "space-settings") {
    const manager = document.createElement("room-settings"); manager.hidden = true; document.body.append(manager);
    const target = scene === "space-settings" ? { ...spaces[0]!, children: new Set([rooms[0]!.id]) } : rooms[0]!;
    manager.show(target, client);
  }
  if (scene === "mobile") shell.classList.add("show-rooms");
}
(window as unknown as { showPreview: typeof showPreview }).showPreview = showPreview;
