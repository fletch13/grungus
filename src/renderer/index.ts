/* Keep the entry small so the static loading screen can paint immediately. */
import { startupScreen } from "./services/startup-screen.ts";
void import("./bootstrap.ts").catch(error => {
  console.error("[grungus] application bundle failed to load:", error);
  startupScreen.fail();
});
