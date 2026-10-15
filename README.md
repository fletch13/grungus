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
- **Unread badges** — per-room counters, cleared when you open the room.
- **Room creation** — inline "new room" form in the sidebar.
- **Zero runtime dependencies** — the entire Matrix client is a single
  dependency-free module; Electron is the only (dev) dependency.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main process            src/main/                  │
│   window lifecycle, session vault (safeStorage), IPC       │
└───────────────┬─────────────────────────────────────────────┘
                │ contextBridge (contextIsolation, sandbox on)
┌───────────────┴─────────────────────────────────────────────┐
│ Renderer                        src/renderer/               │
│                                                             │
│   app.js ── orchestrates state and wiring                   │
│     ├── services/matrix-client.js   Matrix CS API client    │
│     └── components/*.js              custom elements:        │
│           login-view, app-shell, space-rail, room-list,     │
│           chat-view, message-item, member-list, g-avatar     │
└─────────────────────────────────────────────────────────────┘
```

- No build step, no bundler, no framework: classic scripts and native
  custom elements. `src/renderer` also runs as a plain web page.
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

Room state (names, topics, members, spaces) is derived from
`m.room.*` state events in the sync response, following the same model
Element uses.

## Getting started

```bash
npm install
npm start        # launch the desktop app
```

Log in with your Matrix credentials (e.g. `matrix.org` + username +
password), or with an access token from Element: Settings → Help & About.

### Web demo mode

The renderer is plain web tech — you can serve it without Electron:

```bash
cd src/renderer && python3 -m http.server 8080
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

## Testing

Four layers, all driving the same client module that ships in the app:

1. **Syntax gate** — `npm run check` (`node --check` over every JS file).
2. **Integration tests vs an in-repo mock homeserver** — `npm test`
   (login, sync, bidirectional messages, local echo, unread, DM
   resolution, spaces, auth-error handling).
3. **Real-homeserver e2e** — `tests/e2e-real-homeserver.js` (run manually
   against conduwuit/Synapse/matrix.org-style servers; exercises UIA
   registration, real sync, real state events). See the header of that
   file for the env vars.
4. **CI** — syntax + tests + an Electron boot smoke test
   (`electron . --smoke` under xvfb on ubuntu-latest).

Small CLI tools in `examples/` (list-rooms, tail-room, send-message) use
the same client from Node — handy for debugging and demos.

## Roadmap

- E2EE (Olm/Megolm) via libolm/WebAssembly
- Invites UI (rooms.invite in sync), space management UI
- Server-side read markers, presence, typing notifications
- Media sending, message editing/reactions, reply chains
- Notifications (Electron + Push Gateway)

## License

MIT — see [LICENSE](LICENSE).
