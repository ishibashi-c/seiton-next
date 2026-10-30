import { describe, expect, it } from "vitest";
import {
  type LibraryQueryState,
  queryHits,
} from "../src/platform/library/query";
import type {
  MemoIndexItem,
  NoteRecord,
  VaultIndex,
} from "../src/services/vaultIndex";

function note(overrides: Partial<NoteRecord>): NoteRecord {
  return {
    archived: false,
    basename: "note",
    book: {},
    course: "",
    cover: "",
    created: "2026-01-01T00:00:00+09:00",
    excerpt: "",
    frontmatter: {},
    kind: "note",
    lists: [],
    mtime: 1,
    path: "note.md",
    pinned: false,
    projects: [],
    review: false,
    searchText: "",
    source: "",
    tags: [],
    title: "note",
    type: "note",
    ...overrides,
  };
}

function memo(body: string, at: string): MemoIndexItem {
  return {
    at,
    body,
    entryId: "m_1",
    line: 1,
    path: "Seiton/System/Logs/Memos/2026-W44.md",
    promotedTo: null,
    state: "active",
    title: body,
    type: "memo",
    week: "2026-W44",
  };
}

const state: LibraryQueryState = {
  courseFilter: "",
  filter: "all",
  listFilter: "",
  projectFilter: "",
  query: "",
  sort: "updated",
  tagFilter: "",
};

describe("library query", () => {
  const oldNote = note({
    created: "2026-01-01T00:00:00+09:00",
    mtime: 10,
    path: "old.md",
    searchText: "古いノート",
    title: "古いノート",
  });
  const newNote = note({
    created: "2026-02-01T00:00:00+09:00",
    mtime: 20,
    path: "new.md",
    searchText: "新しいノート",
    title: "新しいノート",
  });
  const memoItem = memo("今日のメモ", "2026-02-02T09:00:00+09:00");
  const index: VaultIndex = {
    builtAt: 0,
    memos: [memoItem],
    notes: [oldNote, newNote],
    problems: [],
    prompts: [],
  };

  it("メモだけに絞り込む", () => {
    expect(queryHits(index, { ...state, filter: "memo" }, 200)).toEqual([
      memoItem,
    ]);
  });

  it("検索語に一致するノートを返す", () => {
    expect(queryHits(index, { ...state, query: "新しい" }, 200)).toEqual([
      newNote,
    ]);
  });

  it("作成日時の並びを切り替える", () => {
    const hits = queryHits(
      index,
      { ...state, filter: "other", sort: "created" },
      200
    );
    expect(hits[0]).toBe(newNote);
    expect(hits[1]).toBe(oldNote);
  });
});
