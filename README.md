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
  hang up, per-peer connection state. When no capture devices exist,
  a synthetic canvas/oscillator stream keeps calls working (with a
  visible notice) — handy on headless hosts.
- **Screen sharing** — "Share screen" in the call overlay captures the
  display (getDisplayMedia; in Electron a picker lists screens and windows, with system audio
  off until explicitly selected on supported platforms) and adds it to every peer connection with mid-call
  renegotiation from either role (perfect negotiation with polite-side
  rollback). The active screen renders as a large presentation tile.
  Mesh bandwidth discipline: content-hinted screen encoding (~1.5 Mbps
  cap, 10 fps — screens tolerate low fps, text stays sharp), one share
  at a time. m.call.screenshare start/stop rides the same encrypted
  signaling (a Grungus extension, Element interop untested). Hosts
  without display capture fall back to a synthetic screen so the whole
  pipeline stays verifiable.
- **Calls through a LiveKit SFU (optional)** — rooms with a
  `com.grungus.livekit` state event ({url, room, auth_url}) route calls
  through a LiveKit server instead of the mesh: the bandwidth ceiling
  is gone (the SFU does simulcast — publish once, the server fans out
  appropriate layers to each receiver). Identity flow (Element
  lk-jwt-service pattern): the client proves its Matrix identity to a
  token service (OpenID token, with whoami fallback for homeservers
  with federation disabled) and receives a short-lived LiveKit access
  token; the API secret never touches the client. Media falls back to
  synthetic streams on headless hosts. Rooms without a LiveKit state
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
- Server-side read markers, presence, notifications
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
recovery restores keys but does not itself mark a device cross-signed. You can
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
