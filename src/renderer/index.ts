/*
 * Grungus — renderer entry.
 *
 * ES-module imports; esbuild bundles everything into dist/renderer.js as
 * ONE classic script (Chromium/Electron block ES modules from file://).
 * Import order is irrelevant — the module graph resolves dependencies.
 */
import "./components/ui.ts";
import "./components/login-view.ts";
import "./components/space-rail.ts";
import "./components/room-list.ts";
import "./components/message-item.ts";
import "./components/chat-view.ts";
import "./components/member-list.ts";
import "./components/app-shell.ts";
import "./components/call-view.ts";
import "./components/verify-view.ts";
import "./components/backup-view.ts";
import "./components/settings-view.ts";
import "./components/incoming-call.ts";
import "./app.ts";
