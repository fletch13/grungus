import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface VaultEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Write in the same directory so rename is atomic; fsync before replacing the destination. */
export function atomicWrite(file: string, value: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export class CryptoVault {
  private file: string;
  private encryption: VaultEncryption;
  constructor(file: string, encryption: VaultEncryption) {
    this.file = file;
    this.encryption = encryption;
  }

  read(): Record<string, string> {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(`${this.file}.bak`)) return Object.create(null) as Record<string, string>;
      throw new Error("Crypto vault is unavailable; existing keys have been preserved", { cause: error });
    }
    try {
      const stored = JSON.parse(raw);
      if (stored.v !== 1 || typeof stored.encrypted !== "boolean" || typeof stored.data !== "string") throw new Error("Invalid vault envelope");
      const map: unknown = JSON.parse(stored.encrypted ? this.encryption.decryptString(Buffer.from(stored.data, "base64")) : stored.data);
      if (!map || Array.isArray(map) || typeof map !== "object" || Object.values(map).some(value => typeof value !== "string")) throw new Error("Invalid vault contents");
      return Object.assign(Object.create(null), map) as Record<string, string>;
    } catch (error) {
      throw new Error("Crypto vault cannot be read; unlock the keychain or restore the vault backup. Existing keys have been preserved", { cause: error });
    }
  }

  put(key: string, value: string): void {
    const map = this.read(); // Never replace an unreadable vault with an empty one.
    map[key] = value;
    const payload = JSON.stringify(map);
    const encrypted = this.encryption.isEncryptionAvailable();
    // Never downgrade a previously encrypted vault when the keychain becomes unavailable.
    const previous = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : null;
    if (previous && JSON.parse(previous).encrypted && !encrypted) throw new Error("Keychain unavailable; refusing to downgrade crypto vault");
    const stored = JSON.stringify({ v: 1, encrypted, data: encrypted ? this.encryption.encryptString(payload).toString("base64") : payload });
    if (previous !== null) atomicWrite(`${this.file}.bak`, previous);
    atomicWrite(this.file, stored);
  }
}
