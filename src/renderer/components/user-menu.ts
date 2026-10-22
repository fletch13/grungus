import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";

export function userLabel(client: MatrixClient | null, userId: string, fallback: string): string {
  return client?.getUserNickname?.(userId) || fallback;
}

export function bindUserTile(tile: HTMLElement, client: MatrixClient | null, userId: string, name: string): void {
  if (!client || userId === client.userId || !/^@[^:\s]+:[^\s]+$/.test(userId)) return;
  tile.classList.add("user-tile-action"); tile.tabIndex = 0; tile.setAttribute("role", "button"); tile.setAttribute("aria-haspopup", "dialog");
  tile.setAttribute("aria-label", `User settings for ${userLabel(client, userId, name)}`);
  tile.addEventListener("contextmenu", event => {
    const control = (event.target as HTMLElement).closest("button, a, video, audio, input");
    if (control && tile.contains(control)) return;
    event.preventDefault(); event.stopPropagation(); showUserMenu(client, userId, name, tile);
  });
  tile.addEventListener("keydown", event => {
    if (event.target === tile && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) { event.preventDefault(); event.stopPropagation(); showUserMenu(client, userId, name, tile); }
  });
}

let dismissUserMenu: (() => void) | null = null;

export function showUserMenu(client: MatrixClient, userId: string, name: string, anchor?: HTMLElement): void {
  if (userId === client.userId) return;
  dismissUserMenu?.();
  const opener = anchor ?? document.activeElement as HTMLElement | null;
  const anchorRect = opener?.getBoundingClientRect();
  const overlay = el("div", { class: "user-settings-overlay", popover: "manual" });
  const card = el("div", { class: "user-settings-card", role: "dialog", "aria-modal": "false", "aria-label": "User settings" });
  let busy = false;
  const listeners = new AbortController();
  const openedAt = performance.now();
  let pointerEntered = false;
  const dispose = () => {
    listeners.abort();
    if (overlay.matches(":popover-open")) overlay.hidePopover();
    overlay.remove(); if (dismissUserMenu === dispose) dismissUserMenu = null;
  };
  dismissUserMenu = dispose;
  overlay.addEventListener("pointerenter", () => { pointerEntered = true; });
  overlay.addEventListener("pointerleave", () => {
    if (!pointerEntered) return;
    dispose();
  });
  const close = () => { if (!busy) { dispose(); if (opener?.isConnected) opener.focus(); } };
  // Manual popovers avoid the opening right-click's release dismissing the panel.
  // Ignore outside presses for three seconds, giving the pointer time to reach it.
  document.addEventListener("pointerdown", event => {
    if (overlay.contains(event.target as Node) || opener?.contains(event.target as Node)) return;
    if ((pointerEntered || performance.now() - openedAt >= 3000) && !busy) dispose();
  }, { capture: true, signal: listeners.signal });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  }, { capture: true, signal: listeners.signal });
  const nickname = el("input", { type: "text", class: "settings-input", maxlength: "100", "aria-label": "Nickname", value: client.getUserNickname(userId) ?? "", placeholder: name }) as HTMLInputElement;
  const save = el("button", { type: "submit", class: "call-btn", text: "Save nickname" }) as HTMLButtonElement;
  const blocked = () => client.getIgnoredUsers().includes(userId);
  const block = el("button", { type: "button", class: "call-btn danger", text: blocked() ? "Unblock user" : "Block user" }) as HTMLButtonElement;
  const cancel = el("button", { type: "button", class: "call-btn", text: "Close" }) as HTMLButtonElement; cancel.addEventListener("click", close);
  const status = el("p", { class: "settings-hint", role: "status", "aria-live": "polite" });
  const form = el("form", {}, el("label", { class: "room-settings-field" }, el("span", { text: "Nickname (only for you)" }), nickname), el("p", { class: "settings-hint", text: "Leave blank to restore their profile name." }), save);
  const run = (action: () => Promise<void>, success: string) => {
    if (busy) return; busy = true; [save, block, cancel, nickname].forEach(control => { control.disabled = true; }); status.textContent = "Saving…";
    void action().then(() => { status.textContent = success; block.textContent = blocked() ? "Unblock user" : "Block user"; })
      .catch(error => { status.textContent = `Could not save: ${error instanceof Error ? error.message : "unknown error"}`; })
      .finally(() => { busy = false; [save, block, cancel, nickname].forEach(control => { control.disabled = false; }); });
  };
  form.addEventListener("submit", event => { event.preventDefault(); run(() => client.setUserNickname(userId, nickname.value), "Nickname saved."); });
  block.addEventListener("click", () => { const wasBlocked = blocked(); run(() => wasBlocked ? client.unignoreUser(userId) : client.ignoreUser(userId), wasBlocked ? "User unblocked." : "User blocked. Their messages are hidden."); });
  card.append(el("h2", { text: name }), el("p", { class: "user-settings-id", text: userId }), form,
    el("p", { class: "settings-hint", text: "Blocking hides messages and notifications. Shared rooms and calls remain shared." }), block, status, cancel);
  overlay.append(card); document.body.append(overlay); overlay.showPopover();
  const bounds = overlay.getBoundingClientRect();
  const rect = anchorRect ?? { left: 8, right: 8, top: 8 };
  const right = rect.right + 8;
  const left = right + bounds.width <= innerWidth - 8 ? right : rect.left - bounds.width - 8;
  overlay.style.left = `${Math.max(8, Math.min(left, innerWidth - bounds.width - 8))}px`;
  overlay.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - bounds.height - 8))}px`;
  nickname.focus();
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const controls = [...overlay.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)")];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
    }
  });
}
