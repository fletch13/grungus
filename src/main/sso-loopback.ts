/*
 * Grungus — SSO loopback capture server (pure Node, no Electron imports).
 *
 * The OAuth/SSO redirect dance runs in the HOST SYSTEM BROWSER (passkeys
 * and WebAuthn prompts are OS-native there, and IdPs increasingly block
 * embedded webviews). This module provides the return channel: a
 * temporary HTTP listener on 127.0.0.1 that receives the redirectUrl
 * callback and captures the single-use loginToken (RFC 8252 style).
 *
 * Used by the Electron main process and, with the exact same code, by
 * the Node test suite.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SsoLoopback {
  /** The redirectUrl to embed in the homeserver's SSO redirect endpoint. */
  redirectUrl: string;
  /** Resolves with the loginToken once the callback lands, or null on timeout/abort. */
  waitForToken(timeoutMs?: number): Promise<string | null>;
  /** Shut the listener down (also called automatically after capture). */
  close(): void;
}

const RESPONSE_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Grungus sign-in</title>" +
  "<style>body{background:#1e1f22;color:#dbdee1;font-family:system-ui,sans-serif;" +
  "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}" +
  "div{font-size:18px}</style></head><body><div>Sign-in complete — you can return to Grungus.</div></body></html>";

/**
 * Start a one-shot loopback listener on an ephemeral port. The homeserver
 * will redirect the system browser to `redirectUrl` after the IdP
 * authentication; the token is captured and the listener closes itself.
 */
export function startSsoLoopback(host = "127.0.0.1"): Promise<SsoLoopback> {
  return new Promise((resolve, reject) => {
    let tokenResolve: ((token: string | null) => void) | null = null;
    let capturedToken: string | null = null;
    let closed = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const token = url.searchParams.get("loginToken");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(RESPONSE_HTML);
      if (capturedToken === null && token) {
        capturedToken = token; /* kept for late waitForToken callers */
        tokenResolve?.(token);
        tokenResolve = null;
        setImmediate(() => close());
      }
    });

    server.on("error", (err) => {
      if (!closed) reject(err);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      server.close();
      server.closeAllConnections?.();
      if (capturedToken === null) {
        tokenResolve?.(null);
        tokenResolve = null;
      }
    };

    server.listen(0, host, () => {
      const addr = server.address() as AddressInfo;
      const loopback: SsoLoopback = {
        redirectUrl: `http://${host}:${addr.port}/callback`,
        waitForToken(timeoutMs = 300_000): Promise<string | null> {
          return new Promise((res) => {
            if (capturedToken !== null) {
              /* the callback already landed (e.g. an instant IdP bounce) */
              res(capturedToken);
              return;
            }
            const timer =
              timeoutMs > 0
                ? setTimeout(() => {
                    tokenResolve = null;
                    close();
                    res(null);
                  }, timeoutMs)
                : null;
            tokenResolve = (token) => {
              if (timer) clearTimeout(timer);
              res(token);
            };
          });
        },
        close,
      };
      resolve(loopback);
    });
  });
}
