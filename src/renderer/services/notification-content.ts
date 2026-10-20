/** Hide all conversation metadata when desktop previews are disabled. */
export function notificationContent(previews: boolean, room: string, sender: string, message: string): { title: string; body: string } {
  return previews ? { title: `${room} — ${sender}`, body: message.slice(0, 120) } : { title: "Grungus", body: "You have a new message." };
}
