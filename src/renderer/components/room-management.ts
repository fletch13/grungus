import { el } from "./ui.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";
import type { RoomPowerLevels } from "../services/room-permissions.ts";
import { canChangeState, userPowerLevel } from "../services/room-permissions.ts";
import type { NotificationMode } from "../services/room-features.ts";
export function roomManagement(card: HTMLElement, room: Room, client: MatrixClient, power: RoomPowerLevels): void {
  if (!client.features) return;
  const notifications = el("select", { class: "settings-input", "aria-label": "Room notification mode" }) as HTMLSelectElement;
  for (const [value, label] of [["inherit", room.isSpace ? "Use global settings" : "Inherit space / global settings"], ["all", "All messages"], ["mentions", "Mentions only"], ["mute", "Mute"]]) notifications.append(el("option", { value, text: label }));
  notifications.value = client.features.notificationMode(room.id);
  const saveNotifications = el("button", { type: "button", class: "call-btn", text: "Save notifications" }) as HTMLButtonElement;
  const status = el("p", { class: "settings-hint", role: "status" });
  const run = (button: HTMLButtonElement, action: () => Promise<void>, message: string) => {
    button.disabled = true; status.textContent = "Saving…";
    void action().then(() => { status.textContent = message; }).catch(error => { status.textContent = error.message; }).finally(() => { button.disabled = false; });
  };
  saveNotifications.addEventListener("click", () => run(saveNotifications, () => client.features.setNotificationMode(room.id, notifications.value as NotificationMode), "Notification preference saved."));
  card.append(el("h3", { text: "Notifications" }), notifications, saveNotifications, el("p", { class: "settings-hint", text: "Applies to Grungus desktop alerts and syncs with your Matrix account. Individual room settings override inherited space preferences. Global notifications must also be enabled." }), status);
  const own = userPowerLevel(power, client.userId ?? "", room.creator);
  const canRoles = canChangeState(power, client.userId ?? "", room.creator, "m.room.power_levels");
  if (!canRoles && own < Math.min(power.kick ?? 50, power.ban ?? 50)) return;
  const section = el("section", { class: "room-management" });
  section.append(el("h3", { text: "Members, roles and moderation" }), el("p", { class: "settings-hint", text: "Matrix power levels apply to this room or space only. Member = 0, moderator = 50, administrator = 100. Assigning roles in a space does not change child-room permissions." }));
  const member = el("input", { class: "settings-input", placeholder: "@member:homeserver", "aria-label": "Manage member ID", list: "management-member-ids" }) as HTMLInputElement;
  const suggestions = el("datalist", { id: "management-member-ids" });
  for (const person of room.members.values()) if (person.userId !== client.userId) suggestions.append(el("option", { value: person.userId, text: `${person.displayname || person.userId} · level ${power.users?.[person.userId] ?? power.users_default ?? 0}` }));
  const role = el("select", { class: "settings-input", "aria-label": "Member role" }) as HTMLSelectElement;
  for (const [value, text] of [["0", "Member"], ["50", "Moderator"], ["100", "Administrator"]]) role.append(el("option", { value, text }));
  const assign = el("button", { type: "button", class: "call-btn", text: "Assign role", disabled: !canRoles }) as HTMLButtonElement;
  assign.addEventListener("click", () => run(assign, () => client.features.setMemberLevel(room, member.value.trim(), Number(role.value)), "Role saved. Waiting for sync."));
  const reason = el("input", { class: "settings-input", "aria-label": "Moderation reason", placeholder: "Reason (optional)", maxlength: "500" }) as HTMLInputElement;
  section.append(member, suggestions, role, assign, reason);
  for (const action of ["kick", "ban", "unban"] as const) {
    const label = action === "kick" ? "Kick member" : action === "ban" ? "Ban member" : "Unban member";
    const button = el("button", { type: "button", class: "call-btn danger", text: label, disabled: own < (power[action === "kick" ? "kick" : "ban"] ?? 50) }) as HTMLButtonElement;
    let armedUser = "";
    button.addEventListener("click", () => {
      const target = member.value.trim();
      if (!/^@[^:\s]+:[^\s]+$/.test(target)) { status.textContent = "Enter a full Matrix user ID."; return; }
      if (armedUser !== target || button.textContent !== `Confirm ${action}`) { armedUser = target; button.textContent = `Confirm ${action}`; return; }
      run(button, () => client.features.moderate(room, target, action, reason.value), `${label} completed.`); button.textContent = label; armedUser = "";
    }); section.append(button);
  }
  if (canRoles) {
    const details = el("details", {}, el("summary", { text: "Advanced permission thresholds" }));
    const fields: Record<string, HTMLInputElement> = {};
    for (const [key, label, fallback] of [["events_default", "Send messages", 0], ["state_default", "Change room settings", 50], ["invite", "Invite members", 0], ["kick", "Kick members", 50], ["ban", "Ban members", 50], ["redact", "Remove others’ messages", 50]] as const) {
      const input = el("input", { type: "number", min: "0", max: String(own), class: "settings-input", "aria-label": label, value: String(power[key] ?? fallback) }) as HTMLInputElement;
      fields[key] = input; details.append(el("label", { class: "room-settings-field" }, label, input));
    }
    const save = el("button", { type: "button", class: "call-btn", text: "Save permission thresholds" }) as HTMLButtonElement;
    save.addEventListener("click", () => run(save, () => client.features.setThresholds(room, Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, Number(input.value)]))), "Permission thresholds saved.")); details.append(save); section.append(details);
  }
  card.append(section);
}
