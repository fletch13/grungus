/** Static HTML is visible before the main application bundle is ready. */
export class StartupScreen {
  private screen: HTMLElement | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  constructor(screen: HTMLElement | null) { this.screen = screen; }
  show(message: string, allowContinue = false): void {
    const screen = this.screen; if (!screen) return;
    this.generation++;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    screen.hidden = false;
    document.getElementById("root")?.setAttribute("inert", "");
    const status = screen.querySelector<HTMLElement>("[data-startup-status]"); if (status) status.textContent = message;
    const action = screen.querySelector<HTMLButtonElement>("button");
    if (action) { action.hidden = true; action.onclick = null; }
    screen.classList.remove("startup-error");
    if (allowContinue && action) this.timer = setTimeout(() => {
      this.timer = null; action.hidden = false; action.textContent = "Open app while connecting";
      if (status) status.textContent = "Still connecting to your homeserver. You can open the app while it retries.";
      action.onclick = () => this.finish();
    }, 12000);
  }
  finish(): void {
    const generation = ++this.generation;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    // Allow the destination view to lay out before revealing it.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== this.generation || !this.screen) return;
      this.screen.hidden = true; document.getElementById("root")?.removeAttribute("inert");
    }));
  }
  fail(): void {
    this.show("Grungus could not finish starting. Please try again.");
    this.screen?.classList.add("startup-error");
    const action = this.screen?.querySelector<HTMLButtonElement>("button");
    if (action) { action.hidden = false; action.textContent = "Try again"; action.onclick = () => location.reload(); }
  }
}
export const startupScreen = new StartupScreen(document.getElementById("startup-screen"));
