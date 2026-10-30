import { describe, expect, it } from "vitest";
import {
  bodyAfterFrontmatter,
  frontmatterField,
} from "../src/domain/frontmatter";
import { parseMemoLog } from "../src/domain/memoLog";
import type { MigrationLogRecord } from "../src/domain/migration";
import {
  appendMigrationLogRecords,
  classifyLegacyDocument,
  contentHash,
  createMigrationLogDocument,
  findConvertedMigrationRecord,
  MIGRATION_HASH_KEY,
  MIGRATION_SOURCE_KEY,
  mapLegacyProperties,
  migrationEntryId,
  parseLegacyMonthlyMemo,
  parseMigrationLog,
  planLegacyNoteConversion,
  resolveNoteTargetPath,
  stableHash,
} from "../src/domain/migration";
import type {
  MigrationCandidate,
  MigrationPort,
  MigrationScanResult,
} from "../src/services/migrationService";
import { MigrationService } from "../src/services/migrationService";

const LOG_PATH = "Seiton/System/Migration/migration-log.md";
const WEEK_43 = "Seiton/System/Logs/Memos/2026-W43.md";
const WEEK_44 = "Seiton/System/Logs/Memos/2026-W44.md";

class MemoryVault implements MigrationPort {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly writes: string[] = [];
  failNextCreatePath: string | null = null;
  failNextProcessPath: string | null = null;

  exists(path: string): boolean {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`missing: ${path}`);
    }
    return value;
  }

  async create(path: string, data: string): Promise<void> {
    if (this.failNextCreatePath === path) {
      this.failNextCreatePath = null;
      throw new Error("simulated create failure");
    }
    if (this.files.has(path)) {
      throw new Error(`exists: ${path}`);
    }
    this.files.set(path, data);
    this.writes.push(path);
  }

  async process(
    path: string,
    transform: (data: string) => string
  ): Promise<string> {
    if (this.failNextProcessPath === path) {
      this.failNextProcessPath = null;
      throw new Error("simulated write failure");
    }
    const before = this.files.get(path);
    if (before === undefined) {
      throw new Error(`missing: ${path}`);
    }
    const next = transform(before);
    this.files.set(path, next);
    this.writes.push(path);
    return next;
  }

  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async listMarkdown(): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.endsWith(".md")).sort();
  }
}

const BOOK_NOTE = `---
type: reading
status: active
bookIsbn: "9784062636631"
bookCover: "[[covers/book.png]]"
readingStatus: reading
bookOwnership: owned
tags:
  - 読書
created: "2025-01-02T03:04:05+09:00"
aliases:
  - 旧読書ノート
---
本文です。

- 引用
`;

const MONTHLY_NOTE = `---
type: memo
month: 2026-10
---
# 2026-10

## 2026-10-25
- 21:05 週の変わり目のメモ #memo

## 2026-10-26
- 09:32 朝のメモ #タグ
  続きの行
- 10:00
- 25:00 存在しない時刻
- 11:00 三つ目 #a #b
`;

const YEAR_CROSSING = `---
type: memo
month: 2026-12
---
## 2026-12-31
- 23:50 大晦日
## 2027-01-01
- 00:30 元日
## 2027-01-04
- 09:00 新しい週
`;

const INBOX_NOTE = `---
type: note
status: inbox
---
整理する
`;

const CONVERTED_AT = "2026-10-26T09:00:00+09:00";

function fixedNow(): Date {
  return new Date(2026, 9, 26, 9, 0, 0);
}

function serviceFor(
  vault: MemoryVault,
  now: () => Date = fixedNow
): MigrationService {
  return new MigrationService({ now, port: vault });
}

function candidateAt(
  scan: MigrationScanResult,
  path: string
): MigrationCandidate {
  const candidate = scan.candidates.find((item) => item.path === path);
  if (!candidate) {
    throw new Error(`candidate not found: ${path}`);
  }
  return candidate;
}

function weekly(vault: MemoryVault, path: string) {
  return parseMemoLog(vault.files.get(path) ?? "");
}

describe("mapLegacyProperties", () => {
  it("reading と書籍フィールドから book を作り、ISBNを文字列で保つ", () => {
    const mapping = mapLegacyProperties({
      bookCover: "[[covers/book.png]]",
      bookIsbn: "0123456789",
      readingStatus: "read",
      type: "reading",
    });
    expect(mapping.kind).toBe("book");
    expect(mapping.book.book_isbn).toBe("0123456789");
    expect(mapping.book.book_cover).toBe("[[covers/book.png]]");
    expect(mapping.book.reading_status).toBe("read");
    expect(mapping.legacy.bookIsbn).toBe("0123456789");
    expect(mapping.needsReview).toBe(false);
  });

  it("書籍フィールドのない reading は reading のまま", () => {
    const mapping = mapLegacyProperties({ status: "active", type: "reading" });
    expect(mapping.kind).toBe("reading");
    expect(mapping.book).toEqual({});
  });

  it("type を kind へ対応表で変換する", () => {
    expect(mapLegacyProperties({ type: "note" }).kind).toBe("note");
    expect(mapLegacyProperties({ type: "idea" }).kind).toBe("idea");
    expect(mapLegacyProperties({ type: "class" }).kind).toBe("class");
    expect(mapLegacyProperties({ type: "webclip" }).kind).toBe("webclip");
  });

  it("未知の type は捨てず、kind として保持して要確認にする", () => {
    const mapping = mapLegacyProperties({ type: "zettel" });
    expect(mapping.kind).toBe("zettel");
    expect(mapping.needsReview).toBe(true);
    expect(mapping.reviewReasons.join(" ")).toContain("zettel");
  });

  it("status: inbox は review を作らず、archive だけ archived にする", () => {
    const inbox = mapLegacyProperties({ status: "inbox", type: "note" });
    expect(inbox.flags.review).toBe(false);
    expect(inbox.flags.archived).toBe(false);
    expect(inbox.statusKind).toBe("inbox");

    const archived = mapLegacyProperties({ status: "archive", type: "note" });
    expect(archived.flags.archived).toBe(true);

    const active = mapLegacyProperties({ status: "active", type: "note" });
    expect(active.flags.archived).toBe(false);
    expect(active.flags.review).toBe(false);
  });

  it("未知の status はフラグにせず警告する", () => {
    const mapping = mapLegacyProperties({ status: "someday", type: "note" });
    expect(mapping.statusKind).toBe("other");
    expect(mapping.flags.archived).toBe(false);
    expect(mapping.warnings.join(" ")).toContain("someday");
  });

  it("不正な month は写像せず警告する", () => {
    const mapping = mapLegacyProperties({ month: "2026-13", type: "memo" });
    expect(mapping.month).toBe("");
    expect(mapping.warnings.join(" ")).toContain("2026-13");
  });
});

describe("planLegacyNoteConversion", () => {
  it("新形式のノートを作り、本文と未知のキーを保持する", () => {
    const result = planLegacyNoteConversion({
      content: BOOK_NOTE,
      convertedAt: CONVERTED_AT,
      sourceHash: contentHash(BOOK_NOTE),
      sourcePath: "Old/Book.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const plan = result.plan;
    expect(plan.kind).toBe("book");
    expect(plan.isbn).toEqual(["9784062636631"]);
    expect(plan.archived).toBe(false);
    expect(plan.preservedKeys).toEqual(["tags", "aliases"]);

    const document = plan.document;
    expect(frontmatterField(document, "kind")).toBe("book");
    expect(frontmatterField(document, "book_isbn")).toBe("9784062636631");
    expect(frontmatterField(document, "book_cover")).toBe(
      "[[covers/book.png]]"
    );
    expect(frontmatterField(document, "reading_status")).toBe("reading");
    expect(frontmatterField(document, "book_ownership")).toBe("owned");
    expect(frontmatterField(document, MIGRATION_SOURCE_KEY)).toBe(
      "Old/Book.md"
    );
    expect(frontmatterField(document, MIGRATION_HASH_KEY)).toBe(
      contentHash(BOOK_NOTE)
    );
    expect(document).toContain("  - 読書");
    expect(document).toContain("  - 旧読書ノート");
    expect(document).not.toContain("review:");
    expect(document).not.toContain("type: reading");
    expect(bodyAfterFrontmatter(document)).toBe(
      bodyAfterFrontmatter(BOOK_NOTE)
    );
  });

  it("status: inbox から review: true を作らない", () => {
    const result = planLegacyNoteConversion({
      content: "---\ntype: note\nstatus: inbox\n---\n\n本文\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Inbox.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.document).not.toContain("review:");
    expect(result.plan.archived).toBe(false);
  });

  it("明示指定した場合だけ inbox に review: true を付ける", () => {
    const result = planLegacyNoteConversion({
      content: INBOX_NOTE,
      convertedAt: CONVERTED_AT,
      review: true,
      sourcePath: "Old/Inbox.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.review).toBe(true);
    expect(frontmatterField(result.plan.document, "review")).toBe("true");
  });

  it("status: archive は archived: true にする", () => {
    const result = planLegacyNoteConversion({
      content: "---\ntype: note\nstatus: archive\n---\n\n本文\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Archived.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(frontmatterField(result.plan.document, "archived")).toBe("true");
    expect(result.plan.archived).toBe(true);
  });

  it("未知の type は kind として保持する", () => {
    const result = planLegacyNoteConversion({
      content: "---\ntype: zettel\n---\n\n独自\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Zettel.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(frontmatterField(result.plan.document, "kind")).toBe("zettel");
    expect(result.plan.warnings.join(" ")).toContain("zettel");
  });

  it("created がなければ変換日時を使い、あれば維持する", () => {
    const kept = planLegacyNoteConversion({
      content:
        '---\ncreated: "2025-01-02T03:04:05+09:00"\ntype: note\n---\n\n本文\n',
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Kept.md",
    });
    expect(kept.ok).toBe(true);
    if (!kept.ok) {
      throw new Error(kept.reason);
    }
    expect(frontmatterField(kept.plan.document, "created")).toBe(
      "2025-01-02T03:04:05+09:00"
    );

    const filled = planLegacyNoteConversion({
      content: "---\ntype: note\n---\n\n本文\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Filled.md",
    });
    expect(filled.ok).toBe(true);
    if (!filled.ok) {
      throw new Error(filled.reason);
    }
    expect(frontmatterField(filled.plan.document, "created")).toBe(
      CONVERTED_AT
    );
  });

  it("閉じていない frontmatter や重複キーは変換しない", () => {
    const unclosed = planLegacyNoteConversion({
      content: "---\ntype: note\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Broken.md",
    });
    expect(unclosed.ok).toBe(false);
    if (unclosed.ok) {
      throw new Error("unclosed should fail");
    }
    expect(unclosed.reason).toContain("終端");

    const duplicate = planLegacyNoteConversion({
      content: "---\ntype: note\ntype: idea\n---\n\n本文\n",
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Duplicate.md",
    });
    expect(duplicate.ok).toBe(false);
  });

  it("CRLFの元ファイルは改行コードを保ってコピーする", () => {
    const crlf = "---\r\ntype: note\r\n---\r\n\r\n本文1\r\n本文2\r\n";
    const result = planLegacyNoteConversion({
      content: crlf,
      convertedAt: CONVERTED_AT,
      sourcePath: "Old/Crlf.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.plan.document).toContain("\r\n");
    expect(bodyAfterFrontmatter(result.plan.document)).toBe(
      bodyAfterFrontmatter(crlf)
    );
  });
});

describe("parseLegacyMonthlyMemo", () => {
  it("行をISO週のエントリへ変換し、行内タグと継続行を残す", () => {
    const parsed = parseLegacyMonthlyMemo(MONTHLY_NOTE, {
      offset: "+09:00",
      sourcePath: "Old/Memos/2026-10.md",
    });
    expect(parsed.month).toBe("2026-10");
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries.map((entry) => entry.at)).toEqual([
      "2026-10-25T21:05:00+09:00",
      "2026-10-26T09:32:00+09:00",
      "2026-10-26T11:00:00+09:00",
    ]);
    expect(parsed.entries.map((entry) => entry.week)).toEqual([
      "2026-W43",
      "2026-W44",
      "2026-W44",
    ]);
    expect(parsed.entries.map((entry) => entry.body)).toEqual([
      "週の変わり目のメモ #memo",
      "朝のメモ #タグ\n続きの行",
      "三つ目 #a #b",
    ]);
    expect(parsed.weeks).toEqual(["2026-W43", "2026-W44"]);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "empty-body",
      "invalid-time",
    ]);
  });

  it("ISO週をまたぐ日付を正しい週へ振り分ける", () => {
    const parsed = parseLegacyMonthlyMemo(YEAR_CROSSING, {
      offset: "+09:00",
      sourcePath: "Old/Memos/2026-12.md",
    });
    expect(parsed.entries.map((entry) => entry.week)).toEqual([
      "2026-W53",
      "2026-W53",
      "2027-W01",
    ]);
    expect(parsed.entries.map((entry) => entry.at)).toEqual([
      "2026-12-31T23:50:00+09:00",
      "2027-01-01T00:30:00+09:00",
      "2027-01-04T09:00:00+09:00",
    ]);
    expect(
      parsed.diagnostics.filter(
        (diagnostic) => diagnostic.code === "month-mismatch"
      )
    ).toHaveLength(2);
  });

  it("不正な日付見出し・日付より前の行・解釈できない行を報告する", () => {
    const parsed = parseLegacyMonthlyMemo(
      `---
type: memo
month: 2026-02
---
- 09:00 日付より前

## 2026-02-30
- 10:00 不正な日付

## 2026-02-28
自由記述
- 11:00 正常
`,
      { offset: "+09:00", sourcePath: "Old/Memos/2026-02.md" }
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.body).toBe("正常");
    const codes = parsed.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("entry-before-date");
    expect(codes).toContain("invalid-date");
    expect(codes).toContain("unparsed-line");
  });

  it("同じ入力からは同じIDになり、元パスが違えば変わる", () => {
    const first = parseLegacyMonthlyMemo(MONTHLY_NOTE, {
      offset: "+09:00",
      sourcePath: "Old/Memos/2026-10.md",
    });
    const second = parseLegacyMonthlyMemo(MONTHLY_NOTE, {
      offset: "+09:00",
      sourcePath: "Old/Memos/2026-10.md",
    });
    const other = parseLegacyMonthlyMemo(MONTHLY_NOTE, {
      offset: "+09:00",
      sourcePath: "Old/Other/2026-10.md",
    });
    expect(first.entries.map((entry) => entry.id)).toEqual(
      second.entries.map((entry) => entry.id)
    );
    expect(first.entries[0]?.id).not.toBe(other.entries[0]?.id);
    expect(first.entries[0]?.id).toMatch(/^m_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("frontmatter がない・閉じていない場合はエントリを作らない", () => {
    const missing = parseLegacyMonthlyMemo("## 2026-10-26\n- 09:00 本文\n", {
      offset: "+09:00",
      sourcePath: "Old/NoFrontmatter.md",
    });
    expect(missing.entries).toHaveLength(0);
    expect(missing.diagnostics[0]?.code).toBe("frontmatter-missing");

    const unclosed = parseLegacyMonthlyMemo(
      "---\ntype: memo\n## 2026-10-26\n- 09:00 本文\n",
      { offset: "+09:00", sourcePath: "Old/Unclosed.md" }
    );
    expect(unclosed.entries).toHaveLength(0);
    expect(unclosed.diagnostics[0]?.code).toBe("frontmatter-unclosed");
  });

  it("migrationEntryId は行・日時・本文・元パスから安定して決まる", () => {
    const base = {
      at: "2026-10-26T09:32:00+09:00",
      body: "本文",
      line: 12,
      sourcePath: "Old/Memos/2026-10.md",
    };
    expect(migrationEntryId(base)).toBe(migrationEntryId(base));
    expect(migrationEntryId(base)).not.toBe(
      migrationEntryId({ ...base, body: "別の本文" })
    );
    expect(migrationEntryId(base)).not.toBe(
      migrationEntryId({ ...base, line: 13 })
    );
  });
});

describe("ハッシュ・パス・変換ログ", () => {
  it("stableHash は16桁の16進で、内容により変わる", () => {
    expect(stableHash("abc")).toMatch(/^[0-9a-f]{16}$/u);
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
    expect(contentHash("a\r\nb")).not.toBe(contentHash("a\nb"));
  });

  it("既存ノートと衝突する場合は決まった別名を使う", () => {
    const existing = new Set(["Seiton/Notes/同じ名前.md"]);
    const options = {
      basename: "同じ名前",
      exists: (path: string) => existing.has(path),
      notesFolder: "Seiton/Notes",
      sourcePath: "Old/同じ名前.md",
    };
    const first = resolveNoteTargetPath(options);
    expect(first).toMatch(/^Seiton\/Notes\/同じ名前-[0-9a-f]{8}\.md$/u);
    expect(resolveNoteTargetPath(options)).toBe(first);

    const firstPath = first ?? "";
    existing.add(firstPath);
    const second = resolveNoteTargetPath(options);
    expect(second).toMatch(/-[0-9a-f]{8}-2\.md$/u);
    expect(second).not.toBe(firstPath);
  });

  it("衝突がなければ元の名前のパスを返す", () => {
    expect(
      resolveNoteTargetPath({
        basename: "自由研究",
        exists: () => false,
        notesFolder: "Seiton/Notes",
        sourcePath: "Old/自由研究.md",
      })
    ).toBe("Seiton/Notes/自由研究.md");
  });

  it("変換ログを追記し、元パス・新パス・ハッシュ・日時・結果を解析できる", () => {
    const record: MigrationLogRecord = {
      convertedAt: CONVERTED_AT,
      entryCount: 3,
      isbn: ["9784062636631"],
      message: "警告あり",
      result: "converted",
      sourceHash: stableHash("source"),
      sourcePath: "Old/Memos/2026-10.md",
      targetPaths: [WEEK_43, WEEK_44],
    };
    const document = appendMigrationLogRecords("", [record]);
    expect(document).toContain("kind: migration-log");
    expect(document).toContain("- 元: `Old/Memos/2026-10.md`");
    expect(document).toContain(`- 新: \`${WEEK_43}\`, \`${WEEK_44}\``);
    expect(document).toContain("- 元ハッシュ:");
    expect(document).toContain(`- 変換日時: \`${CONVERTED_AT}\``);
    expect(document).toContain("- 結果: converted");
    expect(document).toContain("- 件数: 3");
    expect(parseMigrationLog(document)).toEqual([record]);

    const appended = appendMigrationLogRecords(document, [
      { ...record, result: "failed", sourcePath: "Old/Failed.md" },
    ]);
    const parsed = parseMigrationLog(appended);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.result).toBe("failed");
    expect(parsed[1]?.sourcePath).toBe("Old/Failed.md");
    expect(appended).toContain("\n\n### `Old/Failed.md`");
    expect(
      findConvertedMigrationRecord(parsed, "Old/Memos/2026-10.md")
    ).not.toBeNull();
    expect(findConvertedMigrationRecord(parsed, "Old/Failed.md")).toBeNull();
  });

  it("空のログには見出しを作り、既存ログは書き換えない", () => {
    const created = createMigrationLogDocument(CONVERTED_AT);
    expect(created).toContain("kind: migration-log");
    expect(created).toContain("# 旧Seitonからの移行ログ");
    const record: MigrationLogRecord = {
      convertedAt: CONVERTED_AT,
      entryCount: 1,
      isbn: [],
      message: "",
      result: "converted",
      sourceHash: stableHash("x"),
      sourcePath: "Old/Note.md",
      targetPaths: ["Seiton/Notes/Note.md"],
    };
    const appended = appendMigrationLogRecords(created, [record]);
    expect(appended.startsWith(created)).toBe(true);
    expect(appended.match(/# 旧Seitonからの移行ログ/gu)).toHaveLength(1);
  });
});

describe("classifyLegacyDocument", () => {
  it("旧ノート・月次メモ・新形式・対象外を分類する", () => {
    expect(classifyLegacyDocument(BOOK_NOTE).category).toBe("legacy-note");
    expect(classifyLegacyDocument(MONTHLY_NOTE).category).toBe("legacy-memo");
    expect(
      classifyLegacyDocument("---\nkind: memo-log\nweek: 2026-W44\n---\n")
        .category
    ).toBe("already-new");
    expect(classifyLegacyDocument("ただの本文\n").category).toBe("unsupported");
    expect(classifyLegacyDocument("---\ntype: note\n").category).toBe(
      "unsupported"
    );
  });
});

describe("MigrationService", () => {
  it("scan は読み取り専用で候補とプレビューを返す", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Book.md", BOOK_NOTE);
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    vault.files.set("Seiton/Notes/New.md", "---\nkind: note\n---\n\n新形式\n");
    vault.files.set("Memo.md", "ただのノート\n");
    const service = serviceFor(vault);

    const scan = await service.scan();
    expect(scan.summary).toEqual({
      alreadyNew: 1,
      legacyMemo: 1,
      legacyNote: 1,
      scanned: 4,
      unsupported: 1,
    });
    expect(scan.candidates.map((item) => item.path)).toEqual([
      "Old/Book.md",
      "Old/Memos/2026-10.md",
    ]);
    expect(scan.logPath).toBe(LOG_PATH);

    const book = candidateAt(scan, "Old/Book.md");
    expect(book.kind).toBe("book");
    expect(book.isbn).toEqual(["9784062636631"]);
    expect(book.targetPaths).toEqual(["Seiton/Notes/Book.md"]);
    expect(book.targetState).toBe("new");
    expect(book.preview).toContain("kind: book");

    const monthly = candidateAt(scan, "Old/Memos/2026-10.md");
    expect(monthly.kind).toBe("memo-log");
    expect(monthly.needsReview).toBe(false);
    expect(monthly.entryCount).toBe(3);
    expect(monthly.targetPaths).toEqual([WEEK_43, WEEK_44]);
    expect(monthly.targetState).toBe("new");
    expect(monthly.preview).toContain("## 2026-W44");

    expect(vault.writes).toEqual([]);
  });

  it("通常ノートをコピーし、元ファイルを変更せずISBNを検証する", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Book.md", BOOK_NOTE);
    const service = serviceFor(vault);

    const report = await service.convert(["Old/Book.md"]);
    expect(report.summary.converted).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(vault.files.get("Old/Book.md")).toBe(BOOK_NOTE);

    const created = vault.files.get("Seiton/Notes/Book.md") ?? "";
    expect(created).not.toBe("");
    expect(frontmatterField(created, "kind")).toBe("book");
    expect(frontmatterField(created, "book_isbn")).toBe("9784062636631");
    expect(frontmatterField(created, MIGRATION_SOURCE_KEY)).toBe("Old/Book.md");
    expect(bodyAfterFrontmatter(created)).toBe(bodyAfterFrontmatter(BOOK_NOTE));
    expect(report.results[0]?.isbn).toEqual(["9784062636631"]);
    expect(report.results[0]?.targetPaths).toEqual(["Seiton/Notes/Book.md"]);

    const log = vault.files.get(LOG_PATH) ?? "";
    expect(log).toContain("Old/Book.md");
    expect(log).toContain("Seiton/Notes/Book.md");
    expect(log).toContain(contentHash(BOOK_NOTE));
    expect(parseMigrationLog(log)).toHaveLength(1);
  });

  it("月次メモを週次ファイルへ追記し、タグと元ファイルを保つ", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const service = serviceFor(vault);

    const report = await service.convert(["Old/Memos/2026-10.md"]);
    expect(report.summary.converted).toBe(1);
    expect(vault.files.get("Old/Memos/2026-10.md")).toBe(MONTHLY_NOTE);

    const w43 = weekly(vault, WEEK_43);
    expect(w43.frontmatter.fields.kind).toBe("memo-log");
    expect(w43.frontmatter.fields.week).toBe("2026-W43");
    expect(w43.entries.map((entry) => entry.body)).toEqual([
      "週の変わり目のメモ #memo",
    ]);

    const w44 = weekly(vault, WEEK_44);
    expect(w44.entries.map((entry) => entry.body)).toEqual([
      "朝のメモ #タグ\n続きの行",
      "三つ目 #a #b",
    ]);
    expect(w44.entries.map((entry) => entry.at)).toEqual([
      "2026-10-26T09:32:00+09:00",
      "2026-10-26T11:00:00+09:00",
    ]);
    expect(new Set(w44.entries.map((entry) => entry.id)).size).toBe(2);
  });

  it("同じ旧ファイルの再変換をスキップし、二重に取り込まない", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const service = serviceFor(vault);
    await service.convert(["Old/Memos/2026-10.md"]);

    const second = await service.convert(["Old/Memos/2026-10.md"]);
    expect(second.summary.converted).toBe(0);
    expect(second.summary.skipped).toBe(1);
    expect(weekly(vault, WEEK_44).entries).toHaveLength(2);

    const third = await service.convert(["Old/Memos/2026-10.md"], {
      alreadyConverted: "convert",
    });
    expect(third.summary.skipped).toBe(1);
    expect(weekly(vault, WEEK_44).entries).toHaveLength(2);

    const records = parseMigrationLog(vault.files.get(LOG_PATH) ?? "");
    expect(
      records.filter(
        (record) =>
          record.sourcePath === "Old/Memos/2026-10.md" &&
          record.result === "converted"
      )
    ).toHaveLength(1);
  });

  it("内容が変わった旧ファイルは明示指定で差分だけ追加する", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const service = serviceFor(vault);
    await service.convert(["Old/Memos/2026-10.md"]);

    vault.files.set(
      "Old/Memos/2026-10.md",
      `${MONTHLY_NOTE}- 12:00 追加メモ #new\n`
    );
    const report = await service.convert(["Old/Memos/2026-10.md"], {
      alreadyConverted: "convert",
    });
    expect(report.summary.converted).toBe(1);
    const w44 = weekly(vault, WEEK_44);
    expect(w44.entries.map((entry) => entry.body)).toEqual([
      "朝のメモ #タグ\n続きの行",
      "三つ目 #a #b",
      "追加メモ #new",
    ]);
    expect(new Set(w44.entries.map((entry) => entry.id)).size).toBe(3);
  });

  it("inbox は既定で review にせず、明示選択の項目だけ review を付ける", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Inbox.md", INBOX_NOTE);
    vault.files.set("Old/Inbox2.md", INBOX_NOTE);
    const service = serviceFor(vault);

    const scan = await service.scan();
    expect(candidateAt(scan, "Old/Inbox.md").reviewSelectable).toBe(true);

    await service.convert(["Old/Inbox.md"]);
    const plain = vault.files.get("Seiton/Notes/Inbox.md") ?? "";
    expect(frontmatterField(plain, "kind")).toBe("note");
    expect(frontmatterField(plain, "review")).toBeNull();

    const selected = await service.convert(["Old/Inbox2.md"], {
      reviewPaths: ["Old/Inbox2.md"],
    });
    expect(selected.summary.converted).toBe(1);
    const reviewed = vault.files.get("Seiton/Notes/Inbox2.md") ?? "";
    expect(frontmatterField(reviewed, "review")).toBe("true");
  });

  it("既存の新形式ノートは上書きせず、別名へコピーする", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Book.md", BOOK_NOTE);
    const existing = "---\nkind: note\ntitle: 既存\n---\n\n別のノート\n";
    vault.files.set("Seiton/Notes/Book.md", existing);
    const service = serviceFor(vault);

    const report = await service.convert(["Old/Book.md"]);
    expect(report.summary.converted).toBe(1);
    expect(vault.files.get("Seiton/Notes/Book.md")).toBe(existing);

    const target = report.results[0]?.targetPaths[0] ?? "";
    expect(target).toMatch(/^Seiton\/Notes\/Book-[0-9a-f]{8}\.md$/u);
    expect(vault.files.has(target)).toBe(true);
    expect(vault.files.get("Old/Book.md")).toBe(BOOK_NOTE);
  });

  it("元ファイルと同じパスへは書き込まない", async () => {
    const vault = new MemoryVault();
    const source = "---\ntype: note\n---\n\n旧ノート\n";
    vault.files.set("Seiton/Notes/Legacy.md", source);
    const service = serviceFor(vault);

    const report = await service.convert(["Seiton/Notes/Legacy.md"]);
    expect(report.summary.converted).toBe(1);
    expect(vault.files.get("Seiton/Notes/Legacy.md")).toBe(source);
    expect(report.results[0]?.targetPaths[0]).not.toBe(
      "Seiton/Notes/Legacy.md"
    );
  });

  it("週次ファイルが別形式なら追記せず、他の週も作らない", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const foreign = "---\nkind: note\nweek: 2026-W44\n---\n\n別物\n";
    vault.files.set(WEEK_44, foreign);
    const service = serviceFor(vault);

    const scan = await service.scan();
    expect(candidateAt(scan, "Old/Memos/2026-10.md").targetState).toBe(
      "blocked"
    );

    const report = await service.convert(["Old/Memos/2026-10.md"]);
    expect(report.summary.failed).toBe(1);
    expect(vault.files.get(WEEK_44)).toBe(foreign);
    expect(vault.files.has(WEEK_43)).toBe(false);
    expect(vault.files.get("Old/Memos/2026-10.md")).toBe(MONTHLY_NOTE);
    expect(report.results[0]?.message).toContain("追記できません");
  });

  it("既存の週次メモの内容を変えずに追記する", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const existing = `---
kind: memo-log
week: 2026-W44
created: "2026-10-26T08:00:00+09:00"
---

## 2026-10-26

<!-- seiton:memo:start id="m_EXISTING" at="2026-10-26T08:00:00+09:00" state="active" v="1" -->
既存メモ
<!-- seiton:memo:end -->
`;
    vault.files.set(WEEK_44, existing);
    const service = serviceFor(vault);

    const report = await service.convert(["Old/Memos/2026-10.md"]);
    expect(report.summary.converted).toBe(1);
    const content = vault.files.get(WEEK_44) ?? "";
    expect(content.startsWith(existing)).toBe(true);
    const parsed = parseMemoLog(content);
    expect(parsed.entries.map((entry) => entry.body)).toEqual([
      "既存メモ",
      "朝のメモ #タグ\n続きの行",
      "三つ目 #a #b",
    ]);
    expect(parsed.entries[0]?.id).toBe("m_EXISTING");
  });

  it("追記に失敗しても元ファイルを残し、再試行で重複しない", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    vault.files.set(WEEK_44, "---\nkind: memo-log\nweek: 2026-W44\n---\n");
    vault.failNextProcessPath = WEEK_44;
    const service = serviceFor(vault);

    const first = await service.convert(["Old/Memos/2026-10.md"]);
    expect(first.summary.failed).toBe(1);
    expect(first.results[0]?.message).toContain("追記に失敗");
    expect(vault.files.get("Old/Memos/2026-10.md")).toBe(MONTHLY_NOTE);
    expect(weekly(vault, WEEK_43).entries).toHaveLength(1);

    const retried = await service.convert(["Old/Memos/2026-10.md"]);
    expect(retried.summary.converted).toBe(1);
    expect(weekly(vault, WEEK_43).entries).toHaveLength(1);
    expect(weekly(vault, WEEK_44).entries).toHaveLength(2);
    expect(new Set(weekly(vault, WEEK_44).entries.map((e) => e.id)).size).toBe(
      2
    );

    const results = parseMigrationLog(vault.files.get(LOG_PATH) ?? "").map(
      (record) => record.result
    );
    expect(results).toEqual(["failed", "converted"]);
  });

  it("変換ログが消えても migration_source で二重作成を避ける", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Book.md", BOOK_NOTE);
    const service = serviceFor(vault);
    await service.convert(["Old/Book.md"]);
    vault.files.delete(LOG_PATH);

    const again = await service.convert(["Old/Book.md"]);
    expect(again.summary.skipped).toBe(1);
    const notes = [...vault.files.keys()].filter((path) =>
      path.startsWith("Seiton/Notes/")
    );
    expect(notes).toEqual(["Seiton/Notes/Book.md"]);
  });

  it("変換ログが消えても同じ月次メモを二重に追記しない", async () => {
    const vault = new MemoryVault();
    vault.files.set("Old/Memos/2026-10.md", MONTHLY_NOTE);
    const service = serviceFor(vault);
    await service.convert(["Old/Memos/2026-10.md"]);
    vault.files.delete(LOG_PATH);

    const again = await service.convert(["Old/Memos/2026-10.md"]);
    expect(again.summary.skipped).toBe(1);
    expect(weekly(vault, WEEK_43).entries).toHaveLength(1);
    expect(weekly(vault, WEEK_44).entries).toHaveLength(2);
  });

  it("壊れた frontmatter や未知データを破壊しない", async () => {
    const vault = new MemoryVault();
    const broken = "---\ntype: note\n";
    vault.files.set("Old/Broken.md", broken);
    const service = serviceFor(vault);

    const scan = await service.scan();
    expect(scan.candidates).toHaveLength(0);
    expect(scan.summary.unsupported).toBe(1);

    const report = await service.convert(["Old/Broken.md"]);
    expect(report.summary.failed).toBe(1);
    expect(report.results[0]?.message).toContain("終端");
    expect(vault.files.get("Old/Broken.md")).toBe(broken);
    expect(
      [...vault.files.keys()].filter((path) => path.startsWith("Seiton/Notes/"))
    ).toEqual([]);
    expect(
      [...vault.files.keys()].filter((path) =>
        path.startsWith("Seiton/System/Logs/")
      )
    ).toEqual([]);
  });

  it("既に新形式のファイルや対象外のファイルは変換しない", async () => {
    const vault = new MemoryVault();
    const newFormat = "---\nkind: note\n---\n\n新形式\n";
    vault.files.set("Seiton/Notes/New.md", newFormat);
    const service = serviceFor(vault);

    const report = await service.convert(["Seiton/Notes/New.md"]);
    expect(report.summary.failed).toBe(1);
    expect(vault.files.get("Seiton/Notes/New.md")).toBe(newFormat);
  });

  it("空の選択では何も書き込まない", async () => {
    const vault = new MemoryVault();
    const service = serviceFor(vault);
    const report = await service.convert([]);
    expect(report.summary).toEqual({ converted: 0, failed: 0, skipped: 0 });
    expect(vault.writes).toEqual([]);
  });
});
