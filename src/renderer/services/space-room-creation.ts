import type { MatrixClient, Room, CreateRoomOptions } from "./matrix-client.ts";
import { canChangeState } from "./room-permissions.ts";
export class SpaceRoomLinkError extends Error {
  roomId: string;
  constructor(roomId: string, message: string) { super(message); this.roomId = roomId; }
}
/** Keep a successfully created room when linking fails, so retry never creates a duplicate. */
export async function createSpaceRoom(client: MatrixClient, space: Room, options: CreateRoomOptions, existingRoomId?: string): Promise<string> {
  if (!space.isSpace) throw new Error("Select a space to create a room in");
  const authorize = async () => {
    const power = await client.getRoomPowerLevels(space.id);
    if (!canChangeState(power, client.userId ?? "", space.creator, "m.space.child")) throw new Error("You do not have permission to add rooms to this space");
  };
  const parsedInvites = options.invite ?? [];
  if (parsedInvites.some(id => !/^@[^:\s]+:[^\s]+$/.test(id))) throw new Error("Use full Matrix IDs for invitations, such as @friend:example.org");
  let roomId = existingRoomId;
  try {
    await authorize();
    if (!roomId) {
      if (!options.name?.trim()) throw new Error("Enter a room name");
      roomId = await client.createRoom({ ...options, name: options.name.trim(), isSpace: false, parentSpaceId: space.id });
    }
    await authorize();
    await client.addToSpace(space.id, roomId);
    space.children.add(roomId);
    return roomId;
  } catch (error) {
    if (roomId) throw new SpaceRoomLinkError(roomId, error instanceof Error ? error.message : "Could not link room to space");
    throw error;
  }
}
