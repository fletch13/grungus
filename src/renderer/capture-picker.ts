import { el } from "./components/ui.ts";

export interface CapturePickerBridge {
  sources(): Promise<{ sources: Array<{ id: string; name: string; thumbnail: string }>; audioAvailable: boolean }>;
  choose(id: string | null, audio: boolean): Promise<void>;
}

export async function renderCapturePicker(root: HTMLElement, bridge: CapturePickerBridge): Promise<void> {
  root.replaceChildren(el("h1", { text: "Choose what to share" }));
  try {
    const { sources, audioAvailable } = await bridge.sources();
    const grid = el("div", { class: "capture-sources", role: "radiogroup", "aria-label": "Screens and windows" });
    const share = el("button", { text: "Share", disabled: true }) as HTMLButtonElement;
    const audio = el("input", { type: "checkbox", disabled: !audioAvailable }) as HTMLInputElement;
    let selected: string | null = null;
    for (const source of sources) {
      const radio = el("input", { type: "radio", name: "capture-source", value: source.id }) as HTMLInputElement;
      radio.addEventListener("change", () => { selected = source.id; share.disabled = false; });
      grid.appendChild(el("label", { class: "capture-source" }, radio,
        el("img", { src: source.thumbnail, alt: "" }), el("span", { text: source.name })));
    }
    if (sources.length === 0) grid.appendChild(el("p", { text: "No screens or windows are available to share." }));
    const cancel = el("button", { text: "Cancel" });
    cancel.addEventListener("click", () => { void bridge.choose(null, false); });
    share.addEventListener("click", () => {
      share.disabled = true;
      void bridge.choose(selected, audioAvailable && audio.checked);
    });
    root.append(grid, el("label", { class: "capture-audio" }, audio,
      audioAvailable ? "Share system audio" : "System audio is unavailable for this capture"), el("footer", {}, cancel, share));
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); void bridge.choose(null, false); }
    };
    root.addEventListener("keydown", escape);
    (grid.querySelector("input") as HTMLInputElement | null)?.focus();
  } catch {
    root.appendChild(el("p", { text: "Could not list screens and windows. Close this window and try again." }));
  }
}
