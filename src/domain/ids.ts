/**
 * ログ項目の安定ID。ULID（先頭10文字が時刻、残り16文字がランダム）を使う。
 * 外部依存なし。crypto.getRandomValues が無い環境では Math.random に退避する。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ID_PATTERN = /^[a-z]_[0-9A-HJKMNP-TV-Z]{26}$/;

export type RandomBytes = (size: number) => Uint8Array;

export interface IdOptions {
  now?: number;
  randomBytes?: RandomBytes;
}

function defaultRandomBytes(size: number): Uint8Array {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    return cryptoObject.getRandomValues(new Uint8Array(size));
  }

  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function encodeTime(timestamp: number): string {
  let value = BigInt(Math.max(0, Math.floor(timestamp)));
  const characters = new Array<string>(TIME_LENGTH).fill("0");

  for (let index = TIME_LENGTH - 1; index >= 0; index -= 1) {
    characters[index] = ALPHABET[Number(value % 32n)] ?? "0";
    value /= 32n;
  }

  return characters.join("");
}

function encodeRandom(length: number, randomBytes: RandomBytes): string {
  const byteCount = Math.ceil((length * 5) / 8);
  const bytes = randomBytes(byteCount);
  let accumulator = 0;
  let bits = 0;
  let output = "";

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      bits -= 5;
      output += ALPHABET[(accumulator >>> bits) & 31] ?? "0";
    }
    accumulator &= (1 << bits) - 1;
  }

  while (output.length < length) {
    output += "0";
  }

  return output;
}

/**
 * 接頭辞付きID。memo は `m_...`、prompt は `p_...`。
 * 同一ミリ秒でもランダム部分で区別できる。
 */
export function createId(prefix: string, options: IdOptions = {}): string {
  const normalizedPrefix = prefix.replace(/_+$/u, "").toLowerCase();
  if (!/^[a-z]$/u.test(normalizedPrefix)) {
    throw new Error("ID接頭辞は英小文字1文字にしてください");
  }

  const now = options.now ?? Date.now();
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  return `${normalizedPrefix}_${encodeTime(now)}${encodeRandom(
    RANDOM_LENGTH,
    randomBytes
  )}`;
}

/** 一言メモ用のID。 */
export function createMemoId(options: IdOptions = {}): string {
  return createId("m", options);
}

/** ログ項目IDとして妥当か。 */
export function isLogEntryId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** テスト用にIDの時刻部分を取り出す。 */
export function timestampOfId(id: string): number | null {
  if (!isLogEntryId(id)) {
    return null;
  }
  const body = id.slice(2, 2 + TIME_LENGTH);
  let value = 0n;
  for (const character of body) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) {
      return null;
    }
    value = value * 32n + BigInt(digit);
  }
  return Number(value);
}

export const ID_ALPHABET = ALPHABET;
