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
  await tick();
  assert(requestedAvatars.includes("mxc://test/peer") && !requestedAvatars.includes("mxc://test/room"), "DM sidebar must use the other person's avatar instead of the room image");
  assert(requestedAvatars.includes("mxc://test/group"), "Group rooms must keep their room image");
  assert(sidebar.querySelector('.room-row[data-room-id="!dm:test"] g-avatar img'), "DM avatar must render the authenticated image");
  assert(sidebar.querySelector('.room-row[data-room-id="!dm:test"] .avatar-presence.online'), "DM avatar must show a green online dot");
  const memberPane = document.createElement("member-list");
  document.body.append(memberPane);
  memberPane.update(dm, avatarClient, "@me:test");
  assert(memberPane.querySelector(".avatar-presence.online"), "Member avatars must show online dots");
  peerPresence = "offline";
  memberPane.update(dm, avatarClient, "@me:test");
  assert(!memberPane.querySelector(".avatar-presence.online") && memberPane.querySelector('[aria-label="Offline"]'), "Presence changes must refresh the member list without membership changes");
  sidebar.update([dm, group], [], dm.id, null, avatarClient);
  assert(sidebar.querySelector('.room-row[data-room-id="!dm:test"] [aria-label="Offline"]'), "DM sidebar must refresh offline status");
  assert(!sidebar.querySelector('.room-row[data-room-id="!group:test"] .avatar-presence'), "Group room images must not show a person's status");
  peerPresence = null;
  memberPane.update(dm, avatarClient, "@me:test");
  assert(memberPane.querySelector('[aria-label="Presence unavailable"]'), "Unknown presence must not falsely claim offline");
  memberPane.remove();
  dm.members.get("@peer:test")!.avatarMxc = null;
  sidebar.update([dm], [], dm.id, null, avatarClient);
  await tick();
  sidebar.update([dm], [], dm.id, null, avatarClient);
  await tick();
  assert(profileCalls === 1 && requestedAvatars.includes("mxc://test/global-peer"), "Missing room-member avatar must fall back to a cached profile lookup");
  dm.members.set("@third:test", { userId: "@third:test", displayname: "Third", avatarMxc: null, membership: "join" });
  resolveRoomMeta(dm, "@me:test", { "@peer:test": [dm.id] });
  assert(!dm.isDirect && dm.directUserId === null, "A group room must not retain a stale DM peer");
  const videoSpace = createRoomRecord("!video-space:test"); videoSpace.isSpace = true; videoSpace.title = "Our space";
  const videoRoom = createRoomRecord("!video:test"); videoRoom.roomType = "org.matrix.msc3417.call"; videoRoom.title = "Video lounge";
  videoSpace.children.add(group.id); videoSpace.children.add(videoRoom.id);
  sidebar.update([group, videoRoom], [videoSpace], group.id, videoSpace.id, avatarClient);
  assert([...sidebar.querySelectorAll(".sidebar-section")].some(node => node.textContent === "Text rooms"), "Spaces must label text room sections");
  assert([...sidebar.querySelectorAll(".sidebar-section")].some(node => node.textContent === "Video rooms"), "Spaces must label video room sections");
  assert(sidebar.querySelector('.room-row[data-room-id="!video:test"] [aria-label="Video room"]'), "Video rooms must have a distinct camera icon");
  sidebar.remove();

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
  let deleteCalls = 0;
  let releaseDelete: (() => void) | undefined;
  const settingsClient = {
    deviceId: "SELF", userId: "@me:test", accessToken: "token",
    getDevices: async () => [...devices], getIgnoredUsers: () => [], getProfile: async () => ({}),
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
  sessionSettings.hide(); sessionSettings.remove();

  const callScreen = document.createElement("call-view");
  document.body.append(callScreen);
  let pickedMic = "";
  let pickedSpeaker = "";
  let failDevice = false;
  let savedDevice = "";
  const callController = {
    localCameraEnabled: false,
    setCameraEnabled: async (enabled: boolean) => { callController.localCameraEnabled = enabled; },
    localStream: null, setMuted: () => {}, hangUp: () => {}, startScreenshare: () => {}, stopScreenshare: () => {},
    switchAudioInput: async (id: string) => { if (failDevice) throw new Error("Microphone disconnected"); pickedMic = id; },
    switchAudioOutput: async (id: string) => { pickedSpeaker = id; },
  };
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
  callScreen.querySelector<HTMLButtonElement>('[aria-label="Feature Video Friend video"]')!.click();
  assert(callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraOne, "Participants must be able to choose a different camera for the stage");
  callScreen.update({ ...callState, participants: [{ ...participant, sharing: true, screenStream: cameraTwo }, secondParticipant] }, callController);
  assert(callScreen.querySelector('[aria-label="Shared screen"]') && callScreen.querySelector<HTMLVideoElement>('.call-stage video')?.srcObject === cameraTwo, "Screen sharing must take priority over camera feeds");
  callScreen.update({ ...callState, participants: [participant] }, callController);
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
