export interface RoomPowerLevels {
  users?: Record<string, number>;
  users_default?: number;
  events?: Record<string, number>;
  state_default?: number;
  invite?: number;
}
export function canChangeState(power: RoomPowerLevels, userId: string, creator: string | null, type: string): boolean {
  const level = power.users?.[userId] ?? power.users_default ?? (creator === userId && !Object.keys(power).length ? 100 : 0);
  return level >= (power.events?.[type] ?? power.state_default ?? 50);
}
