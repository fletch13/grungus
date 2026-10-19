import { MatrixClient } from "./matrix-client.ts";

/** Check the password with the server using a temporary session, never replacing the active token. */
export async function resetSessionBackup(client: MatrixClient, password: string): Promise<void> {
  if (!client.crypto || !client.userId || !password) throw new Error("Enter your account password.");
  const confirmation = new MatrixClient({ baseUrl: client.baseUrl });
  try {
    await confirmation.loginWithPassword({ username: client.userId, password });
    if (confirmation.userId !== client.userId) throw new Error("Password confirmation returned a different account.");
    await client.crypto.deleteCurrentKeyBackup();
  } finally {
    if (confirmation.accessToken) await confirmation.logout();
  }
}

/** Recover the account identity as well as message history; never create a replacement identity. */
export async function recoverSession(client: MatrixClient, recovery: string): Promise<{ verified: boolean; restored: number | null; backupError?: string }> {
  if (!client.crypto) throw new Error("Encryption is unavailable");
  const { CrossSigning } = await import("./cross-signing.ts");
  const signing = new CrossSigning(client.crypto, client);
  const verified = await signing.recoverWithRecovery(recovery);
  if (verified) {
    client.crypto.retryRoomKeyRequests();
    for (const room of client.rooms.values()) client.retryUndecrypted(room.id);
  }
  try {
    const restored = await client.crypto.restoreWithRecovery(recovery);
    return { verified, restored };
  } catch (error) {
    if (!verified) throw error;
    return { verified, restored: null, backupError: error instanceof Error ? error.message : "Could not restore history" };
  }
}
