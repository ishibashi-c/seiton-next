import { describe, expect, it } from "vitest";
import {
  parseHtmlMetadata,
  resolveUrl,
  webClipDuplicateKey,
} from "../src/domain/webclip";

const HTML = `<!doctype html><html><head>
<title>Fallback</title>
<meta property="og:title" content="記事のタイトル &amp; 続き">
<meta name="description" content="概要です。">
<meta property="og:image" content="/images/cover.jpg">
<meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">
</head></html>`;

describe("WebクリップのHTML解析", () => {
  it("OGタイトル・概要・相対画像を解決する", () => {
    const metadata = parseHtmlMetadata(HTML, "https://example.com/posts/1");
    expect(metadata.title).toBe("記事のタイトル & 続き");
    expect(metadata.description).toBe("概要です。");
    expect(metadata.imageUrl).toBe("https://example.com/images/cover.jpg");
    expect(metadata.domain).toBe("example.com");
    expect(metadata.source).toBe("https://example.com/posts/1");
  });

  it("titleタグへフォールバックする", () => {
    const metadata = parseHtmlMetadata(
      "<html><head><title>タイトルだけ</title></head></html>",
      "https://example.com/a"
    );
    expect(metadata.title).toBe("タイトルだけ");
    expect(metadata.imageUrl).toBe("");
    expect(metadata.domain).toBe("example.com");
  });

  it("危険な画像URLを無視する", () => {
    const metadata = parseHtmlMetadata(
      '<meta property="og:image" content="http://127.0.0.1/secret.png">',
      "https://example.com/a"
    );
    expect(metadata.imageUrl).toBe("");
  });

  it("相対URLを解決し、不正は空文字", () => {
    expect(resolveUrl("/a/b", "https://example.com/x")).toBe(
      "https://example.com/a/b"
    );
    expect(resolveUrl("", "https://example.com/x")).toBe(
      "https://example.com/x"
    );
    expect(resolveUrl("http://[", "https://example.com")).toBe("");
  });

  it("sourceの重複キーはクエリとハッシュを落とす", () => {
    expect(webClipDuplicateKey("https://Example.com/a/?utm=1#section")).toBe(
      "https://example.com/a"
    );
    expect(webClipDuplicateKey("https://example.com/a/")).toBe(
      "https://example.com/a"
    );
  });
});

describe("YouTubeのサムネイル", () => {
  it("URLから動画IDを取り出す", async () => {
    const { youtubeIdFromUrl } = await import("../src/domain/video");
    expect(
      youtubeIdFromUrl("https://www.youtube.com/watch?v=e933OBnx1xk&si=x")
    ).toBe("e933OBnx1xk");
    expect(youtubeIdFromUrl("https://youtu.be/e933OBnx1xk")).toBe(
      "e933OBnx1xk"
    );
    expect(youtubeIdFromUrl("https://www.youtube.com/shorts/e933OBnx1xk")).toBe(
      "e933OBnx1xk"
    );
    expect(
      youtubeIdFromUrl("https://example.com/watch?v=e933OBnx1xk")
    ).toBeNull();
  });

  it("本文から最初のYouTubeサムネイルを返す", async () => {
    const { findYoutubeThumbnail } = await import("../src/domain/video");
    expect(
      findYoutubeThumbnail("https://example.com\nhttps://youtu.be/e933OBnx1xk")
    ).toBe("https://i.ytimg.com/vi/e933OBnx1xk/mqdefault.jpg");
    expect(findYoutubeThumbnail("https://example.com")).toBeNull();
  });
});
