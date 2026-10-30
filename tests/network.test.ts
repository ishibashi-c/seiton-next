import { describe, expect, it } from "vitest";
import {
  domainOf,
  isAllowedRemoteUrl,
  isBlockedHost,
  isPrivateIpv4,
  normalizeSourceUrl,
} from "../src/domain/network";

describe("外部URLの検証", () => {
  it("http/httpsだけを許可する", () => {
    expect(isAllowedRemoteUrl("https://example.com/a")).toBe(true);
    expect(isAllowedRemoteUrl("http://example.com/a")).toBe(true);
    expect(isAllowedRemoteUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedRemoteUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedRemoteUrl("ftp://example.com")).toBe(false);
    expect(isAllowedRemoteUrl("https://user:pass@example.com")).toBe(false);
  });

  it("localhostとプライベートIPを拒否する", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("172.20.1.1")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("169.254.1.1")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("fc00::1")).toBe(true);
    expect(isBlockedHost("fe80::1")).toBe(true);
    expect(isBlockedHost("printer.local")).toBe(true);
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
  });

  it("正規化とドメイン表示", () => {
    expect(normalizeSourceUrl("https://Example.com/a?x=1#frag")).toBe(
      "https://example.com/a?x=1"
    );
    expect(normalizeSourceUrl("http://localhost/")).toBeNull();
    expect(domainOf("https://www.example.com/a")).toBe("example.com");
  });
});
