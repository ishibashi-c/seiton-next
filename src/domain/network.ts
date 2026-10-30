/**
 * 外部URLの検証。http/https だけを許可し、localhost・プライベートIP・
 * リンクローカル・`.local` を拒否する。
 * DNS解決後のIPは確認できないため、これは一次防御であり、SSRFの完全な防止ではない。
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "metadata.google.internal",
]);

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    numbers.push(value);
  }
  return numbers;
}

export function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) {
    return true;
  }
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice(7));
  }
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "" || BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return true;
  }
  return false;
}

/** 取得してよいURLか。http/https以外は拒否する。 */
export function isAllowedRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  return !isBlockedHost(url.hostname);
}

/** カードのフォールバック表示に使うドメイン。 */
export function domainOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

/** 表示用にURLを正規化する。不正ならnull。 */
export function normalizeSourceUrl(value: string): string | null {
  if (!isAllowedRemoteUrl(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
