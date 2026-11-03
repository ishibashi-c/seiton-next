import { describe, expect, it } from "vitest";
import {
  domainTagOf,
  parseSharedWebText,
  sanitizeTag,
  tidyMarkdownLinks,
  WEB_CLIP_BOOKMARKLET,
} from "../src/domain/webclip";

describe("parseSharedWebText", () => {
  it("extracts title and URL from Android share text", () => {
    const parsed = parseSharedWebText(
      "記事のタイトル\nhttps://example.com/article?q=1"
    );
    expect(parsed.url).toBe("https://example.com/article?q=1");
    expect(parsed.title).toBe("記事のタイトル");
    expect(parsed.note).toBe("");
  });

  it("keeps text after a URL as a note", () => {
    const parsed = parseSharedWebText("https://example.com/a この部分を残す");
    expect(parsed.url).toBe("https://example.com/a");
    expect(parsed.note).toBe("この部分を残す");
  });

  it("returns empty fields without a URL", () => {
    expect(parseSharedWebText("URLなし")).toEqual({
      note: "",
      title: "",
      url: "",
    });
  });
});

describe("WEB_CLIP_BOOKMARKLET", () => {
  it("opens the Seiton webclip action and carries the selection", () => {
    expect(WEB_CLIP_BOOKMARKLET).toContain("obsidian://seiton-next");
    expect(WEB_CLIP_BOOKMARKLET).toContain("action=webclip");
    expect(WEB_CLIP_BOOKMARKLET).toContain("note=");
  });
});

describe("sanitizeTag", () => {
  it("converts invalid Obsidian tag characters to hyphens and strips leading hash", () => {
    expect(sanitizeTag("#note.com")).toBe("note-com");
    expect(sanitizeTag("web クリップ")).toBe("web-クリップ");
    expect(sanitizeTag("tag/nested")).toBe("tag/nested");
    expect(sanitizeTag("hello_world")).toBe("hello_world");
  });
});

describe("domainTagOf", () => {
  it("turns a hostname into a valid Obsidian tag", () => {
    expect(domainTagOf("https://note.com/user/n/n123456")).toBe("note");
    expect(domainTagOf("https://zenn.dev/nrs/articles/1")).toBe("zenn");
    expect(domainTagOf("https://www.example.com/a")).toBe("example");
    expect(domainTagOf("https://note.booth.pm/items/1")).toBe("note");
    expect(domainTagOf("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
    expect(domainTagOf("https://www.youtube.com/watch?v=123")).toBe("youtube");
  });
});

describe("tidyMarkdownLinks", () => {
  it("repairs multiline link text and adjacent links", () => {
    expect(
      tidyMarkdownLinks(
        "[\n\nOrchestration\n\n](https://zenn.dev/topics/orchestration)[\n\nClaude Code\n\n](https://zenn.dev/topics/claudecode)"
      )
    ).toBe(
      "[Orchestration](https://zenn.dev/topics/orchestration)\n\n[Claude Code](https://zenn.dev/topics/claudecode)"
    );
  });

  it("repairs image-prefixed topic links", () => {
    expect(
      tidyMarkdownLinks(
        "[![](https://example.com/icon.svg)\n\ntech\n\n](https://example.com/tech)"
      )
    ).toBe(
      "[![](https://example.com/icon.svg) tech](https://example.com/tech)"
    );
  });

  it("leaves normal links unchanged", () => {
    expect(tidyMarkdownLinks("[Example](https://example.com)")).toBe(
      "[Example](https://example.com)"
    );
  });
});
