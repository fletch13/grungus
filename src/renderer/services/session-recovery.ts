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
