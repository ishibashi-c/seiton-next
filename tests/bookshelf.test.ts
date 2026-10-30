import { describe, expect, it } from "vitest";
import {
  type BookShelfItem,
  bookCategories,
  DEFAULT_BOOK_FILTERS,
  filterBooks,
} from "../src/domain/bookshelf";

function item(overrides: Partial<BookShelfItem>): BookShelfItem {
  return {
    author: "",
    category: "",
    cover: "",
    finished: "",
    isbn: "",
    owned: "",
    path: "Seiton/Notes/book.md",
    rating: "",
    series: "",
    status: "tbr",
    title: "Book",
    updated: 0,
    ...overrides,
  };
}

const books: BookShelfItem[] = [
  item({
    author: "若林, 健一",
    category: "技術書",
    path: "a.md",
    status: "tbr",
    title: "エレクトロニクスラボ",
    updated: 10,
  }),
  item({
    author: "山田",
    category: "技術書",
    finished: "2026-08-24",
    owned: "owned",
    path: "b.md",
    status: "read",
    title: "テスト書籍",
    updated: 30,
  }),
  item({
    author: "佐藤",
    category: "小説",
    finished: "2026-09-01",
    owned: "unowned",
    path: "c.md",
    status: "reading",
    title: "Webを支える技術",
    updated: 20,
  }),
];

describe("filterBooks", () => {
  it("filters by status, category and ownership", () => {
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, status: "read" }).map(
        (book) => book.path
      )
    ).toEqual(["b.md"]);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, category: "技術書" })
    ).toHaveLength(2);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, owned: "unowned" }).map(
        (book) => book.path
      )
    ).toEqual(["c.md"]);
  });

  it("searches title, author, category and series", () => {
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, query: "ウェブ" })
    ).toHaveLength(0);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, query: "web" }).map(
        (book) => book.path
      )
    ).toEqual(["c.md"]);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, query: "山田" }).map(
        (book) => book.path
      )
    ).toEqual(["b.md"]);
  });

  it("sorts by updated, title and finished (empty last)", () => {
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, sort: "updated" }).map(
        (book) => book.path
      )
    ).toEqual(["b.md", "c.md", "a.md"]);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, sort: "title" }).map(
        (book) => book.title
      )
    ).toEqual(["Webを支える技術", "エレクトロニクスラボ", "テスト書籍"]);
    expect(
      filterBooks(books, { ...DEFAULT_BOOK_FILTERS, sort: "finished" }).map(
        (book) => book.path
      )
    ).toEqual(["c.md", "b.md", "a.md"]);
  });
});

describe("bookCategories", () => {
  it("returns unique categories sorted", () => {
    expect(bookCategories(books)).toEqual(
      ["小説", "技術書"].sort((a, b) => a.localeCompare(b, "ja"))
    );
  });
});
