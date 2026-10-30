import { describe, expect, it } from "vitest";
import {
  googleBooksCoverUrl,
  googleBooksSearchUrl,
} from "../src/domain/googleBooks";

describe("googleBooksSearchUrl", () => {
  it("ISBN・国・APIキーをエンコードして組み立てる", () => {
    const url = new URL(
      googleBooksSearchUrl("デザインの輪郭", " key with space ")
    );
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toBe("/books/v1/volumes");
    expect(url.searchParams.get("q")).toBe("デザインの輪郭");
    expect(url.searchParams.get("country")).toBe("JP");
    expect(url.searchParams.get("key")).toBe("key with space");
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("fields")).toContain("imageLinks");
  });
});

describe("googleBooksCoverUrl", () => {
  it("大きい画像を優先し、httpをhttpsへ直す", () => {
    expect(
      googleBooksCoverUrl({
        items: [
          {
            volumeInfo: {
              imageLinks: {
                large: "http://books.google.com/books/content?id=abc&zoom=1",
                thumbnail:
                  "https://books.google.com/books/content?id=abc&zoom=1",
              },
            },
          },
        ],
      })
    ).toBe("https://books.google.com/books/content?id=abc&zoom=1");
  });

  it("thumbnailしかなければthumbnailを使う", () => {
    expect(
      googleBooksCoverUrl({
        items: [
          {
            volumeInfo: {
              imageLinks: {
                smallThumbnail: "https://example.com/small.jpg",
                thumbnail: "https://example.com/thumb.jpg",
              },
            },
          },
        ],
      })
    ).toBe("https://example.com/thumb.jpg");
  });

  it("ISBNが一致する項目の表紙だけを選ぶ", () => {
    expect(
      googleBooksCoverUrl(
        {
          items: [
            {
              volumeInfo: {
                imageLinks: { thumbnail: "https://example.com/wrong.jpg" },
                industryIdentifiers: [
                  { identifier: "9780000000000", type: "ISBN_13" },
                ],
              },
            },
            {
              volumeInfo: {
                imageLinks: { thumbnail: "https://example.com/right.jpg" },
                industryIdentifiers: [
                  { identifier: "978-4-88706-260-3", type: "ISBN_13" },
                ],
              },
            },
          ],
        },
        "9784887062603"
      )
    ).toBe("https://example.com/right.jpg");
  });

  it("画像がない場合はnull", () => {
    expect(googleBooksCoverUrl({ items: [{ volumeInfo: {} }] })).toBeNull();
    expect(googleBooksCoverUrl({})).toBeNull();
  });
});
