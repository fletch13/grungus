/*
 * Grungus — <app-shell>: four-pane layout.
 * [ space rail | room list | chat | member list ]
 */
"use strict";

class AppShell extends HTMLElement {
  connectedCallback() {
    this.textContent = "";
    this.appendChild(el("space-rail"));
    this.appendChild(el("room-list"));
    this.appendChild(el("chat-view"));
    this.appendChild(el("member-list"));
  }

  /** Hide the member pane (e.g. no room selected) — chat takes the space. */
  setMembersVisible(visible) {
    this.classList.toggle("no-members", !visible);
  }
}

customElements.define("app-shell", AppShell);
