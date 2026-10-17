/*
 * Grungus — <verify-view>: device verification overlay.
 * One card per active transaction. Emoji cards (SAS) show the 7-emoji
 * comparison; QR cards (MSC3906) render a scannable code or a scanner
 * (camera + image upload) with a confirm prompt on the shower side.
 * Incoming requests always PROMPT — nothing is auto-accepted.
 */
import { el } from "./ui.ts";
import type { SasUiState, VerificationManager } from "../services/sas.ts";
import type { QrUiState } from "../services/qr-verify.ts";
import { mxidLocalpart } from "../services/matrix-client.ts";
import QRCode from "qrcode";
import jsQR from "jsqr";

type AnyUiState = SasUiState | QrUiState;

function isQrState(state: AnyUiState): state is QrUiState {
  return "qrBytes" in state;
}

/** Decode an image file/blob into QR payload bytes (null if none found). */
export async function decodeQrImage(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  const result = jsQR(data.data, width, height);
  if (!result || !result.data) return null;
  const bytes = new Uint8Array(result.data.length);
  for (let i = 0; i < result.data.length; i++) {
    bytes[i] = result.data.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export class VerifyView extends HTMLElement {
  private _states: AnyUiState[] = [];
  private _manager: VerificationManager | null = null;
  private _sessionMode = false;
  private _sessionRequested = false;
  /** transaction ids the user accepted (method choice pending). */
  private _accepted = new Set<string>();
  private _scanStream: MediaStream | null = null;
  private _scanRAF = 0;

  update(states: AnyUiState[], manager: VerificationManager): void {
    this._states = states;
    this._manager = manager;
    this._render();
  }

  /** Show the "verify this session" entry card (footer 🛡). */
  setSessionMode(on: boolean): void {
    this._sessionMode = on;
    this._render();
  }

  markSessionRequested(): void {
    this._sessionRequested = true;
    this._render();
  }

  disconnectedCallback(): void {
    this._stopScan();
  }

  private _stopScan(): void {
    if (this._scanRAF) cancelAnimationFrame(this._scanRAF);
    this._scanRAF = 0;
    this._scanStream?.getTracks().forEach((t) => t.stop());
    this._scanStream = null;
  }

  private _dispatch(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent(name, { detail: detail ?? {}, bubbles: true })
    );
  }

  private _render(): void {
    const manager = this._manager;
    this.textContent = "";
    const hasCards = this._states.length > 0 || (this._sessionMode && !this._sessionRequested);
    if (!manager || !hasCards) return;

    /* stop any camera preview from a previous render */
    this._stopScan();

    this.classList.add("call-overlay");

    const header = el("div", { class: "call-header" });
    header.appendChild(el("span", { class: "call-title", text: "Verify devices" }));
    header.appendChild(
      el("span", {
        class: "call-notice",
        text: "Compare emoji or scan a QR code",
      })
    );
    this.appendChild(header);

    /* session-verification entry card (opened from the sidebar) */
    if (this._sessionMode && !this._sessionRequested) {
      const card = el("div", { class: "verify-card" });
      card.appendChild(el("div", { class: "verify-peer", text: "This device" }));
      const setup = el("button", { class: "call-btn", text: "Verify my other devices" });
      setup.addEventListener("click", () => {
        this._dispatch("grungus:request-session-verify");
      });
      const csSetup = el("button", {
        class: "call-btn",
        text: "Set up cross-signing",
        title: "Create the master/self-signing/user-signing keys for this account",
      });
      csSetup.addEventListener("click", () => {
        this._renderBootstrapCard();
      });
      const buttons = el("div", { class: "call-footer" });
      buttons.appendChild(setup);
      buttons.appendChild(csSetup);
      card.appendChild(buttons);
      this.appendChild(card);
    }

    for (const state of this._states) {
      if (isQrState(state)) {
        this._renderQrCard(state);
      } else {
        this._renderSasCard(state);
      }
    }
  }

  /* ------------------------------- SAS --------------------------------- */

  /** The cross-signing bootstrap card (password prompt for homeserver UIA). */
  private _renderBootstrapCard(): void {
    this.textContent = "";
    this.classList.add("call-overlay");
    const card = el("div", { class: "verify-card" });
    card.appendChild(el("div", { class: "verify-peer", text: "Set up cross-signing" }));
    card.appendChild(
      el("div", {
        class: "verify-phase",
        text: "Creates this account's master, self-signing and user-signing keys. Devices you verify are then trusted by every device that trusts your master key.",
      })
    );
    const pwLabel = el("div", {
      class: "verify-phase",
      text: "Your homeserver requires your account password to publish the keys (used once, never stored):",
    });
    const pw = document.createElement("input");
    pw.type = "password";
    pw.placeholder = "account password";
    pw.className = "cs-password-input";
    const rpLabel = el("div", {
      class: "verify-phase",
      text: "Choose a recovery passphrase — it encrypts the private keys in secret storage so any device can recover them (never stored, not sent anywhere):",
    });
    const rp = document.createElement("input");
    rp.type = "password";
    rp.placeholder = "recovery passphrase (optional but recommended)";
    rp.className = "cs-recovery-input";
    const status = el("div", { class: "verify-phase" });
    const go = el("button", { class: "call-btn", text: "Create keys" }) as HTMLButtonElement;
    go.addEventListener("click", () => {
      go.disabled = true;
      status.textContent = "Publishing cross-signing keys…";
      this._dispatch("grungus:bootstrap-crosssigning", {
        password: pw.value,
        recoveryPassphrase: rp.value,
      });
    });
    const cancel = el("button", { class: "call-btn danger", text: "Cancel" });
    cancel.addEventListener("click", () => {
      this._render();
    });
    const buttons = el("div", { class: "call-footer" });
    buttons.appendChild(go);
    buttons.appendChild(cancel);
    card.appendChild(pwLabel);
    card.appendChild(pw);
    card.appendChild(rpLabel);
    card.appendChild(rp);
    card.appendChild(buttons);
    card.appendChild(status);
    this.appendChild(card);
  }

  /** Report the bootstrap result (called by app.ts wiring). */
  setBootstrapResult(result: { ok: boolean; message: string }): void {
    const status = this.querySelector(".verify-card .verify-phase:last-child");
    if (status) status.textContent = result.message;
    if (result.ok) {
      setTimeout(() => {
        this._sessionRequested = false;
        this._render();
      }, 1800);
    }
  }

  private _renderSasCard(state: SasUiState): void {
    const card = el("div", { class: "verify-card" });
    const peer = `${mxidLocalpart(state.peerUserId)} (${state.peerDeviceId.slice(0, 10)}…)`;
    card.appendChild(el("div", { class: "verify-peer", text: peer }));
    card.appendChild(
      el("div", { class: "verify-phase", text: this._sasPhaseText(state.phase, state.error) })
    );

    /* an incoming request waits for THIS user to accept — never
       auto-accept silently; the human decides */
    if (state.phase === "requested" && !state.initiatedByMe) {
      if (!this._accepted.has(state.transactionId)) {
        card.appendChild(
          el("div", { class: "verify-phase", text: "wants to be verified" })
        );
        const buttons = el("div", { class: "call-footer" });
        const accept = el("button", { class: "call-btn", text: "Verify" });
        accept.addEventListener("click", () => {
          this._accepted.add(state.transactionId);
          this._render();
        });
        const ignore = el("button", { class: "call-btn danger", text: "Ignore" });
        ignore.addEventListener("click", () => {
          this._dispatch("grungus:decline-verify", {
            transactionId: state.transactionId,
          });
        });
        buttons.appendChild(accept);
        buttons.appendChild(ignore);
        card.appendChild(buttons);
        this.appendChild(card);
        return;
      }
      /* accepted — offer the verification methods */
      this._appendMethodButtons(card, state.transactionId);
      this.appendChild(card);
      return;
    }

    /* the initiator can offer QR while waiting for the responder */
    if (state.phase === "requested" && state.initiatedByMe) {
      this._appendMethodButtons(card, state.transactionId);
      this.appendChild(card);
      return;
    }

    if (state.emoji.length > 0 && state.phase === "show-emoji") {
      card.appendChild(el("div", { class: "verify-emoji", text: state.emoji.join(" ") }));
      const buttons = el("div", { class: "call-footer" });
      const match = el("button", { class: "call-btn", text: "They match" });
      match.addEventListener("click", () => {
        this._dispatch("grungus:confirm-sas", { transactionId: state.transactionId });
      });
      const reject = el("button", { class: "call-btn danger", text: "They don't match" });
      reject.addEventListener("click", () => {
        this._dispatch("grungus:decline-verify", { transactionId: state.transactionId });
      });
      buttons.appendChild(match);
      buttons.appendChild(reject);
      card.appendChild(buttons);
    }

    this.appendChild(card);
  }

  /** [Show QR] [Scan QR] [Compare emoji] for a still-requested transaction. */
  private _appendMethodButtons(card: HTMLElement, transactionId: string): void {
    card.appendChild(
      el("div", { class: "verify-phase", text: "Choose how to verify:" })
    );
    const buttons = el("div", { class: "call-footer" });
    const show = el("button", { class: "call-btn", text: "Show QR code" });
    show.addEventListener("click", () => {
      this._dispatch("grungus:show-qr", { transactionId });
    });
    const scan = el("button", { class: "call-btn", text: "Scan QR code" });
    scan.addEventListener("click", () => {
      this._dispatch("grungus:scan-qr", { transactionId });
    });
    const emoji = el("button", { class: "call-btn", text: "Compare emoji" });
    emoji.addEventListener("click", () => {
      this._dispatch("grungus:accept-verify", { transactionId });
    });
    buttons.appendChild(show);
    buttons.appendChild(scan);
    buttons.appendChild(emoji);
    card.appendChild(buttons);
  }

  private _sasPhaseText(phase: SasUiState["phase"], error: string | null): string {
    if (error) return error;
    switch (phase) {
      case "requested":
        return "Waiting for the other device…";
      case "started":
        return "Exchanging keys…";
      case "keys-exchanged":
      case "show-emoji":
        return "Compare the emoji:";
      case "mac-sent":
        return "Waiting for their confirmation…";
      case "verified":
        return "✅ Device verified";
      case "cancelled":
        return "Cancelled";
      default:
        return phase;
    }
  }

  /* ------------------------------- QR ---------------------------------- */

  private _renderQrCard(state: QrUiState): void {
    const card = el("div", { class: "verify-card" });
    const peer = `${mxidLocalpart(state.peerUserId)} (${state.peerDeviceId.slice(0, 10)}…)`;
    card.appendChild(el("div", { class: "verify-peer", text: peer }));

    if (state.error) {
      card.appendChild(el("div", { class: "verify-phase", text: `❌ ${state.error}` }));
      this.appendChild(card);
      return;
    }

    switch (state.phase) {
      case "show-qr": {
        card.appendChild(
          el("div", { class: "verify-phase", text: "Let them scan this code:" })
        );
        if (state.qrBytes) card.appendChild(this._renderQrCanvas(state.qrBytes));
        card.appendChild(
          el("div", { class: "verify-phase", text: "Waiting for the scan…" })
        );
        break;
      }
      case "scan-qr": {
        card.appendChild(
          el("div", { class: "verify-phase", text: "Scan the code shown on the other device:" })
        );
        card.appendChild(this._renderScanner(state.transactionId));
        break;
      }
      case "confirm-scan": {
        card.appendChild(
          el("div", {
            class: "verify-phase",
            text: "✅ The other device scanned your code.",
          })
        );
        card.appendChild(
          el("div", {
            class: "verify-phase",
            text: "Confirm BOTH devices show a green verification result.",
          })
        );
        const buttons = el("div", { class: "call-footer" });
        const ok = el("button", { class: "call-btn", text: "They scanned it ✓" });
        ok.addEventListener("click", () => {
          this._dispatch("grungus:confirm-scan", { transactionId: state.transactionId });
        });
        const no = el("button", { class: "call-btn danger", text: "Cancel" });
        no.addEventListener("click", () => {
          this._dispatch("grungus:decline-verify", { transactionId: state.transactionId });
        });
        buttons.appendChild(ok);
        buttons.appendChild(no);
        card.appendChild(buttons);
        break;
      }
      case "wait-confirm": {
        card.appendChild(
          el("div", { class: "verify-phase", text: "Scanned ✓ Waiting for them to confirm…" })
        );
        break;
      }
      case "verified": {
        card.appendChild(el("div", { class: "verify-phase", text: "✅ Device verified" }));
        break;
      }
      default:
        card.appendChild(
          el("div", { class: "verify-phase", text: state.phase })
        );
    }
    this.appendChild(card);
  }

  /** Render QR payload bytes onto a canvas via the qrcode module matrix. */
  private _renderQrCanvas(bytes: Uint8Array): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    let latin1 = "";
    for (const b of bytes) latin1 += String.fromCharCode(b);
    const qr = QRCode.create(latin1, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const scale = 6;
    const margin = 4;
    const dim = (size + margin * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    canvas.className = "verify-qr-canvas";
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = "#000000";
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (qr.modules.get(x, y)) {
            ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
          }
        }
      }
    }
    return canvas;
  }

  /** Camera preview + image-file upload, decoding with jsQR. */
  private _renderScanner(transactionId: string): HTMLElement {
    const wrap = el("div", { class: "verify-scanner" });
    const video = document.createElement("video");
    video.className = "verify-scan-video";
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    wrap.appendChild(video);

    /* upload fallback (works everywhere, incl. headless hosts) */
    const fileLabel = el("label", { class: "call-btn", text: "Upload QR image" });
    fileLabel.style.display = "inline-block";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void (async () => {
        const url = URL.createObjectURL(file);
        try {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("image decode failed"));
            img.src = url;
          });
          const bytes = await decodeQrImage(img, img.naturalWidth, img.naturalHeight);
          if (bytes) {
            this._dispatch("grungus:qr-scanned", { transactionId, bytes });
          } else {
            this._dispatch("grungus:qr-scan-error", { error: "no QR code found in the image" });
          }
        } finally {
          URL.revokeObjectURL(url);
        }
      })();
    });
    wrap.appendChild(fileLabel);
    wrap.appendChild(fileInput);

    /* camera scan loop */
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        this._scanStream = stream;
        video.srcObject = stream;
        const tick = (): void => {
          if (!this.isConnected || !this._scanStream) return;
          if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
            void decodeQrImage(
              video,
              video.videoWidth,
              video.videoHeight
            ).then((bytes) => {
              if (bytes) {
                this._stopScan();
                this._dispatch("grungus:qr-scanned", { transactionId, bytes });
              }
            });
          }
          this._scanRAF = requestAnimationFrame(tick);
        };
        this._scanRAF = requestAnimationFrame(tick);
      } catch {
        /* no camera (headless / denied) — the upload path still works */
        video.remove();
      }
    })();

    return wrap;
  }
}

customElements.define("verify-view", VerifyView);

declare global {
  interface HTMLElementTagNameMap {
    "verify-view": VerifyView;
  }
}
