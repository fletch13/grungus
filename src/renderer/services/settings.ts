import { isBackgroundImage } from "./background.ts";
/*
 * Grungus — the settings store: typed, persisted to localStorage, with
 * subscribers. One instance drives every settings panel and gates the
 * features it names (typing notifications, read receipts, theme, …).
 */

export type ThemeName = "dark" | "light" | "system";

/** All user-facing settings, Element-style. Defaults mirror Element's. */
export interface GrungusSettings {
  /* Appearance */
  theme: ThemeName;
  /** Local normalized background image; empty disables translucent panels. */
  backgroundImage: string;
  /** font scale multiplier for the whole app (0.85 … 1.3) */
  fontScale: number;
  /** compact message density */
  compact: boolean;
  /** show message timestamps (Preferences in Element) */
  showTimestamps: boolean;

  /* Preferences */
  /** send typing notifications to the room */
  sendTypingNotifications: boolean;
  /** show others' typing indicator (receiving) */
  showTypingIndicator: boolean;
  /** send m.read receipts + m.fully_read markers */
  sendReadReceipts: boolean;
  /** render markdown in messages */
  renderMarkdown: boolean;
  /** Enter sends, Shift+Enter newline (off = Ctrl/Cmd+Enter sends) */
  enterToSend: boolean;
  /** auto-scroll to the newest message when a room is opened */
  autoScroll: boolean;

  /* Notifications */
  /** OS desktop notifications for new messages in unfocused rooms */
  desktopNotifications: boolean;
  /** play a short sound with a desktop notification */
  notificationSound: boolean;
  notificationPreviews: boolean;

  /* Voice & Video — selected media device ids ("" = system default) */
  audioInput: string;
  audioOutput: string;
  videoInput: string;

  /** KLIPY client API key; saved only on this device. */
  klipyApiKey: string;

  /* Labs */
  /** call mode preference: "auto" follows the room's configured service */
  callMode: "auto" | "mesh" | "livekit";
}

export const DEFAULT_SETTINGS: GrungusSettings = {
  theme: "dark",
  backgroundImage: "",
  fontScale: 1,
  compact: false,
  showTimestamps: true,
  sendTypingNotifications: true,
  showTypingIndicator: true,
  sendReadReceipts: true,
  renderMarkdown: true,
  enterToSend: true,
  autoScroll: true,
  desktopNotifications: true,
  notificationSound: true,
  notificationPreviews: true,
  audioInput: "",
  audioOutput: "",
  videoInput: "",
  callMode: "auto",
  klipyApiKey: "",
};

const STORAGE_KEY = "grungus-settings";

function coerce(raw: Partial<GrungusSettings> | null): GrungusSettings {
  const out: GrungusSettings = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof GrungusSettings)[]) {
    const value = raw[key];
    if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
      /* keep numbers sane */
      if (key === "theme") {
        if (["dark", "light", "system"].includes(String(value))) out.theme = value as ThemeName;
      } else if (key === "backgroundImage") {
        out.backgroundImage = isBackgroundImage(value) ? value : "";
      } else if (key === "fontScale") {
        const scale = Number(value);
        out.fontScale = Math.min(1.4, Math.max(0.8, scale));
      } else {
        (out[key] as unknown) = value;
      }
    }
  }
  return out;
}

type Listener = (settings: GrungusSettings) => void;

export class SettingsStore {
  private _settings: GrungusSettings;
  private readonly _listeners = new Set<Listener>();

  constructor() {
    let raw: Partial<GrungusSettings> | null = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      raw = null;
    }
    this._settings = coerce(raw);
  }

  get all(): GrungusSettings {
    return { ...this._settings };
  }

  get<K extends keyof GrungusSettings>(key: K): GrungusSettings[K] {
    return this._settings[key];
  }

  set<K extends keyof GrungusSettings>(key: K, value: GrungusSettings[K]): void {
    let next = value;
    if (key === "backgroundImage" && value !== "" && !isBackgroundImage(value)) throw new Error("Choose a valid background image.");
    if (key === "fontScale") {
      /* the slider is clamped, but keep the store robust anyway */
      next = Math.min(1.4, Math.max(0.8, Number(value))) as GrungusSettings[K];
    }
    if (this._settings[key] === next) return;
    const updated = { ...this._settings, [key]: next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    this._settings = updated;
    for (const listener of this._listeners) listener(this.all);
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

}
