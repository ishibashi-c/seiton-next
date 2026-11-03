import { describe, expect, it } from "vitest";
import {
  dayLabel,
  filterMemos,
  groupMemos,
  memoMeta,
  monthLabel,
  tagEntries,
  visibleMemos,
} from "../src/platform/tsubuyaki/timeline";
import type { MemoListItem } from "../src/services/memoService";

function memo(
  id: string,
  at: string,
  body: string,
  state: "active" | "deleted" | "promoted" = "active"
): MemoListItem {
  return {
    entry: {
      at,
      attributes: {},
      body,
      deletedAt: state === "deleted" ? at : null,
      endLine: 1,
      endOffset: 0,
      eol: "\n",
      id,
      promotedTo: null,
      startLine: 0,
      startOffset: 0,
      state,
    },
    path: "Seiton/System/Logs/Memos/2026-W44.md",
    week: "2026-W44",
  };
}

const items = [
  memo("m1", "2026-08-14T20:08:00+09:00", "今日のメモ #読書"),
  memo("m2", "2026-08-14T09:00:00+09:00", "同じ日のメモ"),
  memo("m3", "2026-08-12T12:00:00+09:00", "別の日のメモ #読書"),
  memo("m4", "2026-07-01T10:00:00+09:00", "先月のメモ"),
  memo("m5", "2026-08-13T10:00:00+09:00", "削除済み", "deleted"),
];

describe("tsubuyaki timeline", () => {
  it("削除済みを既定で除き、指定すると含める", () => {
    expect(visibleMemos(items, false).map((item) => item.entry.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(visibleMemos(items, true)).toHaveLength(5);
  });

  it("検索語とタグで絞り込む", () => {
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "別の日",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m3"]);
    expect(
      filterMemos(items, {
        activeTag: "読書",
        query: "",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m3"]);
  });

  it("期間で絞り込む（今日・今週・今月）", () => {
    const fixedNow = new Date("2026-08-14T23:00:00+09:00");
    // 今日
    expect(
      filterMemos(items, {
        activeTag: "",
        now: fixedNow,
        period: "today",
        query: "",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2"]);

    // 今週 (2026-W33: 8/10〜8/16)
    expect(
      filterMemos(items, {
        activeTag: "",
        now: fixedNow,
        period: "week",
        query: "",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2", "m3"]);

    // 今月 (2026-08)
    expect(
      filterMemos(items, {
        activeTag: "",
        now: fixedNow,
        period: "month",
        query: "",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("カレンダー選択日（特定日・特定月）で絞り込む", () => {
    // 特定の日 "2026-08-12"
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        selectedDate: "2026-08-12",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m3"]);

    // 特定の月 "2026-07"
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        selectedDate: "2026-07",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m4"]);
  });

  it("指定した日付範囲（開始日〜終了日）で絞り込む", () => {
    // 2026-08-12 から 2026-08-14
    expect(
      filterMemos(items, {
        activeTag: "",
        endDate: "2026-08-14",
        query: "",
        showDeleted: false,
        startDate: "2026-08-12",
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2", "m3"]);

    // 2026-07-01 から 2026-08-12
    expect(
      filterMemos(items, {
        activeTag: "",
        endDate: "2026-08-12",
        query: "",
        showDeleted: false,
        startDate: "2026-07-01",
      }).map((item) => item.entry.id)
    ).toEqual(["m3", "m4"]);

    // 開始日のみ指定 (2026-08-13 以降)
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        showDeleted: false,
        startDate: "2026-08-13",
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2"]);

    // 終了日のみ指定 (2026-08-12 以前)
    expect(
      filterMemos(items, {
        activeTag: "",
        endDate: "2026-08-12",
        query: "",
        showDeleted: false,
      }).map((item) => item.entry.id)
    ).toEqual(["m3", "m4"]);
  });

  it("状態で絞り込む（未整理・削除済み）", () => {
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        showDeleted: false,
        status: "active",
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2", "m3", "m4"]);

    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        showDeleted: true,
        status: "deleted",
      }).map((item) => item.entry.id)
    ).toEqual(["m5"]);
  });

  it("新しい順と古い順で並び替える", () => {
    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        showDeleted: false,
        sort: "newest",
      }).map((item) => item.entry.id)
    ).toEqual(["m1", "m2", "m3", "m4"]);

    expect(
      filterMemos(items, {
        activeTag: "",
        query: "",
        showDeleted: false,
        sort: "oldest",
      }).map((item) => item.entry.id)
    ).toEqual(["m4", "m3", "m2", "m1"]);
  });

  it("月と日の順序を保ち、件数を数える", () => {
    const groups = groupMemos(visibleMemos(items, false), 60);
    expect(groups.map((group) => group.key)).toEqual(["2026-08", "2026-07"]);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.days.map((day) => day.key)).toEqual([
      "2026-08-14",
      "2026-08-12",
    ]);
    expect(groups[0]?.days[0]?.count).toBe(2);
    expect(groups[1]?.days[0]?.count).toBe(1);
  });

  it("表示件数の上限を適用する", () => {
    const groups = groupMemos(visibleMemos(items, false), 2);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.days[0]?.items.map((item) => item.entry.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("メタ情報の件数と期間を返す", () => {
    expect(memoMeta(items, false)).toEqual({
      deleted: 1,
      range: "2026年7月1日から8月14日",
      visible: 4,
    });
  });

  it("タグを件数順にまとめる", () => {
    expect(tagEntries(items).slice(0, 2)).toEqual([
      { count: 2, key: "読書", label: "読書" },
    ]);
  });

  it("日付ラベルを保つ", () => {
    expect(dayLabel("2026-08-14")).toBe("8月14日（金）");
    expect(monthLabel("2026-08")).toBe("2026年8月");
    expect(monthLabel("unknown")).toBe("日時不明");
  });
});
