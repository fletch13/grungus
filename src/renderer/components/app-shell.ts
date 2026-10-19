/*
 * Grungus — <app-shell>: four-pane layout.
 * [ space rail | room list | chat | member list ]
 */
import { el } from "./ui.ts";

export class AppShell extends HTMLElement {
  connectedCallback(): void {
    this.textContent = "";
    this.setAttribute("aria-label", "Grungus workspace");
    this.appendChild(el("space-rail"));
    this.appendChild(el("room-list"));
    this.appendChild(el("chat-view"));
    this.appendChild(el("member-list"));
    this.addEventListener("grungus:select-room", () => this.classList.remove("show-rooms"));
    this.addEventListener("keydown", event => { if (event.key === "Escape") this.classList.remove("show-rooms"); });
  }

  /** Hide the member pane (e.g. no room selected) — chat takes the space. */
  setMembersVisible(visible: boolean): void {
    this.classList.toggle("no-members", !visible);
  }
}

customElements.define("app-shell", AppShell);

declare global {
  interface HTMLElementTagNameMap {
    "app-shell": AppShell;
  }
}
