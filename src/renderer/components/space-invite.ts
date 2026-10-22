import { el } from "./ui.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";

export function showSpaceInvite(space: Room, client: MatrixClient): void {
  const opener = document.activeElement as HTMLElement | null;
  const overlay = el("div", { class: "room-creation-overlay" });
  const card = el("div", { class: "settings-frame room-creation-card", role: "dialog", "aria-modal": "true", "aria-label": "Invite to space" });
  let busy = false;
  const close = () => { if (!busy) { overlay.remove(); opener?.focus(); } };
  const cancel = el("button", { type: "button", class: "call-btn", text: "Close" }); cancel.addEventListener("click", close);
  const input = el("input", { type: "text", class: "settings-input", required: true, placeholder: "@friend:example.org", "aria-label": "Invite Matrix user" }) as HTMLInputElement;
  const submit = el("button", { type: "submit", class: "call-btn", text: "Send invitation", disabled: true }) as HTMLButtonElement;
  const status = el("p", { class: "settings-hint", role: "status", "aria-live": "polite", text: "Checking invitation permissions…" });
  const form = el("form", {}, input, submit);
  card.append(el("h2", { text: `Invite to ${space.title}` }), el("p", { text: "Invite someone using their full Matrix ID. Joining the space does not automatically join its rooms." }), form, status, cancel);
  overlay.append(card); document.body.append(overlay); input.focus();
  const authorized = async () => {
    const power = await client.getRoomPowerLevels(space.id);
    const level = power.users?.[client.userId ?? ""] ?? power.users_default ?? (space.creator === client.userId && Object.keys(power).length === 0 ? 100 : 0);
    if (level < (power.invite ?? 0)) throw new Error("You do not have permission to invite people to this space.");
  };
  void authorized().then(() => { if (overlay.isConnected) { submit.disabled = false; status.textContent = ""; } }).catch(error => { status.textContent = error.message; });
  form.addEventListener("submit", event => {
    event.preventDefault(); if (busy || submit.disabled) return;
    const id = input.value.trim();
    if (!/^@[^:\s]+:[^\s]+$/.test(id)) { status.textContent = "Enter a full Matrix ID, such as @friend:example.org."; return; }
    if (id === client.userId) { status.textContent = "You already belong to this space."; return; }
    busy = true; submit.disabled = true; input.disabled = true; status.textContent = "Sending invitation…";
    void (async () => { await authorized(); await client.invite(space.id, id); status.textContent = `Invitation sent to ${id}.`; input.value = ""; })()
      .catch(error => { status.textContent = `Could not invite: ${error instanceof Error ? error.message : "unknown error"}`; })
      .finally(() => { busy = false; submit.disabled = false; input.disabled = false; });
  });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const controls = [...overlay.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)")];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
    }
  });
}
