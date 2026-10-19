/** Call-room types used by Matrix/Element; ordinary rooms may still host ad-hoc calls. */
export function isVideoRoom(room: { roomType?: string | null; room_type?: string } | null | undefined): boolean {
  const type = room?.roomType ?? room?.room_type;
  return type === "org.matrix.msc3417.call" || type === "io.element.video";
}
