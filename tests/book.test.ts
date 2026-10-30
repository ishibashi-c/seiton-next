import { describe, expect, it } from "vitest";
import {
  assertReadingStatus,
  BOOK_COVERS_FOLDER,
  BookError,
  bookCandidateFromOpenBd,
  bookCandidateFromOpenLibrary,
  bookCoverPath,
  bookDuplicateKey,
  bookFileName,
  bookInfoFromFrontmatter,
  bookNotePath,
  buildBookDocument,
  buildBookFrontmatterFields,
  calilCheckUrl,
  calilContinuePending,
  calilLibrariesFromPayload,
  calilSession,
  calilSessionUrl,
  calilStatusLabel,
  canonicalIsbn,
  isBookOwnership,
  isbn10CheckDigit,
  isbn10ToIsbn13,
  isbn13CheckDigit,
  isbn13ToIsbn10,
  isbnDuplicateKey,
  isReadingStatus,
  isValidIsbn,
  isValidIsbn10,
  isValidIsbn13,
  normalizeCalilSystemIds,
  normalizeIsbn,
  openBdLookupUrl,
  openLibraryAuthorKeys,
  openLibraryAuthorUrl,
  openLibraryCoverUrl,
  openLibraryEditionUrl,
  parseBookRating,
  parseCalilPayload,
  parseReadingStatus,
  replaceBookBody,
} from "../src/domain/book";
import {
  bodyAfterFrontmatter,
  frontmatterField,
} from "../src/domain/frontmatter";

describe("ISBNの正規化", () => {
  it("ハイフン・空白・ラベルを除去し、文字列のまま返す", () => {
    expect(normalizeIsbn("978-4-7741-9242-1")).toBe("9784774192421");
    expect(normalizeIsbn(" 0-306-40615-2 ")).toBe("0306406152");
    expect(normalizeIsbn("ISBN 0-8044-2957-X")).toBe("080442957X");
    expect(normalizeIsbn("ISBN: 978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("ISBN-13: 978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("ISBN10 0-306-40615-2")).toBe("0306406152");
    expect(normalizeIsbn("978 4 7741 9242 1")).toBe("9784774192421");
    expect(normalizeIsbn("978\u30004\u30007741\u30009242\u30001")).toBe(
      "9784774192421"
    );
  });

  it("全角文字を半角へ揃える（先頭ゼロを維持）", () => {
    expect(normalizeIsbn("ＩＳＢＮ：９７８－４－７７４１－９２４２－１")).toBe(
      "9784774192421"
    );
    const isbn = normalizeIsbn("０３０６４０６１５２");
    expect(isbn).toBe("0306406152");
    expect(typeof isbn).toBe("string");
    expect(isbn.startsWith("0")).toBe(true);
  });

  it("ISBNとして解釈できない文字列は空文字", () => {
    expect(normalizeIsbn("")).toBe("");
    expect(normalizeIsbn("abc")).toBe("");
    expect(normalizeIsbn("9784X77419242")).toBe("");
    expect(normalizeIsbn("X123456789")).toBe("");
  });
});

describe("ISBNのチェックディジット", () => {
  it("ISBN-10のチェックディジットを計算する（Xを含む）", () => {
    expect(isbn10CheckDigit("030640615")).toBe("2");
    expect(isbn10CheckDigit("080442957")).toBe("X");
    expect(isbn10CheckDigit("12345")).toBe("");
  });

  it("ISBN-13のチェックディジットを計算する", () => {
    expect(isbn13CheckDigit("978030640615")).toBe("7");
    expect(isbn13CheckDigit("979109063607")).toBe("1");
    expect(isbn13CheckDigit("97803064061")).toBe("");
  });

  it("ISBN-10 / ISBN-13 を検証する", () => {
    expect(isValidIsbn10("0-306-40615-2")).toBe(true);
    expect(isValidIsbn10("080442957X")).toBe(true);
    expect(isValidIsbn10("0-306-40615-3")).toBe(false);
    expect(isValidIsbn10("03064061520")).toBe(false);
    expect(isValidIsbn13("978-0-306-40615-7")).toBe(true);
    expect(isValidIsbn13("9791090636071")).toBe(true);
    expect(isValidIsbn13("9780306406158")).toBe(false);
    expect(isValidIsbn13("9770306406157")).toBe(false);
    expect(isValidIsbn("0306406152")).toBe(true);
    expect(isValidIsbn("9780306406157")).toBe(true);
    expect(isValidIsbn("978030640615")).toBe(false);
  });
});

describe("ISBN-10 / ISBN-13 の相互変換と重複キー", () => {
  it("978始まりのISBN-13とISBN-10を行き来できる", () => {
    expect(isbn10ToIsbn13("0-306-40615-2")).toBe("9780306406157");
    expect(isbn13ToIsbn10("9780306406157")).toBe("0306406152");
    expect(isbn13ToIsbn10("9791090636071")).toBe("");
    expect(isbn10ToIsbn13("invalid")).toBe("");
  });

  it("ISBN-10とISBN-13を同じ正規形に寄せる", () => {
    expect(canonicalIsbn("0306406152")).toBe("9780306406157");
    expect(canonicalIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(canonicalIsbn("0-306-40615-3")).toBe("");
    expect(isbnDuplicateKey("0306406152")).toBe(
      isbnDuplicateKey("9780306406157")
    );
    expect(isbnDuplicateKey("invalid")).toBe("");
  });
});

describe("openBDのレスポンス変換", () => {
  it("summaryとONIXの著者を書籍候補へ変換する", () => {
    const payload = [
      {
        onix: {
          DescriptiveDetail: {
            Contributor: [
              { PersonName: { content: "夏目,漱石,1867-1916" } },
              { PersonName: { content: "角,征典" } },
            ],
            Subject: [{ SubjectHeadingText: "日本文学" }],
          },
        },
        summary: {
          author: "夏目,漱石,1867-1916 角,征典",
          cover: "https://cover.openbd.jp/9784101010014.jpg",
          isbn: "9784101010014",
          pubdate: "200306",
          publisher: "新潮社",
          series: "新潮文庫",
          title: "吾輩は猫である",
          volume: "",
        },
      },
    ];

    const candidate = bookCandidateFromOpenBd(payload, "9784101010014");
    expect(candidate).toEqual({
      authors: ["夏目,漱石,1867-1916", "角,征典"],
      category: "日本文学",
      coverUrl: "https://cover.openbd.jp/9784101010014.jpg",
      isbn: "9784101010014",
      published: "200306",
      publisher: "新潮社",
      series: "新潮文庫",
      source: "openbd",
      title: "吾輩は猫である",
      volume: "",
    });
  });

  it("ONIXに著者が無ければsummary.authorを空白区切りで読む", () => {
    const candidate = bookCandidateFromOpenBd([
      {
        summary: {
          author: "Boswell,Dustin Foucher,Trevor 角,征典",
          isbn: "9784873115658",
          title: "リーダブルコード",
        },
      },
    ]);
    expect(candidate?.authors).toEqual([
      "Boswell,Dustin",
      "Foucher,Trevor",
      "角,征典",
    ]);
  });

  it("未登録・不正なレスポンスはnull", () => {
    expect(bookCandidateFromOpenBd([null])).toBeNull();
    expect(bookCandidateFromOpenBd([{ summary: { title: "" } }])).toBeNull();
    expect(bookCandidateFromOpenBd({})).toBeNull();
    expect(bookCandidateFromOpenBd(null)).toBeNull();
  });

  it("summaryのISBNが無ければ呼び出し元のISBNを使う", () => {
    const candidate = bookCandidateFromOpenBd(
      [{ summary: { title: "手動の本" } }],
      "9780306406157"
    );
    expect(candidate?.isbn).toBe("9780306406157");
  });
});

describe("Open Libraryのレスポンス変換", () => {
  it("edition JSONと解決済み著者名から書籍候補を作る", () => {
    const payload = {
      authors: [{ key: "/authors/OL34184A" }],
      covers: [15_152_634, -1],
      isbn_10: ["0140328726"],
      isbn_13: ["9780140328721"],
      publish_date: "October 1, 1988",
      publishers: ["Puffin"],
      title: "Fantastic Mr. Fox",
    };

    const candidate = bookCandidateFromOpenLibrary(payload, "9780140328721", {
      "/authors/OL34184A": "Roald Dahl",
    });
    expect(candidate).toEqual({
      authors: ["Roald Dahl"],
      category: "",
      coverUrl: "https://covers.openlibrary.org/b/id/15152634-L.jpg",
      isbn: "9780140328721",
      published: "October 1, 1988",
      publisher: "Puffin",
      series: "",
      source: "openlibrary",
      title: "Fantastic Mr. Fox",
      volume: "",
    });
  });

  it("表紙IDが無ければISBN指定の表紙URLにする", () => {
    const candidate = bookCandidateFromOpenLibrary(
      {
        authors: [],
        covers: [-1],
        title: "表紙なし",
      },
      "9780306406157"
    );
    expect(candidate?.coverUrl).toBe(
      "https://covers.openlibrary.org/b/isbn/9780306406157-L.jpg"
    );
    expect(candidate?.authors).toEqual([]);
  });

  it("著者キーだけを取り出し、著者ページURLを組み立てる", () => {
    const payload = {
      authors: [
        { key: "/authors/OL34184A" },
        { key: "/authors/OL999A", name: "既知の著者" },
        { key: "https://example.com/authors/evil" },
      ],
    };
    expect(openLibraryAuthorKeys(payload)).toEqual(["/authors/OL34184A"]);
    expect(openLibraryAuthorUrl("/authors/OL34184A")).toBe(
      "https://openlibrary.org/authors/OL34184A.json"
    );
    expect(openLibraryAuthorUrl("https://example.com/authors/evil")).toBe("");
  });

  it("タイトルが無いレスポンスはnull", () => {
    expect(bookCandidateFromOpenLibrary({ authors: [] })).toBeNull();
    expect(bookCandidateFromOpenLibrary(null)).toBeNull();
    expect(bookCandidateFromOpenLibrary("text")).toBeNull();
  });
});

describe("外部APIのURL", () => {
  it("ISBNを文字列のままクエリへ入れる", () => {
    expect(openBdLookupUrl("978-4-7741-9242-1")).toBe(
      "https://api.openbd.jp/v1/get?isbn=9784774192421"
    );
    expect(openLibraryEditionUrl("0-306-40615-2")).toBe(
      "https://openlibrary.org/isbn/0306406152.json"
    );
    expect(openLibraryCoverUrl("9780306406157")).toBe(
      "https://covers.openlibrary.org/b/isbn/9780306406157-L.jpg"
    );
    expect(openLibraryCoverUrl("9780306406157", 42)).toBe(
      "https://covers.openlibrary.org/b/id/42-L.jpg"
    );
  });
});

describe("カーリルの応答", () => {
  it("JSONPを剥がしてJSONとして読む", () => {
    const payload = parseCalilPayload(
      'callback({"session":"s1","continue":0,"books":{}});'
    );
    expect(payload).not.toBeNull();
    expect(calilSession(payload)).toBe("s1");
    expect(calilContinuePending(payload)).toBe(false);
    expect(parseCalilPayload("not json")).toBeNull();
    expect(parseCalilPayload("")).toBeNull();
  });

  it("books形式から図書館ごとの状態を取り出す", () => {
    const payload = parseCalilPayload(
      JSON.stringify({
        books: {
          "9780306406157": {
            libkey: {
              中央図書館: "貸出可",
              梅丘図書館: "貸出中",
            },
            reserveurl: "https://example.com/reserve",
            status: "OK",
            systemid: "Tokyo_Setagaya",
            systemname: "世田谷区",
          },
        },
        continue: 0,
        session: "session-1",
      })
    );

    const hits = calilLibrariesFromPayload(
      payload,
      "0-306-40615-2",
      "Tokyo_Setagaya"
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      availability: {
        中央図書館: "貸出可",
        梅丘図書館: "貸出中",
      },
      configured: true,
      reserveUrl: "https://example.com/reserve",
      status: "OK",
      systemid: "Tokyo_Setagaya",
      systemname: "世田谷区",
    });
  });

  it("旧形式（ISBNがトップレベル）と自治体名の部分一致にも対応する", () => {
    const payload = {
      "9780306406157": {
        libkey: { 本館: "貸出可" },
        status: "OK",
        systemid: "A",
        systemname: "世田谷区立図書館",
      },
    };
    const hits = calilLibrariesFromPayload(payload, "9780306406157", "世田谷");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.configured).toBe(true);
  });

  it("ISBN-10のキーでもISBN-13の問い合わせに一致させる", () => {
    const payload = {
      "0306406152": {
        libkey: { 本館: "貸出可" },
        status: "OK",
        systemid: "A",
        systemname: "A市",
      },
    };
    const hits = calilLibrariesFromPayload(payload, "9780306406157");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.systemid).toBe("A");
  });

  it("設定した図書館を先頭に並べ、対象ISBN以外は無視する", () => {
    const payload = {
      books: {
        "9780306406157": [
          {
            libkey: {},
            status: "OK",
            systemid: "B",
            systemname: "B市",
          },
          {
            libkey: {},
            status: "MAINTENANCE",
            systemid: "A",
            systemname: "A市",
          },
        ],
        "9784101010014": {
          libkey: {},
          status: "OK",
          systemid: "C",
          systemname: "C市",
        },
      },
    };
    const hits = calilLibrariesFromPayload(payload, "9780306406157", "A");
    expect(hits.map((hit) => hit.systemid)).toEqual(["A", "B"]);
    expect(hits.map((hit) => hit.configured)).toEqual([true, false]);
    expect(calilStatusLabel("MAINTENANCE")).toBe("メンテナンス中");
    expect(calilStatusLabel("")).toBe("状態不明");
  });

  it("一致するISBNが無ければ空配列", () => {
    expect(
      calilLibrariesFromPayload(
        { books: { "9784101010014": { systemid: "A" } } },
        "9780306406157"
      )
    ).toEqual([]);
    expect(calilLibrariesFromPayload(null, "9780306406157")).toEqual([]);
  });
});

describe("読書状態・評価・所有", () => {
  it("reading_statusの値を検証する", () => {
    expect(isReadingStatus("tbr")).toBe(true);
    expect(isReadingStatus("done")).toBe(false);
    expect(parseReadingStatus("READ")).toBe("read");
    expect(parseReadingStatus("読書中")).toBe("reading");
    expect(parseReadingStatus("積読")).toBe("tbr");
    expect(parseReadingStatus("不明")).toBeNull();
    expect(parseReadingStatus(1)).toBeNull();
    expect(assertReadingStatus("read")).toBe("read");
    expect(() => assertReadingStatus("done")).toThrow(BookError);
  });

  it("評価は1〜5だけを受理する", () => {
    expect(parseBookRating(5)).toBe(5);
    expect(parseBookRating("3")).toBe(3);
    expect(parseBookRating(0)).toBeNull();
    expect(parseBookRating(6)).toBeNull();
    expect(parseBookRating("★")).toBeNull();
    expect(isBookOwnership("owned")).toBe(true);
    expect(isBookOwnership("unknown")).toBe(false);
  });
});

describe("重複判定キー", () => {
  it("ISBN-10とISBN-13を同じキーにする", () => {
    expect(bookDuplicateKey({ isbn: "0-306-40615-2" })).toBe(
      "isbn:9780306406157"
    );
    expect(bookDuplicateKey({ isbn: "9780306406157" })).toBe(
      "isbn:9780306406157"
    );
  });

  it("ISBNが無い場合はタイトルと著者で正規化する", () => {
    expect(
      bookDuplicateKey({ authors: "夏目漱石", title: " 吾輩は猫である " })
    ).toBe("title:吾輩は猫である|夏目漱石");
    expect(
      bookDuplicateKey({
        authors: ["Roald Dahl"],
        title: "Fantastic Mr. Fox",
      })
    ).toBe(
      bookDuplicateKey({ authors: "roald dahl", title: "fantastic mr fox" })
    );
    expect(bookDuplicateKey({ title: "" })).toBe("");
    expect(bookDuplicateKey({ title: "タイトルだけ" })).toBe(
      "title:タイトルだけ"
    );
  });
});

describe("書籍ノートのfrontmatter", () => {
  it("ISBNを文字列として引用し、Propertiesを生成する", () => {
    const document = buildBookDocument({
      authors: ["夏目 漱石", "角 征典"],
      category: "小説",
      created: "2026-10-26T10:00:00+09:00",
      isbn: "978-0-306-40615-7",
      publisher: "新潮社",
      rating: 4,
      readingStatus: "reading",
      series: "新潮文庫",
      title: '吾輩は猫である "引用"',
    });

    expect(frontmatterField(document, "kind")).toBe("book");
    expect(frontmatterField(document, "title")).toBe('吾輩は猫である "引用"');
    expect(frontmatterField(document, "created")).toBe(
      "2026-10-26T10:00:00+09:00"
    );
    expect(frontmatterField(document, "book_isbn")).toBe("9780306406157");
    expect(frontmatterField(document, "book_author")).toBe(
      "夏目 漱石 / 角 征典"
    );
    expect(frontmatterField(document, "book_publisher")).toBe("新潮社");
    expect(frontmatterField(document, "book_category")).toBe("小説");
    expect(frontmatterField(document, "book_series")).toBe("新潮文庫");
    expect(frontmatterField(document, "reading_status")).toBe("reading");
    expect(frontmatterField(document, "book_rating")).toBe("4");
    expect(document).toContain('book_isbn: "9780306406157"');
  });

  it("先頭ゼロのISBNを数値にしない", () => {
    const fields = buildBookFrontmatterFields({
      isbn: "0-306-40615-2",
      title: "先頭ゼロ",
    });
    expect(fields.book_isbn).toBe('"0306406152"');
    expect(
      frontmatterField(
        buildBookDocument({
          isbn: "0-306-40615-2",
          title: "先頭ゼロ",
        }),
        "book_isbn"
      )
    ).toBe("0306406152");
  });

  it("不正なISBN・状態・日付・評価・空タイトルを拒否する", () => {
    expect(() =>
      buildBookFrontmatterFields({ isbn: "9780306406158", title: "不正ISBN" })
    ).toThrow(/ISBN/u);
    expect(() =>
      buildBookFrontmatterFields({ readingStatus: "done", title: "不正状態" })
    ).toThrow(/読書状態/u);
    expect(() =>
      buildBookFrontmatterFields({ finished: "2026-02-30", title: "不正日付" })
    ).toThrow(/読了日/u);
    expect(() =>
      buildBookFrontmatterFields({ rating: 6, title: "不正評価" })
    ).toThrow(/評価/u);
    expect(() => buildBookFrontmatterFields({ title: "  " })).toThrow(
      /タイトル/u
    );
  });

  it("評価0・空の任意項目は出力しない", () => {
    const fields = buildBookFrontmatterFields({
      category: " ",
      finished: "",
      isbn: "",
      rating: 0,
      readingStatus: "",
      title: "最小の書籍",
    });
    expect(fields.book_category).toBeUndefined();
    expect(fields.book_finished).toBeUndefined();
    expect(fields.book_isbn).toBeUndefined();
    expect(fields.book_rating).toBeUndefined();
    expect(fields.reading_status).toBeUndefined();
    expect(fields.kind).toBe("book");
    expect(fields.title).toBe('"最小の書籍"');
  });

  it("本文を保持し、本文だけを安全に置き換える", () => {
    const document = buildBookDocument({
      body: "1行目\n2行目",
      created: "2026-10-26T10:00:00+09:00",
      isbn: "9780306406157",
      title: "本文あり",
    });
    expect(bodyAfterFrontmatter(document)).toBe("1行目\n2行目\n");

    const replaced = replaceBookBody(document, "新しいメモ\n複数行");
    expect(frontmatterField(replaced, "book_isbn")).toBe("9780306406157");
    expect(frontmatterField(replaced, "title")).toBe("本文あり");
    expect(bodyAfterFrontmatter(replaced)).toBe("新しいメモ\n複数行\n");

    const cleared = replaceBookBody(document, "");
    expect(bodyAfterFrontmatter(cleared)).toBe("");
    expect(frontmatterField(cleared, "kind")).toBe("book");
  });

  it("本文の行頭インデントを保持する", () => {
    const document = buildBookDocument({
      body: "    コード例\n次の行",
      title: "インデント",
    });
    expect(bodyAfterFrontmatter(document)).toBe("    コード例\n次の行\n");
  });

  it("frontmatterが無い文書の本文置換は拒否する", () => {
    expect(() => replaceBookBody("本文だけ", "変更")).toThrow(/frontmatter/u);
  });
});

describe("ファイル名・パス", () => {
  it("タイトルから安全なファイル名を作る", () => {
    expect(bookFileName('a/b:c*d?e"f<g>h|i#j^k[l]m')).toBe(
      "a-b-c-d-e-f-g-h-i-j-k-l-m"
    );
    expect(bookFileName("  通常の 書籍  ")).toBe("通常の 書籍");
    expect(bookFileName("")).toBe("無題の本");
    expect(bookFileName("...")).toBe("無題の本");
    expect(bookFileName("CON")).toBe("_CON");
    expect(bookFileName("あ".repeat(100)).length).toBeLessThanOrEqual(80);
  });

  it("ノートと表紙のVaultパスを作る", () => {
    expect(bookNotePath("吾輩は猫である")).toBe(
      "Seiton/Notes/吾輩は猫である.md"
    );
    expect(bookNotePath("技術書/入門", "Custom/Books")).toBe(
      "Custom/Books/技術書-入門.md"
    );
    expect(bookCoverPath("9780306406157")).toBe(
      `${BOOK_COVERS_FOLDER}/9780306406157.jpg`
    );
    expect(bookCoverPath("0-306-40615-2")).toBe(
      `${BOOK_COVERS_FOLDER}/0306406152.jpg`
    );
    expect(bookCoverPath("invalid")).toBe("");
  });
});

describe("frontmatterからの読み取り", () => {
  it("snake_caseのPropertiesを読む", () => {
    const info = bookInfoFromFrontmatter({
      book_author: ["夏目 漱石", "角 征典"],
      book_category: "小説",
      book_finished: "2026-10-26",
      book_isbn: "978-0-306-40615-7",
      book_ownership: "owned",
      book_published: "200306",
      book_publisher: "新潮社",
      book_rating: 5,
      book_series: "新潮文庫",
      reading_status: "read",
    });
    expect(info.isbn).toBe("9780306406157");
    expect(info.authors).toEqual(["夏目 漱石", "角 征典"]);
    expect(info.author).toBe("夏目 漱石 / 角 征典");
    expect(info.readingStatus).toBe("read");
    expect(info.rating).toBe(5);
    expect(info.finished).toBe("2026-10-26");
    expect(info.ownership).toBe("owned");
  });

  it("旧データのcamelCaseも読める", () => {
    const info = bookInfoFromFrontmatter({
      bookAuthor: "Roald Dahl / 別の著者",
      bookCategory: "児童書",
      bookCover: "Seiton/System/Assets/Covers/9780140328721.jpg",
      bookIsbn: "0-306-40615-2",
      bookRating: "4",
      readingStatus: "読書中",
    });
    expect(info.isbn).toBe("0306406152");
    expect(info.authors).toEqual(["Roald Dahl", "別の著者"]);
    expect(info.category).toBe("児童書");
    expect(info.cover).toBe("Seiton/System/Assets/Covers/9780140328721.jpg");
    expect(info.rating).toBe(4);
    expect(info.readingStatus).toBe("reading");
  });
});

describe("カーリルのURL", () => {
  it("ISBNとsystemidをcheckへ渡す", () => {
    const url = new URL(
      calilCheckUrl("9784887062603", "app key", "Tokyo_Setagaya")
    );
    expect(url.origin).toBe("https://api.calil.jp");
    expect(url.pathname).toBe("/check");
    expect(url.searchParams.get("appkey")).toBe("app key");
    expect(url.searchParams.get("isbn")).toBe("9784887062603");
    expect(url.searchParams.get("systemid")).toBe("Tokyo_Setagaya");
    expect(url.searchParams.get("callback")).toBe("no");
  });

  it("ポーリングはsessionだけを渡す", () => {
    const url = new URL(calilSessionUrl("session-1", "app key"));
    expect(url.searchParams.get("session")).toBe("session-1");
    expect(url.searchParams.get("appkey")).toBe("app key");
    expect(url.searchParams.get("isbn")).toBeNull();
  });
});

describe("normalizeCalilSystemIds", () => {
  it("カンマ区切りの前後空白を落とす", () => {
    expect(normalizeCalilSystemIds(" Fukuoka_Onga, Univ_Kindai ,, ")).toBe(
      "Fukuoka_Onga,Univ_Kindai"
    );
  });

  it("実APIのsystemid入れ子を展開する", () => {
    const hits = calilLibrariesFromPayload(
      {
        books: {
          "9780306406157": {
            Tokyo_Setagaya: {
              libkey: { 中央図書館: "貸出可" },
              reserveurl: "https://example.com/reserve",
              status: "OK",
            },
          },
        },
        continue: 0,
      },
      "9780306406157",
      "Tokyo_Setagaya"
    );
    expect(hits).toEqual([
      {
        availability: { 中央図書館: "貸出可" },
        configured: true,
        reserveUrl: "https://example.com/reserve",
        status: "OK",
        systemid: "Tokyo_Setagaya",
        systemname: "Tokyo_Setagaya",
      },
    ]);
  });

  it("複数systemidのどれかに一致すれば設定済みにする", () => {
    const hits = calilLibrariesFromPayload(
      {
        books: {
          "9780306406157": {
            Tokyo_Setagaya: {
              libkey: { 中央図書館: "貸出可" },
              status: "OK",
              systemid: "Tokyo_Setagaya",
              systemname: "世田谷区",
            },
          },
        },
        continue: 0,
      },
      "9780306406157",
      "Osaka_Higashiosaka, Tokyo_Setagaya"
    );
    expect(hits[0]?.configured).toBe(true);
  });
});

describe("カーリル実レスポンス", () => {
  it("複数システムの入れ子をすべて展開する", () => {
    const hits = calilLibrariesFromPayload(
      {
        books: {
          "9784887062603": {
            Fukuoka_Onga: { libkey: {}, reserveurl: "", status: "Cache" },
            Osaka_Higashiosaka: {
              libkey: { 花園: "貸出可" },
              reserveurl: "https://example.com/osaka",
              status: "Cache",
            },
            Univ_Kindai: {
              libkey: { 中央図書館: "貸出可", 工学部図書館: "貸出可" },
              reserveurl: "https://example.com/kindai",
              status: "Cache",
            },
          },
        },
        continue: 0,
      },
      "9784887062603",
      "Fukuoka_Onga,Univ_Kindai,Osaka_Higashiosaka"
    );
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.configured)).toBe(true);
    expect(
      hits.find((hit) => hit.systemid === "Univ_Kindai")?.availability
    ).toEqual({
      中央図書館: "貸出可",
      工学部図書館: "貸出可",
    });
  });
});

describe("表紙の埋め込み", () => {
  const base = [
    "---",
    "kind: book",
    'book_cover: "Seiton/System/Assets/Covers/9784887062603.jpg"',
    "---",
    "",
    "感想",
    "",
  ].join("\n");
  const cover = "Seiton/System/Assets/Covers/9784887062603.jpg";

  it("本文の先頭に1行だけ入れる", async () => {
    const { embedCoverInDocument, hasCoverEmbed } = await import(
      "../src/domain/book"
    );
    const result = embedCoverInDocument(base, cover);
    expect(result).toContain(`![[${cover}|240]]\n\n感想`);
    expect(hasCoverEmbed(result, cover)).toBe(true);
  });

  it("二度実行しても増えない", async () => {
    const { embedCoverInDocument } = await import("../src/domain/book");
    const once = embedCoverInDocument(base, cover);
    expect(embedCoverInDocument(once, cover)).toBe(once);
  });
});

describe("メモ欄から表紙を除く", () => {
  const cover = "Seiton/System/Assets/Covers/1.jpg";
  const body = `![[${cover}|240]]\n\n感想\n`;

  it("読み込み時に表紙行を落とす", async () => {
    const { stripCoverEmbed } = await import("../src/domain/book");
    expect(stripCoverEmbed(body, cover)).toBe("感想");
  });

  it("保存時に表紙行を戻す", async () => {
    const { withCoverEmbed } = await import("../src/domain/book");
    expect(withCoverEmbed("感想", cover)).toBe(`![[${cover}|240]]\n\n感想`);
  });

  it("表紙が無ければ何もしない", async () => {
    const { stripCoverEmbed, withCoverEmbed } = await import(
      "../src/domain/book"
    );
    expect(stripCoverEmbed("感想", "")).toBe("感想");
    expect(withCoverEmbed("感想", "")).toBe("感想");
  });
});

describe("代替表紙の判定", () => {
  it("既知のハッシュを弾く", async () => {
    const { isPlaceholderHash } = await import("../src/domain/coverQuality");
    expect(
      isPlaceholderHash(
        "a9af512c1e52ed9cafd06b8f212bf13940976703ee3a38573df558e28ce31a21"
      )
    ).toBe(true);
    expect(isPlaceholderHash("deadbeef")).toBe(false);
  });

  it("灰色で一様な画像は表紙ではない", async () => {
    const { isLikelyPlaceholder } = await import("../src/domain/coverQuality");
    expect(isLikelyPlaceholder({ saturation: 0.01, stddev: 8 })).toBe(true);
    expect(isLikelyPlaceholder({ saturation: 0.3, stddev: 40 })).toBe(false);
  });
});
