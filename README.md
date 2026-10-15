# Grungus

A Discord-style desktop chat client for the [Matrix](https://matrix.org)
network — the same open, federated protocol that
[Element](https://element.io) runs on. Point it at any homeserver
(matrix.org, a self-hosted Synapse, conduwuit, dendrite, …) and chat in a
familiar, Discord-like UI.

Not affiliated with Discord or Element. Grungus is an independent client
for an open protocol.

![Grungus screenshot](docs/screenshot.png)

## Features

- **Matrix login** — password or access-token, with
  `.well-known/matrix/client` homeserver discovery, exactly like Element.
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
  via authenticated media downloads; GIFs animate natively.
- **Unread badges** — per-room counters, cleared when you open the room.
- **Room creation** — inline "new room" form in the sidebar.
- **Strict TypeScript throughout** — typed Matrix event/sync shapes and
  a typed client event bus; `tsc --noEmit` is the CI lint gate. The only
  runtime dependency is Electron itself.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Electron main process   src/main/   →  dist/main.cjs           │
│   window lifecycle, session vault (safeStorage), IPC           │
└───────────────┬──────────────────────────────────────────────┘
                │ contextBridge (contextIsolation, sandbox on)
┌───────────────┴──────────────────────────────────────────────┐
│ Renderer                 src/renderer/ → dist/renderer.js     │
│                                                               │
│   app.ts ── orchestrates state and wiring                       │
│     ├── services/matrix-client.ts  typed Matrix CS API client │
│     └── components/*.ts             custom elements:           │
│           login-view, app-shell, space-rail, room-list,        │
│           chat-view, message-item, member-list, g-avatar       │
└──────────────────────────────────────────────────────────────┘
```

- **esbuild** produces three outputs in `dist/`: the main process and
  preload (CJS, `.cjs` because package.json is `type: module`) and the
  renderer as ONE classic-script IIFE. A bundle is required: Chromium and
  Electron block ES modules loaded from `file://` (CORS).
- **Strict TypeScript end to end**: typed Matrix event/sync wire shapes,
  a typed client event bus, a timeline item union
  (`MessageItem | SystemItem`), and `HTMLElementTagNameMap` entries so
  `document.createElement("chat-view")` returns the right element class.
- **Tests and examples run the .ts sources directly** on Node ≥ 24 via
  native type stripping — no separate build for the test suite.
- No framework: native custom elements, one stylesheet.
- The session (homeserver, user, access token) is stored encrypted via
  Electron's `safeStorage` when the platform keychain is available.
- CSP: scripts and styles only from the app; `connect-src *` because the
  homeserver URL is user-configured.

## Matrix protocol coverage

Grungus implements a dependency-free subset of the Matrix
Client-Server API (v3 paths, spec v1.x):

| Purpose | Endpoint |
|---|---|
| Homeserver discovery | `GET /.well-known/matrix/client` |
| Feature negotiation | `GET /_matrix/client/versions` |
| Login | `POST /_matrix/client/v3/login` (m.login.password) |
| Token check | `GET /_matrix/client/v3/account/whoami` |
| Profile | `GET /_matrix/client/v3/profile/{userId}` |
| Realtime | `GET /_matrix/client/v3/sync` (long-poll) |
| Send message | `PUT /_matrix/client/v3/rooms/{id}/send/m.room.message/{txnId}` |
| Room creation | `POST /_matrix/client/v3/createRoom` (incl. spaces) |
| Join / invite | `POST /join/{idOrAlias}`, `POST /rooms/{id}/invite` |
| Logout | `POST /_matrix/client/v3/logout` |
| Avatars | `GET /_matrix/media/v3/thumbnail/…` (Bearer-authenticated media) |
| Images / GIFs | `GET /_matrix/media/v3/download/…` (Bearer-authenticated media) |

Room state (names, topics, members, spaces) is derived from
`m.room.*` state events in the sync response, following the same model
Element uses.

## Getting started

```bash
npm install
npm start        # build + launch the desktop app
```

Log in with your Matrix credentials (e.g. `matrix.org` + username +
password), or with an access token from Element: Settings → Help & About.

Other scripts:

```bash
npm run build      # esbuild -> dist/
npm run typecheck  # tsc --noEmit (strict)
npm test           # client suite vs the in-repo mock homeserver
npm run smoke      # build + boot the app, then exit (--smoke)
```

### Web demo mode

The renderer bundle is plain web tech and `dist/` is self-contained, so
you can serve it without Electron:

```bash
npm run build
cd dist && python3 -m http.server 8080
# open http://localhost:8080
```

In this mode the session is stored in `localStorage` (fine for testing,
use the desktop app for day-to-day).

## Security notes

- Renderer runs with `contextIsolation`, `sandbox`, no Node access;
  the only bridge is a small `grungusPlatform` API (session load/save/clear).
- Access tokens are stored via `safeStorage` (OS keychain) where available;
  the fallback plaintext file is written `0600` in the Electron user data
  directory and is documented here as a known trade-off.
- E2EE (Olm/Megolm) is **not** implemented yet — treat messages as
  server-readable until it lands (see roadmap).
- Messages render as text only; HTML from other clients is not executed.
- Media is fetched with authenticated requests (Bearer header) and
  rendered from blob object URLs — compatible with homeservers that
  require authenticated media (e.g. matrix.org).

## Testing

Four layers, all driving the same typed client module that ships in the app:

1. **Typecheck** — `npm run typecheck` (`tsc --noEmit`, strict, across
   src/tests/examples).
2. **Integration tests vs an in-repo mock homeserver** — `npm test`
   (login, sync, bidirectional messages, local echo, unread, DM
   resolution, spaces, media metadata, auth-error handling).
3. **Real-homeserver e2e** — `tests/e2e-real-homeserver.ts` (run manually
   against conduwuit/Synapse/matrix.org-style servers; exercises UIA
   registration, real sync, real state events, and authenticated media).
   See the header of that file for the env vars.
4. **CI** — typecheck + tests + an Electron boot smoke test
   (`electron . --smoke` under xvfb on ubuntu-latest).

Small CLI tools in `examples/` (list-rooms, tail-room, send-message) use
the same client from Node — handy for debugging and demos.

## Roadmap

- **E2EE (Olm/Megolm)** — the highest-value item; blocks most call work
  (see below) and private-room usability against other clients.
- **Voice/video calls** — not supported today, and the largest feature on
  this list. Native Matrix group calls (MSC3401, what Element Call uses)
  sit on top of E2EE (call member auth and media keys flow through
  Olm/Megolm) plus WebRTC media transport. Realistic sequence: E2EE →
  call signaling over to-device events → WebRTC (ideally via an SFU).
  Interim option: embed Element Call in a `<webview>` window before
  native calls land. Legacy 1:1 calls (`m.call` events) are possible
  without the full group-call stack but are deprecated in the ecosystem
  and still need WebRTC — not worth doing before the MSC3401 path.
- Invites UI (rooms.invite in sync), space management UI, media sending
  from the composer, message editing/reactions, reply chains.
- Server-side read markers, presence, typing notifications.
- Notifications (Electron + Push Gateway).

## License

MIT — see [LICENSE](LICENSE).
