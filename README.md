# Grungus

A Discord-style desktop chat client for the [Matrix](https://matrix.org)
network — the same open, federated protocol that
[Element](https://element.io) runs on. Point it at any homeserver
(matrix.org, a self-hosted Synapse, conduwuit, dendrite, …) and chat in a
familiar, Discord-like UI.

Not affiliated with Discord or Element. Grungus is an independent client
for an open protocol.

![Grungus workspace preview with sample conversations](docs/screenshot.png)

## Features

- **Matrix login** — two-step: enter the homeserver domain first, then the
  app queries the server's real login flows (GET /login) and offers
  exactly what that server supports: password, access token, and SSO.
- **Account creation** — "Need an account? Create one" on the login card
  registers a fresh user over POST /register with the spec's
  User-Interactive Auth: m.login.dummy (open registration) and
  m.login.registration_token (shared-token homeservers, e.g. conduwuit —
  the token field appears only when the server demands it). The new
  session lands straight in the app; servers requiring recaptcha/terms
  are declined with a pointer to their website or Element, and
  M_USER_IN_USE / M_INVALID_USERNAME render as friendly messages.
- **SSO / redirect login (m.login.sso)** — for homeservers that federate
  an IdP (e.g. a university Keycloak), each advertised identity provider
  becomes a "Continue with …" button. The redirect dance runs in the
  HOST SYSTEM BROWSER (passkeys/WebAuthn prompts are OS-native there,
  and IdPs increasingly block embedded webviews): a temporary loopback
  HTTP listener on 127.0.0.1 captures the loginToken callback
  (RFC 8252 style) and completes the login via m.login.token. An
  embedded auth window with redirect interception is the fallback; in
  the browser dev build the whole tab redirects and boot() completes
  the exchange, stripping the single-use token from the URL.
- **End-to-end encryption (Olm/Megolm)** — messages in encrypted rooms
  are megolm-encrypted via libolm (WASM); room keys are shared over olm
  to-device messages to every member device, including your own.
  Encrypted rooms show a 🔒 badge; sends fail closed rather than leaking
  plaintext (including sends that race the first room sync);
  undecryptable events show an explicit notice while the key is
  requested from other devices.
- **Room key forwarding (m.room_key_request / m.forwarded_room_key)** —
  a fresh device asks your other devices (and SAS-verified members)
  for the megolm sessions behind "unable to decrypt" history; the
  exported session is imported at its chain index and the affected
  messages decrypt in place, live. Unverified strangers are declined.
- **Key rotation on membership change** — when someone joins or leaves
  an encrypted room, senders start a fresh megolm session: joiners can
  read from their join onward (not before, unless verified — see
  forwarding), and leavers cannot read the room's future.
- **Invites** — rooms you are invited to (rooms.invite in /sync) appear
  in an "Invites" section with accept/decline buttons; accepting joins
  and immediately enables chat.
- **Server-side key backup (m.megolm_backup.v1.curve25519-aes-sha2)** —
  back up your megolm sessions to the homeserver, secured by a
  passphrase-derived curve25519 key (PBKDF2-HMAC-SHA-512, 500k
  iterations; the server only ever sees the public key — wire formats
  cross-checked against matrix-js-sdk). New sessions are backed up as
  they arrive. A fresh device (e.g. after an SSO login on a new machine)
  restores with the passphrase and decrypts history in place — even with
  no other device of yours online. The 🔑 button in the sidebar opens
  the create/restore overlay.
- **Native group calls (MSC3401, full-mesh WebRTC)** — start or join a
  call from the chat header; m.call.member state announces membership,
  SDP offers/answers and ICE candidates flow over olm-encrypted
  (encrypted rooms) or plaintext to-device messages, media rides
  WebRTC DTLS-SRTP with one peer connection per member device. Mute,
  hang up, per-peer connection state. Microphone capture uses real devices only; permission or device failures are reported.
- **Screen sharing** — "Share screen" in the call overlay captures the
  display (getDisplayMedia; in Electron a picker lists screens and windows, with system audio
  off until explicitly selected on supported platforms) and adds it to every peer connection with mid-call
  renegotiation from either role (perfect negotiation with polite-side
  rollback). The active screen renders as a large presentation tile.
  Mesh bandwidth discipline: content-hinted screen encoding (~1.5 Mbps
  cap, 10 fps — screens tolerate low fps, text stays sharp), one share
  at a time. m.call.screenshare start/stop rides the same encrypted
  signaling (a Grungus extension, Element interop untested). Hosts without display capture cannot share a screen.
- **Calls through a LiveKit SFU (optional)** — rooms with a
  `com.grungus.livekit` state event ({url, room, auth_url}) route calls
  through a LiveKit server instead of the mesh: the bandwidth ceiling
  is gone (the SFU does simulcast — publish once, the server fans out
  appropriate layers to each receiver). Identity flow (Element
  lk-jwt-service pattern): the client proves its Matrix identity to a
  token service (OpenID token, with whoami fallback for homeservers
  with federation disabled) and receives a short-lived LiveKit access
  token; the API secret never touches the client. Media uses real devices only and the camera starts off. Rooms without a LiveKit state
  event use the mesh unchanged. `livekit/auth-service.ts` is the
  deployable token service (single-file Node, jsonwebtoken).
- **1:1 calls with Element interop (MSC2746)** — direct-message calls
  speak the legacy room-event protocol every Element client answers in
  DMs: m.call.invite / answer / select_answer / candidates / hangup as
  ordinary room events, megolm-encrypted in encrypted rooms exactly
  like Element's own call events. Calling a DM from Grungus rings
  Element; an Element DM call rings Grungus's banner and Join answers
  it. Full MSC2746 semantics: party_id is the device id, the caller
  picks the first answerer (select_answer releases the losing
  devices), invites carry a 60s lifetime (stale ones never ring), and
  the caller's hangup cancels the ring. The chat header's 🎥 starts a
  VIDEO call — the callee answers with their camera only when the
  offer carries a video m-line — and screenshare rides the established
  video sender via replaceTrack (Element-style: no renegotiation
  event needed; the m.call.screenshare room event is a Grungus hint so
  the peer stages the share — Element ignores it and simply sees the
  video change). Audio-only 1:1 calls have no video m-line to ride, so
  sharing there explains it needs a video call. Media is plain
  DTLS-SRTP — the insertable-streams E2EE layer is mesh-only (Element
  cannot decrypt Grungus's v1 frame format). Group rooms keep the
  MSC3401 mesh; LiveKit-focused calls (Element Call) still join
  through the SFU, now probing the token endpoints Element's
  lk-jwt-service serves (/session/get_token, /sfu/get, /get_token)
  before the bare focus URL.
- **Discord-style layout** — space rail (servers), room/channel list,
  chat with grouped messages and day dividers, member list, composer.
- **Spaces as servers** — Matrix Spaces appear in the left rail like
  Discord servers; their child rooms become the "channels".
- **Direct messages** — unnamed 1:1 rooms resolve as DMs, named after
  the other member.
- **Real-time sync** — `/sync` long-polling with exponential backoff and
  a connection indicator; messages arrive live.
- **Local echo** — sent messages render instantly, then reconcile with
  the server event (no duplicates, "failed to send" marking on errors).
- **Images and GIFs** — `m.image` / `m.sticker` messages render inline
  via authenticated media downloads; GIFs animate natively. The composer
  📎 button uploads and sends images (`m.image`).
- **Typing notifications** — the composer emits `m.typing` while you
  type (server-rate-limited); other members' typing state shows above
  the composer.
- **Message reactions** — hover any message for the quick-reaction
  toolbar (👍 ❤️ 😂); reactions ride the spec's m.reaction /
  m.annotation events, aggregate as emoji chips with live counts, and
  highlight your own.
- **Replies** — the ↩ action quotes the parent (m.in_reply_to) above
  the composer; sent replies render with the quoted sender + snippet
  and the spec's fallback quote is stripped from the body
  reply-aware clients.
- **Message editing** — the ✏️ action on your own messages sends
  m.replace with m.new_content; the timeline updates the original in
  place with an "(edited)" marker instead of appending a new entry.
  Redactions remove their targets from the timeline (m.room.redaction,
  power-levels enforced server-side).
- **SSSS secret storage + secret sharing** — private keys now travel.
  Bootstrap takes an optional recovery passphrase: it derives a
  m.secret_storage.v1.aes-hmac-sha2 key (PBKDF2-HMAC-SHA-512 500k
  iterations, HKDF-SHA256 AES-CTR/HMAC-SHA256 split — js-sdk's exact
  formats) and stores the three cross-signing seeds as ENCRYPTED
  secrets at the spec's m.cross_signing.* account data; any device can
  recover them with the passphrase alone. Verification also propagates
  the keys LIVE: after an own-device verification, a device without
  signing keys requests them from the just-verified device
  (m.secret.request / m.secret.send over olm, only to verified own
  devices) and becomes a full signer — Element's
  requestKeysDuringVerification flow.
- **Space management** — 🗂 in the sidebar creates a space
  (creation_content.type m.space); selecting one shows its rooms with
  per-room remove buttons and an add-room picker (m.space.child state,
  via the user's homeserver as the routing hint). Rooms can be moved
  in and out live; every member's tree updates via sync.
- **LiveKit-path E2EE media (element-call interop)** — in encrypted
  rooms the SFU call's frames are end-to-end encrypted through
  livekit-client's own E2EE worker (the same one Element Call runs),
  with a per-participant 16-byte key distributed over Matrix in BOTH
  generations of Element's protocol: megolm-wrapped
  io.element.call.encryption_keys room events (js-sdk v33-era clients)
  and olm-encrypted to-device io.element.call.encryption_keys with the
  current js-sdk's exact content shape (media_key + the deprecated
  keys/member fields). Receiving handles all three transports (room
  events, olm to-device, and the rust SDKs' plaintext
  org.matrix.msc4143.rtc.encryption_key). Keys rotate (growing index)
  on member leave, resend on join and every 60s. The call membership is
  published in current MatrixRTC shape: the UNSTABLE
  org.matrix.msc3401.call.member type with `_user_device_m.call` state
  keys, focus_active carrying BOTH the flattened {type, livekit_service_url}
  form (element-call's parser requires it) and the legacy active_focus,
  plus foci_preferred transports. The token service also serves
  element-call's legacy /sfu/get and /get_token endpoints.
  Interop verified live against a locally built element-call: it
  authenticates through the token service, joins the same encrypted
  call, sees the Grungus participant, and renders their tile with E2EE
  active. NOTE for homeserver admins: MatrixRTC state types
  (m.call.member / org.matrix.msc3401.call.member /
  org.matrix.msc4143.rtc.member) must be sendable at power level 0 —
  default room power levels gate them at 50 and element clients die
  with MISSING_MATRIX_RTC_TRANSPORT-style auth failures.
- **Delete chats** — every room row has a hover-revealed 🗑 button
  (two-click confirm: it turns into "sure?" for 3s) that leaves the
  room on the server and drops it from the sidebar immediately. A
  left-room ignore set keeps later syncs (which carry the leave event)
  from resurrecting the chat, rooms.leave sections from other devices
  delete locally too, and the open chat view clears when its room goes.
- **Settings menu (⚙ next to your name)** — the sidebar's user pill has a
  cogwheel (Discord-style placement) that opens a full settings overlay
  with Element's standard sections, all wired to real Matrix APIs:
  - *My Account* — change display name (PUT /profile), upload an avatar
    (PUT /profile avatar_url from an mxc via the media upload), change
    the account password through the UIA m.login.password flow
    (optionally logging out every other session), and log out.
  - *Sessions* — every device on the account (GET /devices) with name,
    id, and last-seen; rename the current device (PUT /devices/{id}),
    log out any other device (POST /delete_devices, UIA password).
  - *Appearance* — dark/light theme (whole palette flips through CSS
    variables), font-size slider (0.8–1.4x applied live), compact
    message density.
  - *Preferences* — send typing notifications, send read receipts
    (m.read + m.fully_read — turning it off stops BOTH wire calls:
    room selection and the debounced timeline marker), Enter-to-send
    (off = Ctrl/Cmd+Enter sends), message timestamps, markdown,
    auto-scroll.
  - *Notifications* — desktop notifications for messages in unfocused
    rooms (clicking one jumps to the room) and a notification sound.
  - *Voice & Video* — microphone / speaker / camera pickers
    (enumerateDevices), persisted per device id ("" = system default),
    and WIRED INTO THE CALLS: the microphone and camera picks constrain
    capture on every path (mesh, 1:1, LiveKit — `ideal`, so an
    unplugged device falls back to the system default instead of
    failing the call), and the speaker pick routes every call tile's
    audio (setSinkId on the mesh/1:1 paths, switchActiveDevice on the
    SFU path) — changing it mid-call switches the live call too.
  - *Ignored Users* — the m.ignored_user_list account data, with
    unignore.
  - *Advanced* — masked access token with reveal, device id,
    homeserver, and clear-local-cache-and-reload (crypto stores only;
    the session stays logged in).
  - *Help & About* — version, crypto stack summary.
  Settings persist in localStorage (`grungus-settings`), subscribe
  everywhere, and load-merge with defaults + font-scale clamping.
- **Fullscreen fixes: screenshare stage + maximized window** — shared
  screens now use the full call view: the presentation tile flexes to
  fill ALL space the header/footer/participants leave (previously it
  was capped at 1100px wide with a fixed 16:9 box while the video grid
  below took flex:1 — so a shared screen rendered on roughly half the
  call view). While a screen is on stage the participant tiles shrink
  to a strip (Discord-style stage layout). Measured at 1920x1080: the
  stage tile is now 1888x782 (71% of the overlay, full width), grid
  strips to 154px. The Electron window now opens maximized instead of
  a 1280x800 box, and F11 toggles true fullscreen.
- **Element↔Grungus E2EE message interop** — Element clients could not
  decrypt Grungus-sent room messages (UTD on the Element side only).
  Root cause: the megolm room-key share (`m.room_key` over olm) encrypted
  a bare `{type, content}` payload — the olm v1 PDU per the spec must
  carry sender/sender_device/keys/recipient/recipient_keys, and rust
  (element's crypto) strictly requires them to authenticate the sender;
  without them the decrypted room key is dropped silently and every
  message sent afterwards stays undecryptable on Element. The share now
  builds the full PDU per device (recipient fields are per-device), and
  the megolm session_key is still captured at the current ratchet index.
  Live-verified against a headless real-Element rust stack: a fresh
  Element device joins an encrypted room, Grungus sends, rust logs
  "Received a new megolm room key" and the message decrypts — while
  pre-share history correctly stays UTD (normal Matrix semantics).
- **Element-compatible device verification (SAS)** — verifying a device
  against the Element client now works end-to-end. The SAS stack was
  rewritten to matrix-rust-sdk/vodozemac's current algorithms: the
  curve25519-hkdf-sha256 key agreement (the only one modern Element
  offers; legacy plain curve25519 kept as a fallback), the
  pipe-separated SAS info string with both sides' pubkeys
  (MSC3783-style), the hkdf-hmac-sha256.v2 MAC (HMAC-SHA256 keyed by
  HKDF of the SAS secret — vodozemac's calculate_mac, derived via
  libolm's generate_bytes), the libolm-compat v1 MAC as a fallback,
  and the SHA-256 commitment (computed in the accept, verified against
  the accepter's pubkey by the initiator). The olm PDU now carries
  the spec's sender/recipient/keys fields — rust rejects payloads
  without them. Element sends verification request/ready/done/cancel
  as PLAINTEXT to-device events (only the key/MAC exchange rides
  olm); the sync layer now routes those to the verification layer.
  The flow follows the spec: the responder answers with ready, the
  REQUESTER sends start; the done event goes out only when the
  transaction truly completes (both MACs) — sending it early completes
  the peer's request before our MAC arrives and the flow dies
  unverified (a real bug found against rust). The verify card's
  Verify button dispatches the accept once; Compare emoji is UI-only.
  Verified live against a headless real-Element stack
  (matrix-js-sdk 33 + matrix-sdk-crypto-nodejs): Element requests →
  Grungus accepts → identical emoji on both sides → both MACs →
  rust marks the Grungus device locally VERIFIED
  ({"verified":true,"local":true}), Grungus marks Element's.
- **Element recovery restore** — the 🔑 Key backup card now accepts the
  recovery passphrase OR the base58 security key (olm format: 0x8B01
  prefix, XOR parity, groups of four) from accounts set up in Element.
  Modern Element keeps the backup's private key in secret storage, so
  the restore unlocks SSSS with the passphrase (verified against the
  published key check), decrypts the m.megolm_backup.v1 secret, and
  restores with that key; Grungus's own passphrase-derived backups
  still work as the fallback path. Live-verified against the homeserver
  with an Element-style setup: a fresh Grungus device restored the
  history with just the passphrase and the UTD lines turned into
  messages. (v0.21.1: entries written by Element's rust crypto —
  which do NOT repeat room_id/session_id inside the encrypted
  payload, keeping them only in the backup path — were silently
  skipped by the restore, so every rust-backed-up session imported
  0 and Element→Grungus messages stayed UTD even after a successful
  restore. The restore now takes the room/session ids from the
  backup path like js-sdk does and only cross-checks the payload
  fields when the writer included them. Reproduced live with a
  rust-bootstrapped account: the same recovery key went from
  "Restored 0 sessions" to "Restored 1 session" and both UTD lines
  decrypted in place.)
- **Device identity reset guard (v0.21.2)** — a wiped crypto store under
  a logged-in session used to leave the device SPLIT-BRAINED: the server
  kept the old olm identity + one-time keys for the device id while the
  client generated a fresh one, so every self-share failed with
  OLM.BAD_MESSAGE_KEY_ID and the SENDER'S OWN messages showed as
  "unable to decrypt" (and olm-based call signaling died). E2EE init now
  detects a fresh identity under a device id that already published
  keys (keys/query) and refuses to continue — the app logs the user out
  so the next login mints a fresh device. The settings "Reset device
  data" button now ALWAYS drops the session too (an identity and its
  session are one unit). Reproduced live: the split-brained session was
  detected and logged out; the fresh login sent a message that rendered
  for the sender AND decrypted on the rust/Element side.
- **Read markers + receipts** — opening a room (or new messages
  arriving while it's open, debounced 1.5s) sends a public m.read
  receipt (POST /rooms/{id}/receipt/m.read/{eventId}) and the
  m.fully_read room account-data marker — other clients and
  notification counts see exactly where you've read up to. Others'
  receipts arrive via ephemeral m.receipt and drive the Discord-style
  "👁 Seen" indicator under your latest DM message (receiptCoversEvent
  compares by timeline position, so it clears when you send a new
  message and returns when they read it). DM detection now also
  honors the spec's m.direct account data (named DMs included), not
  just the nameless-two-member heuristic — and an m.direct map change
  re-resolves every room's metadata live.
- **E2EE media (insertable streams)** — in ENCRYPTED rooms the call's
  media frames are end-to-end encrypted: a TransformStream between
  the codec and the packetizer (Chromium's
  RTCRtpSender.createEncodedStreams) encrypts every encoded frame
  with AES-GCM (an SFrame-inspired header: key id + per-stream salt +
  monotonic counter + a 2-byte clear codec prefix; the counter/salt
  keep GCM nonces unique). The receiver decrypts before the decoder.
  Each sender has its own 128-bit key, transported to call peers over
  the olm-encrypted to-device channel (m.call.media_key) — the
  homeserver never sees a key. Fail-closed: frames with an unknown
  key id or a bad GCM tag are dropped, never emitted as plaintext.
  On a peer leaving, the sender rotates (new key, key id + 1) so the
  departed member's stale key decrypts nothing. Unencrypted rooms
  keep plain DTLS-SRTP (the key transport requires olm). The LiveKit
  path is not covered (mesh only). Not SFrame-byte-compatible with
  Element Call — a Grungus v1 frame format, documented.
- **Incoming-call ring** — when a call starts in one of your rooms
  (someone publishes call state), a banner with a two-tone WebAudio
  ring offers Join/Dismiss (45s missed-call timeout). Rings only fire
  on an OBSERVED false→true transition — a call that was already
  ongoing when you logged in is a missed call, not an incoming one.
  Call state carries expires_ts with a 2-minute heartbeat, so a
  crashed client's state self-heals after 5 minutes instead of
  lingering forever. When everyone else leaves a DM call, your side
  auto-leaves after a short grace instead of hanging in an empty call.
- **Element Call interop (MatrixRTC)** — Grungus speaks the MatrixRTC
  signaling Element Call uses: m.call.member state is parsed in BOTH
  current formats (the MSC4143 per-device session events Element Call
  publishes today, and the legacy per-user m.calls format), with
  expiry filtering and LiveKit focus extraction. Joining a call
  prefers the room's com.grungus.livekit state, then falls back to an
  active MatrixRTC membership's focus (the lk-jwt-service pattern —
  join the call another MatrixRTC client started, with the MATRIX ROOM
  ID as the LiveKit room so every client lands in the same SFU room).
  On join, Grungus publishes its own m.call.member membership (per-
  device state keys on servers that authorize them — Synapse — and
  the legacy per-user format merged with other devices' entries where
  they are not, e.g. this conduwuit build) so Element Call sees us.
  Signaling formats verified against the js-sdk/ruma sources and live
  against conduwuit; media interop requires both sides on the same
  LiveKit deployment. Not tested against a running Element Call
  instance.
- **Element QR interop modes** — the QR payload now uses Element's
  cross-signing modes when bootstrapped: 0x01 (self, we trust our MSK:
  firstKey = my MSK, secondKey = peer device key), 0x02 (self, new
  device: firstKey = my device key, secondKey = my MSK claim — the
  scanner validates the MSK claim and, as the OLD device, signs the
  new device with the SSK: the Element self-verification flow), 0x00
  (cross-user: MSKs both ways, USK signing on completion). Mode 0x03
  (device-key only) remains as the pre-cross-signing fallback. Public
  key objects moved to namespaced com.grungus.cross_signing.* account
  data (the spec's m.cross_signing.* names hold the encrypted seeds,
  as in Element — a collision my earlier workaround would have
  caused).
- **Cross-signing** — the Matrix trust hierarchy: a master key (MSK)
  signs a self-signing key (SSK) and a user-signing key (USK); the SSK
  signs your own device keys. "Set up cross-signing" in the 🛡 overlay
  creates and publishes the keys (UIA password prompt — used once,
  never stored). After that, verify a new device ONCE and every device
  that trusts your master key trusts it too: when a verification of
  one of your own devices completes, this device signs its key with
  the SSK and uploads the signature; other devices validate the chain
  (locally-verified device → MSK → SSK → signed device) before
  trusting. Signatures use the spec's canonical JSON + Ed25519
  (accepted by conduwuit's server-side checks). Private-key
  distribution to other own devices uses SSSS recovery and encrypted secret
  sharing after own-device verification, so recovered devices can also sign. Cross-user
  USK signing exists; fetching OTHER users' MSKs depends on the server
  distributing them via /keys/query (Synapse does; this conduwuit
  build does not).
- **QR code verification (MSC3906)** — devices can verify each other by
  showing/scanning a QR instead of comparing emoji. The code carries
  the MSC3906 v2 binary payload ("MATRIX" + version + mode +
  transaction id + the shower's Ed25519/Curve25519 device keys + an
  11-byte shared secret). The scanner echoes the secret via
  m.reciprocate.v1 over the olm channel (physical-presence proof),
  MACs its own device key with the secret, and requires the shower's
  m.key.verification.done to arrive olm-authenticated by the SAME
  curve25519 the QR carried (substitution defense). Both sides land in
  the same trust store SAS uses. Scanning works via camera preview or
  image upload (headless hosts). Mode 0x03 is a Grungus extension
  (device-key verification) — Element's cross-signing modes 0x00-0x02
  wait for cross-signing support; Element interop for QR is not
  claimed yet.
- **Device verification (SAS)** — the 🛡 button in encrypted rooms starts
  emoji-based SAS verification (m.key.verification, real libolm
  SAS + HKDF MACs) with every other member's unverified device; both
  sides see the same emoji, confirming marks the device's Ed25519 key
  trusted. Incoming requests always PROMPT (Verify / Ignore) — nothing
  is ever auto-accepted.
- **Session verification** — the 🛡 button in the sidebar asks every
  other device of YOUR OWN user to verify this session (the "new
  login" flow): your existing device shows the request, the handshake
  runs, and both devices mark each other's Ed25519 keys trusted. The
  transaction completes only when BOTH sides have exchanged MACs —
  receiving the peer's MAC early never skips sending your own.
- **Unread badges** — per-room counters, cleared when you open the room.
- **Room creation** — inline "new room" form in the sidebar.
- **Strict TypeScript throughout** — typed Matrix event/sync shapes and
  a typed client event bus; `tsc --noEmit` is the CI lint gate. The only
  runtime dependency is Electron itself.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Electron main process   src/main/   →  dist/main.cjs         │
│   window lifecycle, session + crypto vaults (safeStorage), IPC │
└───────────────┬──────────────────────────────────────────────┘
                │ contextBridge (contextIsolation, sandbox on)
┌───────────────┴──────────────────────────────────────────────┐
│ Renderer            src/renderer/ → dist/assets/*.js + CSS  │
│                                                               │
│   app.ts ── orchestrates state and wiring                     │
│     ├── services/matrix-client.ts  typed Matrix CS API client │
│     ├── services/e2ee.ts           Olm/Megolm via libolm WASM │
│     ├── services/calls.ts          MSC3401 calls, mesh WebRTC │
│     └── components/*.ts             custom elements:           │
│           login-view, app-shell, space-rail, room-list,        │
│           chat-view, message-item, member-list, g-avatar       │
└──────────────────────────────────────────────────────────────┘
```

- **Vite + Tailwind CSS** build the renderer and capture picker as native ES
  modules with hashed JavaScript/CSS assets. Tailwind's theme tokens and
  component layer define the charcoal/mint interface, light theme, responsive
  layouts, and consistent controls. Existing custom elements remain the UI
  components; the Matrix services are independent of the build tools.
- **esbuild** bundles the Electron main process and sandboxed preloads as
  `.cjs`. Packaged renderer pages load from the secure `grungus://app` origin,
  which supports modules, authenticated fetches, WASM, and E2EE workers. The
  protocol serves only bundled renderer asset types. Vite emits `olm.wasm`
  and the LiveKit encryption worker unchanged at the renderer root.
- **Strict TypeScript end to end**: typed Matrix event/sync wire shapes,
  a typed client event bus, a timeline item union
  (`MessageItem | SystemItem`), and `HTMLElementTagNameMap` entries so
  `document.createElement("chat-view")` returns the right element class.
- **Tests and examples run the .ts sources directly** on Node ≥ 24 via
  native type stripping — no separate build for the test suite.
- Native custom elements; Tailwind utilities and shared component styles for the app and capture picker.
- The session and the E2EE identity pickles are stored encrypted via
  Electron's `safeStorage` when the platform keychain is available.
- CSP: scripts and styles only from the app plus `'wasm-unsafe-eval'`
  (WebAssembly for libolm, without allowing `eval()`); `connect-src *`
  because the homeserver URL is user-configured.

The `MatrixClient` public API and its existing imports remain the entry point
for the app, tests, and examples. It owns authentication, account APIs, room
lifecycle, and sync orchestration. Its implementation delegates to:

| Module | Responsibility |
|---|---|
| [`matrix-types.ts`](src/renderer/services/matrix-types.ts) | Wire types, client event contracts, shared room/message shapes, HTTP errors |
| [`matrix-rooms.ts`](src/renderer/services/matrix-rooms.ts) | Room defaults, current state, names, membership, and DM metadata |
| [`matrix-messaging.ts`](src/renderer/services/matrix-messaging.ts) | Outgoing messages, encryption guards, local echoes, and transaction IDs |
| [`matrix-media.ts`](src/renderer/services/matrix-media.ts) | Authenticated uploads/downloads, attachment decryption, and blob-cache ownership |
| [`matrix-history.ts`](src/renderer/services/matrix-history.ts) | Pagination, sync-gap boundaries, bounded windows, and deferred relations |
| [`matrix-timeline.ts`](src/renderer/services/matrix-timeline.ts) | Incoming timeline conversion, deferred decryption, and echo reconciliation |
| [`matrix-relations.ts`](src/renderer/services/matrix-relations.ts) | Edits, reactions, replies, and redactions applied to timeline items |
| [`matrix-rtc.ts`](src/renderer/services/matrix-rtc.ts) | RTC membership formats, media-key transports, and subscriptions |
| [`matrix-identifiers.ts`](src/renderer/services/matrix-identifiers.ts) | Identifier display helpers |

The services use explicit host interfaces or pure functions. They do not
import the facade at runtime; the facade re-exports shared types and helpers
so callers do not need to change their imports.

## Matrix protocol coverage

Grungus implements a dependency-free subset of the Matrix
Client-Server API (v3 paths, spec v1.x):

| Purpose | Endpoint |
|---|---|
| Homeserver discovery | `GET /.well-known/matrix/client` |
| Feature negotiation | `GET /_matrix/client/versions` |
| Login | `POST /_matrix/client/v3/login` (m.login.password) |
| Account creation | `POST /_matrix/client/v3/register` (UIA: m.login.dummy, m.login.registration_token) |
| Token check | `GET /_matrix/client/v3/account/whoami` |
| Profile | `GET /_matrix/client/v3/profile/{userId}` |
| Realtime | `GET /_matrix/client/v3/sync` (long-poll, incl. to-device) |
| Send message | `PUT …/send/{m.room.message \| m.room.encrypted}/{txnId}` |
| Room creation | `POST /_matrix/client/v3/createRoom` (incl. spaces, encryption) |
| Join / invite | `POST /join/{idOrAlias}`, `POST /rooms/{id}/invite` |
| Logout | `POST /_matrix/client/v3/logout` |
| Device keys | `POST /keys/upload`, `POST /keys/query`, `POST /keys/claim` |
| Room key sharing | `PUT /sendToDevice/m.room.encrypted/{txnId}` (olm) |
| Avatars / media | `GET /_matrix/client/v1/media/{thumbnail,download}/…` (Bearer; legacy media/v3 fallback) |
| Calls (MSC3401) | `m.call.member` state; `m.call.negotiate` / `m.call.candidates` to-device (olm in encrypted rooms, plaintext otherwise) |

Room state (names, topics, members, spaces, encryption) is derived from
`m.room.*` state events in the sync response, following the same model
Element uses. Device keys are signed with canonical JSON (Ed25519), the
same way Element signs them.

## Getting started

```bash
npm install
npm start        # production build + launch the desktop app
npm run dev      # Vite development server + Electron
npm run dev:web  # Vite development server in a browser
```

Log in with your Matrix credentials (e.g. `matrix.org` + username +
password), or with an access token from Element: Settings → Help & About.

Other scripts:

```bash
npm run build      # Electron (esbuild) + renderer (Vite/Tailwind) -> dist/
npm run typecheck  # tsc --noEmit (strict)
npm test           # client + E2EE suites vs the in-repo mock homeserver
npm run smoke      # build + boot the app, then exit (--smoke)
```

### Building distributables (no npm start)

The app is fully bundled into `dist/` (main + preloads + Vite renderer
assets + `olm.wasm` + the LiveKit E2EE worker), so packaged builds ship
ZERO node_modules — electron-builder wraps the dist plus the Electron
runtime:

```bash
npm run dist       # Vite/Tailwind + Electron packaging -> release/
npm run dist:dir   # same, but only the portable directory (fast)
```

`release/` gets three Linux targets (config in `electron-builder.yml`):

- `Grungus-<version>-x86_64.AppImage` — single-file, runs in place
  (`./Grungus-….AppImage`). Needs libfuse2 to mount itself; on Debian:
  `sudo apt install libfuse2`.
- `grungus_<version>_amd64.deb` — installs to `/opt/Grungus` with a
  menu entry: `sudo apt install ./grungus_…_amd64.deb`.
- `linux-unpacked/grungus` — portable directory: no install, no fuse,
  no root; copy it anywhere and run the `grungus` binary. The safest
  option on locked-down machines.

Details worth knowing:

- `olm.wasm` and the LiveKit E2EE worker are unpacked OUTSIDE the app
  archive (`asarUnpack`) — wasm fetches and Worker loads need real
  files; Electron's asar fallback resolves them transparently.
- Login sessions and the crypto vault live in the OS user-data dir
  (`~/.config/Grungus/`), so upgrading the app never touches them.
- The icon is generated by `scripts/make-icon.py` (stdlib-only PNG/ICO
  writer) into `build/icon.png` (Linux) and `build/icon.ico`
  (multi-size 16–256, PNG-embedded entries).
- CI packages the same three targets on every push and uploads them as
  the `grungus-linux` artifact — download straight from the Actions run
  if you don't want to build locally.

#### Windows

Two targets, built ONLY in CI on a native Windows runner (the
`grungus-windows` artifact):

- `Grungus-Setup-<version>.exe` — NSIS installer with a normal wizard
  (per-user by default, changeable install directory).
- `Grungus-<version>-portable.exe` — single-file portable build, runs
  without installing.

Cross-building Windows targets on Linux requires wine (for the exe
resource-editing step), which this system deliberately stays free of —
hence the CI-only path. The `npm run dist:win` script exists for
Windows machines that have the repo checked out.

### Frontend development and web preview

```bash
npm run dev      # Electron + Vite at http://127.0.0.1:5173
npm run dev:web  # browser-only Vite development server
npm run build
npm run preview  # serve the production renderer build
```

Vite provides renderer reloads and CSS hot updates. Restart `npm run dev`
after changing Electron main/preload code. `vite.config.ts` configures both
HTML entries, Tailwind, and the WASM/worker runtime assets. The strict packaged
CSP remains in place; only development permits Vite's injected styles.

Browser sessions and crypto pickles live in `localStorage` and are intended
for testing. Desktop sessions and crypto stay in their native vault files.
On the first desktop launch with the new renderer origin, the app copies
legacy appearance and device preferences from the previous file origin if
new-origin preferences have not already been set.

`npm run test:ui` builds the renderer fixtures with Vite and tests their real
Tailwind CSS, Olm WASM, E2EE worker loading, navigation, filtering, capture
consent, and legacy preference recovery. `npm run test:dev` checks the Vite
development server in Electron. `npm run smoke` tests the production renderer
and runtime assets with an isolated profile, leaving your account untouched.

## Security notes

- Renderer runs with `contextIsolation`, `sandbox`, and no Node access.
  Its allowlisted `grungusPlatform` bridge handles persistence and SSO.
  The separate capture-picker window has a restricted bridge for listing
  sources and returning a selection.
- Access tokens and olm identity pickles are stored via `safeStorage`
  (OS keychain) where available; the fallback plaintext file is written
  `0600` in the Electron user data directory and is documented here as a
  known trade-off. In browser dev mode pickles live in `localStorage`.
- **Device trust**: SAS and QR verification, cross-signing, and encrypted
  secret storage are available. Newly sent room keys are currently shared
  with all joined members' devices, including unverified ones; verification
  does not enable a verified-devices-only sending policy. Verify device
  identities or establish a trusted cross-signing chain when identity
  assurance matters.
- **History and recovery**: server-side encrypted key backup and restore
  are supported. Room-key forwarding permits your own devices and verified
  devices of other users. Sessions rotate on membership changes; a new
  device needs a backup or an eligible forwarding device to recover older
  history. Cross-signing seeds can be restored through SSSS or shared after
  own-device verification.
- Sends fail closed: an encrypted room without a working E2EE layer never
  receives plaintext.
- **Calls**: encrypted-room mesh signaling uses Olm; legacy 1:1 call events
  use Megolm. WebRTC provides DTLS-SRTP transport encryption. Mesh calls add
  frame encryption when insertable streams are available, and encrypted
  LiveKit calls use the LiveKit E2EE worker. Legacy 1:1 calls use DTLS-SRTP
  without Grungus's additional frame format for Element compatibility.
  Matrix call membership and room metadata remain visible to the server.
  New rooms permit `m.call.member` at power level 0; restrictive power
  levels in existing rooms can prevent members from publishing call state.
- Messages render as text only; HTML from other clients is not executed.
- Media is fetched with authenticated requests (Bearer header) and
  rendered from blob object URLs — compatible with homeservers that
  require authenticated media (e.g. matrix.org).

## Testing

Checks exercise the typed client modules and custom elements that ship in the app:

1. **Typecheck** — `npm run typecheck` (`tsc --noEmit`, strict, across
   src/tests/examples/livekit and the Vite configuration).
2. **Integration tests vs an in-repo mock homeserver** — `npm test` covers
   authentication, sync, messages and relations, history, media, calls,
   verification, cross-signing, key recovery, and fail-closed encryption.
3. **Renderer interactions** — `npm run test:ui` runs sandboxed Electron
   checks for capture selection/cancellation, audio consent, image retry,
   safe text rendering, and bounded history navigation.
4. **Real-homeserver e2e** — `npm run test:homeserver` starts a disposable
   Synapse instance and checks real pagination, encrypted chat and media,
   verification, key forwarding, rotation, invites, and backup restoration.
   To use another server, run `npm run test:e2e` with the environment
   variables documented in `tests/e2e-real-homeserver.ts`.
5. **Electron boot** — `npm run smoke` builds the application, opens its
   window, and exits after it becomes ready.

CI runs these checks on Ubuntu, using Xvfb for Electron and a separate
Synapse interoperability job, and packages Linux and Windows distributables.

The E2EE layer has also been verified in a real browser against a real
homeserver: bidirectional encrypted chat with a headless second device,
sender self-visibility, and correct "unable to decrypt" notices for
history predating the device.

Calls are verified in layers: signaling suites (member state visibility,
plaintext signals, olm-encrypted signals — all in `npm test`), the
real-homeserver e2e (membership publish/clear), and a live two-party
call in a real browser against the real homeserver — full mesh
established, `connectionState: connected` on both peers, two media
tracks delivered and the video decoding over DTLS-SRTP, hangup via the
product UI.

Typing notifications, composer media sending, and SAS device
verification are each verified twice: a mock-homeserver suite in
`npm test` (typing round-trip; upload/send/receive/download byte
equality; full SAS handshake with identical emoji, mutual device-trust
marking, and a forged-MAC rejection) and the real-homeserver e2e
(typing over conduwuit; a megolm-wrapped `m.image` event decrypted by
the peer with an authenticated media fetch; SAS against a second real
device). The SAS UI path — verify button, emoji comparison card,
"They match" confirmation — was additionally driven live in the
browser against a real second device.

Key forwarding, rotation, and invites are verified the same way:
mock suites (a second device of the same user decrypts history; an
unverified stranger is declined; a SAS-verified member gets history
after joining; joiners read post-join but not pre-join messages;
leavers cannot read future messages; invite appear/accept/decline),
the real-homeserver e2e (rotation and invites over conduwuit; a fresh
login of the same user receiving history via a forwarded key), and
live in the browser: a fresh device's "unable to decrypt" lines in a
room with real history turned into the decrypted messages in place,
and an invite card was accepted through the UI with messages flowing
immediately after. One real bug class was found and fixed during this
verification: a send racing the first sync of a room used to leak
plaintext into encrypted rooms — createRoom/joinRoom now carry the
encryption flag and unknown-room sends fail closed.

SSO login is verified against the mock homeserver's Keycloak-style
redirect dance (flows discovery → redirect to the IdP → callback with
loginToken → m.login.token exchange → a fully working session, plus
forged-token rejection) and live in the browser: the two-step login
shows "Continue with University Keycloak" after entering the server
domain, and clicking it completes the entire redirect round-trip and
lands in the app as the SSO user. The Electron auth-window path shares
the same client code and is exercised by the same suites; conduwuit
does not implement SSO, so the mock is the SSO test bed.

Key backup is verified in three layers: the mock suite (create with a
passphrase, automatic backup of received sessions, fresh device
restores and decrypts history with the first device offline, wrong
passphrase rejected), the real-homeserver e2e on a dedicated fresh
account (create over conduwuit, sweep PUTs with ?version=, a second
device restoring and decrypting history purely from the backup —
conduwuit only ever allows manipulating the FIRST backup version, so
the e2e registers a throwaway account per run), and live in the
browser (the 🔑 overlay created a real 500k-iteration backup and
reported the version).

Small CLI tools in `examples/` (list-rooms, tail-room, send-message) use
the same client from Node — handy for debugging and demos.

## Roadmap

- **Calls hardening** — in-app screen/source picker, Element Call
  interoperability for GROUP rooms (1:1 DM calls interoperate with
  Element through the legacy room-event protocol — see above), and
  insertable-streams E2EE media on top of DTLS-SRTP. (Screenshare
  shipped; the LiveKit SFU shipped — see above.)
- **E2EE hardening** — QR device verification, cross-signing.
  (SAS verification, key forwarding to own/verified devices, rotation
  on membership change, and server-side key backup shipped — see above;
  verification persistence is per-device-store only.)
- Space management UI, message
  editing/reactions, reply chains.
- Server-side read markers and notification delivery improvements
  (Electron + Push Gateway).

## License

MIT — see [LICENSE](LICENSE).

### LiveKit room authorization

The bundled token service requires `HS_AUTH_TOKEN`, the access token of a
service account joined to every Matrix room it serves. It checks the requesting
user's current `m.room.member` state before issuing a LiveKit token. Missing
configuration, inaccessible rooms, and users who have left are denied.
Clients must send the actual Matrix room ID as `room_id`; `room` is no longer
an authorization input. LiveKit room names are derived from the SHA-256 hash
of the complete Matrix room ID, so custom names and truncated/sanitized names
are no longer used by this service. Upgrade the service and clients together,
and restart existing calls when migrating. This service-account approach
requires inviting the account into private rooms; deployments requiring
membership checks without a joined account need a homeserver-side integration.

### Attachment and vault protection

Images sent into encrypted rooms use Matrix encrypted attachments v2: the
client uploads ciphertext and includes its key, IV, and ciphertext hash only
inside the encrypted room message. Downloads verify the hash before decrypting.
Previously uploaded plaintext media remains on the server; this change does
not retroactively encrypt it. Raw `sendMedia` calls are refused in encrypted
rooms; use `uploadAndSendMedia` instead.

Desktop crypto-vault updates use an atomic replacement and retain the previous
valid file as `grungus-crypto-vault.json.bak` in the user-data directory. An
unreadable vault or locked keychain produces an error instead of initializing
an empty vault. Unlock the keychain and retry; if the file is corrupted, close
the app and restore a known-good vault backup before restarting. Backups can
lag the latest session writes, so preserve both files before recovery.

### History and memory limits

Use **Earlier messages**, **Newer messages**, and **Latest messages** above the
chat to browse history. History uses the homeserver's `/messages` tokens and
preserves chronological order, edits, and reactions across pages. A limited
sync starts a fresh contiguous window and automatically fetches the first
missing page; Earlier messages continues backward if the gap is larger.
Historical state does not replace current room state, and old call events do
not ring again.

Each room retains up to 1,000 timeline items, and the chat renders at most 100
at once. Paging beyond that window drops its newer end; Latest messages
returns to the current server timeline. Media and avatar caches retain at
most 128 entries each (64 MiB and 8 MiB respectively), release blob URLs on
eviction/logout, and allow failed downloads to be retried. An individual
image larger than the media cache limit is not displayed inline.

### Screen sharing

The desktop app asks which screen or window to share. Share stays disabled
until a source is selected; cancelling never starts a synthetic share. System
audio is off by default and can be explicitly enabled for supported Windows
mesh/SFU captures. Legacy 1:1 calls share video only. Synthetic capture remains
available when the display-capture API itself is absent in test environments.

### Token-service configuration

Set non-default `LK_API_KEY` and `LK_API_SECRET`; the service refuses missing
or development credentials. `VERIFY_MODE=openid` is the default and accepts
only OpenID proofs. Trusted deployments using session-token authentication
must explicitly set `VERIFY_MODE=whoami` and `auth_mode: "whoami"` in their
`com.grungus.livekit` room state. OpenID clients no longer include their session
token as an automatic fallback. Identity and membership requests time out
after 10 seconds; JSON request bodies are limited to 16 KiB, with 15-second
HTTP request/header deadlines.

### Additional automated checks

```bash
npm run test:ui          # sandboxed Electron renderer interaction checks; needs a display
npm run test:homeserver  # disposable Synapse 1.160.0 via Docker
CONTAINER_RUNTIME=podman npm run test:homeserver
```

The Synapse runner binds an ephemeral port on loopback and removes its own
container and volume afterward. `SYNAPSE_IMAGE` overrides the pinned version.
CI runs renderer checks under Xvfb and runs the real-homeserver suite in a
separate job, alongside the mock integration tests and strict typechecking
(which includes the deployable token service).

### Recovery after sign-in

After a new login (password, token, or SSO), Grungus prompts you to verify
with another signed-in device or restore history using your recovery
passphrase/security key. Device verification uses the existing emoji/QR flow;
recovery also unlocks cross-signing secrets and signs this device with the
existing account identity when those secrets are available. You can
skip and return through the sidebar's verification and key-backup actions.
Existing saved sessions resume without repeating the prompt.

If neither recovery method is available, choose **I cannot recover my keys**.
After you acknowledge the possible loss of older history, Grungus checks your
account password with the homeserver using a temporary session, then deletes
the current backup version and clears the obsolete `m.megolm_backup.v1` secret.
The temporary session is logged out without replacing your current session.
You are then prompted to create a backup with a new passphrase. This requires
password login support; SSO-only accounts must recover through another device
or their homeserver's account recovery process. Reset does not replace your
cross-signing identity or erase keys held locally on your devices. History
whose only keys were in the deleted backup can no longer be recovered.

### Emoji picker

Use the smiley button beside the message field to select an emoji. The picker
works offline, with categories and English/German keyword search. Selection
inserts at the cursor or replaces selected text, including while editing or
replying. Escape or clicking outside closes the picker. Emoji searches stay
on your device.

The picker now includes the full bundled Emojibase Unicode catalog (about 4,000
entries), including skin tones, flags, and combined emoji sequences. It renders
using the system's native emoji fonts; support for the newest symbols depends
on the fonts installed on the device. Categories, English/German search, and
**More emojis** make the full list available offline.

On a message, choose **Choose a reaction** (☺+) to open the same full picker.
Selecting an emoji adds that reaction to the selected message. The quick reaction
buttons remain available. Escape or clicking outside closes the picker.


### KLIPY GIF picker

For a private build for you and your friends, create `.env.local` in the repository
root and add the KLIPY client API key you obtained from the
[KLIPY Partner Panel](https://partner.klipy.com/):

```dotenv
VITE_KLIPY_API_KEY=your_klipy_api_key
```

Then run `npm run build` or package the app as usual. Vite includes your key in
the renderer, so friends using that build can search GIFs without entering a key.
Restart `npm run dev` after changing this file during development. `.env.local`
is ignored by Git; [.env.example](.env.example) contains the configuration template.
This is a client API key: recipients can inspect it in the application bundle.

**Settings → Preferences** also supports an optional personal KLIPY key. A
personal key takes precedence over the bundled one; clearing it returns to the
shared application key. Without either key the picker shows a setup hint.
Existing GIPHY keys are not reused.

The **GIF** button beside the message field opens trending GIFs and a searchable,
paginated KLIPY picker. Search errors, invalid keys, rate limits, and empty
results are shown in the picker. Closing it or changing rooms cancels requests.
Searches and previews connect directly to KLIPY without Matrix credentials or
message text. The provider's `high` content filter is requested.

Selecting a GIF sends `/gif <original media URL>` as a normal message, encrypted
in encrypted rooms. You can also type the command manually, for example:

```text
/gif https://static.klipy.com/ii/4e7bea9f7a3371424e6c16ebc93252fe/0e/38/pDi70ntRCEC9vvhtwC.gif
```

Grungus embeds the GIF directly in the chat, with a link and retry on load
failure. Plain links and unsupported `/gif` URLs remain ordinary text. Other
Matrix clients receive the command as text. Media is not copied to the Matrix
server, following [KLIPY's direct-delivery requirements](https://docs.klipy.com/integration-requirements).
The picker displays **Powered by KLIPY** and preserves returned media URLs.
Live search requires a working KLIPY key; automated checks use mocked responses
matching the [native GIF API](https://docs.klipy.com/gifs-api).

### Direct-message avatars

The conversation sidebar shows the other person's profile image for a 1:1 DM,
including named rooms marked as direct messages in Matrix account data. It uses
the room-member avatar first, then the person's global profile image if needed.
Group rooms keep their room image. Initials remain the fallback without a photo.

### Logging out sessions

In **Settings → Sessions**, select **Log out** beside another device and enter
your account password in the inline form, then choose **Confirm logout**.
Cancel leaves the session active; authentication errors are shown in Settings.
**Settings → My Account → Log out** signs out this device and clears its saved
login, using the same logout flow as the sidebar.

### Element encryption interoperability

Recovery through the login prompt or **Key backup → Restore history** now
recovers both the existing cross-signing identity and message history. Element
security keys and recovery passphrases are supported. Public identity keys are
loaded from standard `/keys/query` responses, and private seeds are checked
against that identity before the current device is signed. History-only backups
without signing secrets are explicitly reported as insufficient to verify a
session. Verification can succeed even when there is no history backup.

If you previously restored history while Element still reported your Grungus
device as unverified, restart the updated app. When valid signing seeds are
already stored, Grungus repairs its device signature automatically. Otherwise,
use **Key backup → Restore history** once with the recovery key for the account
logged into Grungus. Successful identity recovery reports **This device is
verified**. There is no need to reset the backup or account identity. The other account's independent identity
may still need normal contact verification in Element.

Incoming encrypted events support modern clients that omit the deprecated
`sender_key`/`device_id` fields. Events remain tracked while their room key is
missing, and a late normal room-key delivery triggers decryption again. Sessions
and decrypted payloads are checked against the room before displaying messages.


Key replenishment uploads only one-time keys and never replaces a device's
cross-signatures. Restarting an existing device also preserves those signatures.
Received Megolm keys and established Olm sessions are saved as pickles through
the existing crypto vault, scoped to the account/device, so they survive restarts
without another recovery-key entry. A later key share cannot replace an earlier
session with one that decrypts less history. Successfully recovering a signing
identity retries previously blocked room-key requests.

`tests/element-crypto.test.ts` uses `@matrix-org/matrix-sdk-crypto-wasm` as a
**test-only** dependency: Element's Rust engine sends encrypted messages to
Grungus, decrypts replies, and checks owner cross-signing after recovery, key
replenishment, and restart. It also delivers a new room key through an existing
Olm session after Grungus restarts. This supplements the mock-server and real
Synapse checks; it does not automate the user's installed Element application.


### Starting direct messages

Use the **New direct message** speech-bubble button at the top of the conversation
sidebar. Search by display name or Matrix ID in your homeserver's user directory,
then select a result. Alternatively, enter a full ID such as `@friend:example.org`
and choose **Start chat**; this also works when directory search is unavailable.
The homeserver controls which users its directory exposes, including whether
remote users appear.

Grungus opens an existing one-to-one conversation where possible. Otherwise it
creates a private encrypted room, invites the selected person, and records it in
Matrix `m.direct` account data without replacing other DM mappings. The new chat
appears in **Direct Messages** while the invite is pending and opens as soon as
it syncs. The invited DM partner receives keys for messages sent before invite
acceptance, so the first greeting remains readable after they join. Search errors are shown in the dialog; closing it cancels pending search.


### Presence dots

The room member list and the DM sidebar display a status dot on each person's
avatar: green for Matrix `online`, gray for `offline` or `unavailable` (away).
Hover or use the accessibility label to distinguish offline, away, and unknown
status. Updates arrive through `/sync` presence events and refresh immediately,
without requiring a message or membership change.

Presence visibility depends on the homeserver. When it does not supply presence
(for example because presence is disabled), the dot is gray and labeled
**Presence unavailable**, rather than claiming that the person is offline.
Room/group icons do not receive person-presence dots.

### Discovering rooms

Use **Explore rooms** (the search icon in the room sidebar header) to browse your homeserver’s published room directory. Search names or topics, load additional results, and select **Join** to enter a public room or **Open** for an existing room. Each entry shows its topic and member count. Private and unlisted rooms are not discoverable; listed rooms with restricted access are labeled accordingly. The homeserver controls directory visibility and admission.

When a space is selected, **Browse rooms in this space** opens its visible child rooms, including rooms you have not joined. Results come from the space hierarchy rather than the public homeserver directory. Search filters loaded rooms; **Load more rooms** fetches additional children. Space-restricted rooms offer a join attempt subject to server access checks. Joining keeps the selected space open. Nested spaces themselves are excluded from this room list.

Chats show **End-to-end encrypted** or **Not encrypted** in the header, with a persistent status below the message composer that also remains visible on small screens. The status follows the room’s encryption setting for both DMs and group rooms, applies to new messages, and does not imply that participants’ devices are verified or that older history was encrypted.

Within spaces, the sidebar separates **Text rooms** and **Video rooms**, with hash and camera icons. The room creation form offers both types and adds new rooms to the selected space. Video rooms (`org.matrix.msc3417.call` and `io.element.video`) offer **Join call** when a call is active and **Start call** when empty. Both enter audio-only; camera capture is an explicit option in the call screen. They never initiate legacy one-to-one calls or ring space members when someone joins. Video rooms use their configured LiveKit service or discover the MatrixRTC backend through the homeserver’s transports endpoint or client well-known configuration. If none is available, Grungus reports the missing backend instead of opening a separate call. Existing Element sessions use the oldest active member’s advertised backend. Leaving disconnects only the participant; the room remains available to join again.

The call screen includes microphone and speaker selectors that apply during a call and save successful selections to Voice & Video settings. **System default** resets the device choice; **Refresh devices** reloads available devices, which also refresh automatically when devices are connected or removed. Switching microphones preserves mute state and retains the previous microphone if capture or track replacement fails. The call layout provides participant counts, audio-only avatars, larger video tiles, screen presentations, and accessible mute/share/leave controls.

Element call notifications and membership changes appear as call activity cards in the timeline; loading history never replays call signaling. Call connection shows **Connecting…** and prevents repeated clicks. Errors remain visible below the composer. MatrixRTC authorization uses the full temporary OpenID proof and device identity expected by Element’s token service; the regular Matrix session token is reserved for explicitly configured trusted Grungus services.

Remote camera feeds automatically take the centre of the call screen, with participant tiles in a scrollable column on the right. When several cameras are on, the video button on a participant tile selects the featured feed; screen sharing takes priority. Profile pictures identify participants in both camera-off tiles and tile labels, using room membership avatars with a profile lookup fallback. When the last remote camera stops, the participant grid returns. On narrow screens the participant column becomes a horizontal strip below the main video.

Speaking participants receive a green tile outline and a **Speaking** badge, including both the featured video and the participant column. LiveKit uses its active-speaker events; direct and mesh calls analyse microphone/received voice audio locally, with a short hold between syllables. Muting clears the local indicator. Voice analysis does not capture additional media, send audio elsewhere, or connect the microphone to the speakers, and is released when the call ends.

In **Settings → Appearance → Background picture**, choose a local picture to enable a translucent interface. The picture fills the window with a slight blur, while panels retain clear borders in dark and light themes. The image is resized and saved only on this device, including across restarts; it is never uploaded to the homeserver. **Remove background** restores the solid interface. PNG, JPEG, WebP, GIF, and AVIF files up to 20 MB are accepted; animated images use a still frame.

### Settings improvements

Settings include keyword search, keyboard focus handling, and a **Security & Privacy** section linking to the existing recovery-backup and session-verification flows. Backup availability is checked against the server. **Sessions** supports inline renaming and displays the last-seen address when reported by the homeserver. **Appearance** can follow the operating system’s theme automatically.

**Notifications** shows desktop permission status, offers permission and test-notification buttons, and can hide sender, room, and message previews. **Voice & Video** includes device refresh and explicit microphone/camera tests; previews stay local and stop when the panel closes or changes. **Advanced → Clear downloaded media** preserves the session, preferences, and encryption keys.

Message preferences control incoming typing indicators, automatic scrolling, timestamps, and basic Markdown display (bold, italic, inline/fenced code, strikethrough, and HTTP(S) links). Message HTML is never interpreted. These options are adapted from [Element’s documented settings](https://docs.element.io/latest/element-support/element-webdesktop-client-settings/element-settings/); Grungus does not implement every Element setting or server feature.

### Room views and management

Rooms provide **Chat**, **Threads**, and **Info** tabs. Use **Reply in thread** on a message to create or continue a Matrix `m.thread` conversation. Threads load server-side roots and replies with pagination, include replies already received through sync, and send through the same encryption path as ordinary messages. Encrypted replies expose the thread relation for server indexing while keeping message text encrypted. If the homeserver does not support thread discovery, the view explains the error and shows threads found in the loaded chat history. Missing decryption keys are reported; recover the keys and refresh to retry.

**Info** shows the room topic, address, ID, encryption/access status, members, and **Room settings**. A selected space has a **Space settings** gear in the sidebar header. These dialogs edit name, topic, picture, access, and history rules according to Matrix power levels; rooms can also enable end-to-end encryption for future messages. Encryption cannot be disabled. Space settings add or remove links to existing joined rooms; removing a link does not delete the room. Permissions are checked again before writes and the homeserver remains authoritative. Settings are saved as individual state events, so a server error can leave earlier changes saved; the dialog reports that partial result.

Space settings also offer **Create a new room**: choose text or video, name, topic, picture, invitations, invite-only/space-member/public access, history visibility, and encryption (on by default). Advanced options include a room address, public directory listing, announcement-only messaging, and member invitation permissions. The room is linked to the selected space after creation. If linking fails, retry adds the already-created room without creating a duplicate; you can also open it directly. Restricted access depends on homeserver support.
