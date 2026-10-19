/** Matrix encrypted attachments v2: verify ciphertext integrity before decryption. */
export interface EncryptedFile {
  url: string;
  v: "v2";
  key: JsonWebKey;
  iv: string;
  hashes: { sha256: string };
}

const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
const decode = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

export async function encryptAttachment(bytes: Uint8Array): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  file: EncryptedFile;
}> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]
  );
  // Matrix uses a random 64-bit prefix and a 64-bit counter starting at zero.
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: iv, length: 64 }, key, new Uint8Array(bytes)
  );
  const hash = await crypto.subtle.digest("SHA-256", ciphertext);
  return {
    bytes: new Uint8Array(ciphertext),
    file: {
      url: "",
      v: "v2",
      key: await crypto.subtle.exportKey("jwk", key),
      iv: encode(iv),
      hashes: { sha256: encode(new Uint8Array(hash)) },
    },
  };
}

export async function decryptAttachment(
  bytes: Uint8Array, file: EncryptedFile
): Promise<Uint8Array<ArrayBuffer>> {
  if (file.v !== "v2" || file.key.kty !== "oct" || file.key.alg !== "A256CTR") {
    throw new Error("Unsupported encrypted attachment");
  }
  const hash = encode(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  ));
  if (hash !== file.hashes.sha256) throw new Error("Attachment integrity check failed");
  const key = await crypto.subtle.importKey("jwk", file.key, "AES-CTR", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: decode(file.iv), length: 64 }, key, new Uint8Array(bytes)
  ));
}
