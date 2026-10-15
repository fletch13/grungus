/*
 * Grungus — shared UI helpers and the <g-avatar> element.
 * Tiny DOM builder, name colors, date formatting — no framework.
 */

export interface ElAttrs {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Create an element, set attributes, append children.
 * Children may be strings (text nodes), nodes, arrays, or null/undefined.
 * Boolean attributes: `true` sets a bare attribute, `false` is skipped —
 * `setAttribute("disabled", "false")` would still disable the control.
 */
export function el(
  tag: string,
  attrs?: ElAttrs | null,
  ...children: unknown[]
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (value === true) {
        node.setAttribute(key, "");
        continue;
      }
      if (key === "text") {
        node.textContent = String(value);
      } else if (key === "class") {
        node.className = String(value);
      } else if (key === "dataset" && typeof value === "object") {
        for (const [dataKey, dataValue] of Object.entries(
          value as Record<string, string>
        )) {
          node.dataset[dataKey] = String(dataValue);
        }
      } else if (key.slice(0, 2) === "on" && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) appendChild(node, child);
  return node;
}

function appendChild(node: HTMLElement, child: unknown): void {
  if (child === null || child === undefined) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(node, c);
    return;
  }
  if (typeof child === "string") {
    node.appendChild(document.createTextNode(child));
  } else if (child instanceof Node) {
    node.appendChild(child);
  }
}

/** Deterministic hue from a string — Discord-style per-user colors. */
export function colorFor(seed: string | null | undefined): string {
  const str = String(seed || "?");
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 58%, 48%)`;
}

/** Up to two uppercase initials ("grungus HQ" -> "GH"). */
export function initials(name: string | null | undefined): string {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export interface GAvatarOptions {
  name?: string | null;
  userId?: string | null;
  url?: string | null;
  /** Promise of a URL (async media fetch); re-renders when it resolves. */
  load?: Promise<string | null> | null;
  size?: number;
  square?: boolean;
}

/**
 * <g-avatar> — avatar bubble with initial-letter fallback.
 * `load` may be a Promise of a URL; when it resolves the avatar re-renders
 * with the image, unless a newer update superseded it.
 */
export class GAvatar extends HTMLElement {
  private _opts: GAvatarOptions = {};
  private _token = 0;

  connectedCallback(): void {
    this._render();
  }

  update(opts: GAvatarOptions): void {
    this._opts = opts;
    this._token += 1;
    const myToken = this._token;
    this._render();
    const load = opts.load;
    if (load && typeof load.then === "function") {
      void load.then((url) => {
        if (this._token === myToken && url) {
          this._opts = { ...this._opts, url };
          this._render();
        }
      });
    }
  }

  private _render(): void {
    const o = this._opts;
    const size = o.size ?? 32;
    this.textContent = "";
    this.classList.toggle("squared", o.square === true);

    const av = el("span", { class: "av" });
    av.style.width = `${size}px`;
    av.style.height = `${size}px`;
    av.style.background = colorFor(o.userId || o.name || "?");
    av.style.fontSize = `${Math.max(10, Math.round(size * 0.4))}px`;
    av.textContent = initials(o.name);

    if (o.url) {
      const img = el("img", { src: o.url, alt: "" });
      img.addEventListener("error", () => img.remove());
      av.textContent = "";
      av.appendChild(img);
    }

    this.appendChild(av);
  }
}

customElements.define("g-avatar", GAvatar);

declare global {
  interface HTMLElementTagNameMap {
    "g-avatar": GAvatar;
  }
}
