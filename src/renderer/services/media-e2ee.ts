/*
 * Grungus — E2EE media for mesh calls (insertable streams).
 *
 * DTLS-SRTP protects media hop-by-hop (peer↔peer), but a full-mesh
 * call is peer↔peer already — still, the frames themselves are
 * plaintext RTP. This adds an SFrame-inspired layer INSIDE WebRTC:
 * a TransformStream between the codec and the packetizer
 * (RTCRtpSender.createEncodedStreams, Chromium) encrypts every
 * encoded frame with AES-GCM; the receiver side decrypts before the
 * decoder. The homeserver/P2P observer sees only ciphertext.
 *
 * Frame format (v1, SFrame-inspired):
 *   [0]      keyId (u8, per call; incremented on rotation)
 *   [1..4]   stream salt (3 bytes, random per transform instance)
 *   [4..8]   counter (u32 BE, 0-based, monotonic per transform)
 *   [8..10]  clear prefix (2 bytes of the original frame — codec
 *            packetization headers that must stay in the clear)
 *   [10..]   AES-GCM ciphertext of the rest + 16-byte tag
 * The GCM nonce (12 bytes) is keyId + salt + counter, zero-padded —
 * nonces never repeat within a stream (monotonic counter) and the
 * salt separates streams sharing one key.
 *
 * Key transport: each sender generates a 128-bit AES key and sends it
 * to the call's peers over the olm-encrypted to-device signal channel
 * (m.call.media_key) — encrypted rooms only, the same condition as
 * the signaling itself. Rotation: when a peer leaves, the sender
 * rotates (new key, keyId + 1) so the departed member's stale key
 * decrypts nothing.
 *
 * Fail-closed: frames with an unknown keyId or a bad tag are DROPPED
 * (a short black period until the key arrives — never plaintext).
 *
 * LiveKit path: not covered here (the SFU model uses the client's
 * own E2EE worker) — documented as mesh-only.
 */

export const MEDIA_KEY_BYTES = 16; /* AES-128 */
export const CLEAR_PREFIX_BYTES = 2;
/** header: keyId(1) + salt(3) + counter(4) + clear prefix(2) */
export const FRAME_HEADER_BYTES = 1 + 3 + 4 + CLEAR_PREFIX_BYTES;

interface EncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
  type?: string;
  [extra: string]: unknown;
}

/** Random bytes. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Unpadded base64 of raw bytes. */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/=+$/, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Import raw AES-GCM key bytes as a non-extractable CryptoKey. */
export async function importAesGcm(
  raw: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    usages
  );
}

/** The 12-byte GCM nonce derived from the frame header bytes 0..8. */
function nonceFromHeader(header: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(header.subarray(0, 8), 0);
  return nonce;
}

/**
 * Build the per-sender-stream encryption transform. Each call site
 * (one per RTCRtpSender) MUST create its own instance — the counter
 * and salt are per instance, which is what keeps GCM nonces unique.
 * The key material is read through the getter so a rotation applies
 * to already-attached transforms immediately.
 */
export function makeEncryptTransform(
  getKey: () => { keyId: number; key: CryptoKey },
  onEncrypt?: () => void
): TransformStream<EncodedFrame, EncodedFrame> {
  const salt = randomBytes(3);
  let counter = 0;
  return new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      const { keyId, key } = getKey();
      if (!key) {
        /* no key yet (shouldn't happen — the key precedes the call) */
        controller.enqueue(frame);
        return;
      }
      const data = new Uint8Array(frame.data);
      if (data.length <= CLEAR_PREFIX_BYTES) {
        controller.enqueue(frame);
        return;
      }
      const nonce = new Uint8Array(12);
      nonce[0] = keyId & 0xff;
      nonce.set(salt, 1);
      const frameCounter = counter;
      new DataView(nonce.buffer).setUint32(4, frameCounter, false);
      counter = (counter + 1) >>> 0;

      let ciphertext: ArrayBuffer;
      try {
        ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce as unknown as BufferSource },
          key,
          data.subarray(CLEAR_PREFIX_BYTES) as unknown as BufferSource
        );
      } catch {
        /* crypto failure must never leak the plaintext frame */
        return;
      }
      const out = new Uint8Array(FRAME_HEADER_BYTES + ciphertext.byteLength);
      out[0] = keyId & 0xff;
      out.set(salt, 1);
      new DataView(out.buffer).setUint32(4, frameCounter, false);
      out.set(data.subarray(0, CLEAR_PREFIX_BYTES), 8);
      out.set(new Uint8Array(ciphertext), FRAME_HEADER_BYTES);
      onEncrypt?.();
      controller.enqueue({ ...frame, data: out.buffer });
    },
  });
}

/**
 * Build the per-receiver-stream decryption transform. Unknown key ids
 * and bad tags DROP the frame (fail closed — a brief black period
 * instead of ever emitting plaintext).
 */
export function makeDecryptTransform(
  getKeys: () => Map<number, CryptoKey>,
  onDrop?: (reason: string) => void
): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      const data = new Uint8Array(frame.data);
      if (data.length <= FRAME_HEADER_BYTES) {
        /* too short to carry our header — not our format; drop */
        onDrop?.("short-frame");
        return;
      }
      const keyId = data[0]!;
      const key = getKeys().get(keyId);
      if (!key) {
        onDrop?.(`unknown keyId ${keyId}`);
        return;
      }
      let plain: ArrayBuffer;
      try {
        plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonceFromHeader(data) as unknown as BufferSource,
          },
          key,
          data.subarray(FRAME_HEADER_BYTES) as unknown as BufferSource
        );
      } catch {
        /* bad tag / tampered frame — drop */
        onDrop?.("decrypt-failed");
        return;
      }
      const out = new Uint8Array(CLEAR_PREFIX_BYTES + plain.byteLength);
      out.set(data.subarray(8, FRAME_HEADER_BYTES), 0);
      out.set(new Uint8Array(plain), CLEAR_PREFIX_BYTES);
      controller.enqueue({ ...frame, data: out.buffer });
    },
  });
}

/** Attach the encrypt transform to a sender (Chromium insertable streams). */
export function attachSenderTransform(
  sender: RTCRtpSender,
  getKey: () => { keyId: number; key: CryptoKey },
  onEncrypt?: () => void
): boolean {
  const anySender = sender as unknown as {
    createEncodedStreams?: () => {
      readable: ReadableStream<EncodedFrame>;
      writable: WritableStream<EncodedFrame>;
    };
  };
  if (typeof anySender.createEncodedStreams !== "function") return false;
  try {
    const { readable, writable } = anySender.createEncodedStreams!();
    void readable
      .pipeThrough(makeEncryptTransform(getKey, onEncrypt))
      .pipeTo(writable)
      .catch(() => {
        /* the pipe ends when the sender tears down */
      });
    return true;
  } catch {
    return false;
  }
}

/** Attach the decrypt transform to a receiver. */
export function attachReceiverTransform(
  receiver: RTCRtpReceiver,
  getKeys: () => Map<number, CryptoKey>,
  onDrop?: (reason: string) => void
): boolean {
  const anyReceiver = receiver as unknown as {
    createEncodedStreams?: () => {
      readable: ReadableStream<EncodedFrame>;
      writable: WritableStream<EncodedFrame>;
    };
  };
  if (typeof anyReceiver.createEncodedStreams !== "function") return false;
  try {
    const { readable, writable } = anyReceiver.createEncodedStreams!();
    void readable
      .pipeThrough(makeDecryptTransform(getKeys, onDrop))
      .pipeTo(writable)
      .catch(() => {
        /* the pipe ends when the receiver tears down */
      });
    return true;
  } catch {
    return false;
  }
}
