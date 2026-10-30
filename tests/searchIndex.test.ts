import { describe, expect, it } from "vitest";
import {
  allCourses,
  type NoteRecord,
  searchIndex,
  type VaultIndex,
} from "../src/services/vaultIndex";

function note(overrides: Partial<NoteRecord>): NoteRecord {
  return {
    archived: false,
    basename: "note",
    book: {},
    course: "",
    cover: "",
    created: "",
    excerpt: "",
    frontmatter: {},
    kind: "note",
    lists: [],
    mtime: 1,
    path: "Seiton/Notes/note.md",
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

const index: VaultIndex = {
  builtAt: 1,
  memos: [
    {
      at: "2026-10-26T09:00:00+09:00",
      body: "今日のアイデア",
      entryId: "m_1",
      line: 5,
      path: "Seiton/System/Logs/Memos/2026-W44.md",
      promotedTo: null,
      state: "active",
      title: "今日のアイデア",
      type: "memo",
      week: "2026-W44",
    },
    {
      at: "2026-10-25T09:00:00+09:00",
      body: "削除済み",
      entryId: "m_2",
      line: 9,
      path: "Seiton/System/Logs/Memos/2026-W43.md",
      promotedTo: null,
      state: "deleted",
      title: "削除済み",
      type: "memo",
      week: "2026-W43",
    },
  ],
  notes: [
    note({
      kind: "idea",
      path: "Seiton/Notes/idea.md",
      projects: ["seiton"],
      searchText: "本文にプロンプトの話",
      tags: ["設計"],
      title: "保存方式のアイデア",
    }),
    note({
      kind: "webclip",
      path: "Seiton/Notes/clip.md",
      review: true,
      searchText: "クリップ本文",
      source: "https://example.com",
      title: "記事",
    }),
  ],
  problems: [],
  prompts: [
    {
      at: "2026-10-26T10:00:00+09:00",
      body: "カードを分けてください",
      entryId: "p_1",
      line: 12,
      path: "Seiton/System/Logs/Prompts/2026-10-26-ui.md",
      project: "Seiton",
      projectKey: "seiton",
      projectKeys: ["seiton"],
      sessionState: "open",
      title: "UI",
      type: "prompt",
    },
  ],
};

describe("横断検索", () => {
  it("ノート・メモ・プロンプトを索引から検索する", () => {
    expect(searchIndex(index, "保存方式").map((hit) => hit.item.type)).toEqual([
      "note",
    ]);
    expect(
      searchIndex(index, "アイデア").map((hit) => hit.item.type)
    ).toContain("memo");
    expect(searchIndex(index, "カード").map((hit) => hit.item.type)).toEqual([
      "prompt",
    ]);
  });

  it("削除済みメモを既定で除外する", () => {
    expect(
      searchIndex(index, "削除済み").some(
        (hit) => hit.item.type === "memo" && hit.item.entryId === "m_2"
      )
    ).toBe(false);
    expect(
      searchIndex(index, "削除済み", { includeDeleted: true }).some(
        (hit) => hit.item.type === "memo" && hit.item.entryId === "m_2"
      )
    ).toBe(true);
  });

  it("種類・タグ・プロジェクト・状態で絞り込む", () => {
    expect(
      searchIndex(index, "", { kinds: ["webclip"] }).map(
        (hit) => hit.item.type === "note" && hit.item.path
      )
    ).toEqual(["Seiton/Notes/clip.md"]);
    expect(
      searchIndex(index, "", { tags: ["設計"] }).map((hit) => hit.item.type)
    ).toEqual(["note"]);
    expect(
      searchIndex(index, "", { project: "seiton" })
        .map((hit) => hit.item.type)
        .sort()
    ).toEqual(["note", "prompt"]);
    expect(
      searchIndex(index, "", { status: "review" }).map((hit) => hit.item.type)
    ).toEqual(["note"]);
  });

  it("結果上限を守る", () => {
    expect(searchIndex(index, "", { limit: 1 })).toHaveLength(1);
  });
});

describe("アーカイブの扱い", () => {
  it("通常一覧ではアーカイブを除外し、アーカイブ条件では表示する", () => {
    const archived = note({
      archived: true,
      path: "Seiton/Notes/archived.md",
      title: "アーカイブ済み",
    });
    const withArchived: VaultIndex = {
      ...index,
      memos: [],
      notes: [archived],
      prompts: [],
    };
    expect(searchIndex(withArchived, "")).toHaveLength(0);
    expect(searchIndex(withArchived, "", { status: "archived" })).toHaveLength(
      1
    );
    expect(
      searchIndex(withArchived, "", { includeArchived: true })
    ).toHaveLength(1);
  });
});

describe("科目と検索順", () => {
  const courseIndex: VaultIndex = {
    ...index,
    memos: [],
    notes: [
      note({
        basename: "20260513",
        course: "社会デザイン概論",
        kind: "class",
        mtime: 100,
        path: "Seiton/Notes/20260513.md",
        searchText: "本文だけの一致",
        title: "20260513",
      }),
      note({
        basename: "20260512",
        course: "感性学概論",
        kind: "class",
        mtime: 200,
        path: "Seiton/Notes/20260512.md",
        searchText: "保存方式についての本文",
        title: "保存方式",
      }),
      note({
        basename: "0518_コンピュータ実習1",
        course: "その他",
        kind: "class",
        mtime: 300,
        path: "Seiton/Notes/0518_コンピュータ実習1.md",
        title: "0518_コンピュータ実習1",
      }),
    ],
    prompts: [],
  };

  it("course Propertyで絞り込み、その他を未設定と区別する", () => {
    expect(
      searchIndex(courseIndex, "", { course: "社会デザイン概論" }).map(
        (hit) => hit.item.type === "note" && hit.item.path
      )
    ).toEqual(["Seiton/Notes/20260513.md"]);
    expect(searchIndex(courseIndex, "", { course: "その他" })).toHaveLength(1);
    expect(allCourses(courseIndex)).toEqual(
      expect.arrayContaining(["その他", "感性学概論", "社会デザイン概論"])
    );
  });

  it("検索語があるときはタイトル完全一致を本文一致より先にする", () => {
    expect(searchIndex(courseIndex, "保存方式")[0]?.item.title).toBe(
      "保存方式"
    );
  });
});
