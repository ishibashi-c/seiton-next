import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  type SeitonSettings,
} from "../src/services/settings";

describe("normalizeSettings shortcuts", () => {
  it("trims values, drops empty entries and fills ids", () => {
    const settings = normalizeSettings({
      shortcuts: [
        {
          folderId: null,
          id: "",
          label: " GitHub ",
          target: " https://github.com ",
        },
        {
          folderId: null,
          id: "s_keep",
          label: "",
          target: "https://example.com",
        },
        null as never,
      ],
    });

    expect(settings.shortcuts).toHaveLength(1);
    expect(settings.shortcuts[0]?.folderId).toBeNull();
    expect(settings.shortcuts[0]?.label).toBe("GitHub");
    expect(settings.shortcuts[0]?.target).toBe("https://github.com");
    expect(settings.shortcuts[0]?.id).not.toBe("");
  });

  it("keeps existing ids and makes duplicates unique", () => {
    const settings = normalizeSettings({
      shortcuts: [
        { folderId: null, id: "same", label: "A", target: "https://a.example" },
        { folderId: null, id: "same", label: "B", target: "https://b.example" },
      ],
    });

    expect(settings.shortcuts[0]?.id).toBe("same");
    expect(settings.shortcuts[1]?.id).not.toBe("same");
  });

  it("defaults favicons off and caps the list", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      folderId: null,
      id: `s_${index}`,
      label: `L${index}`,
      target: `https://example.com/${index}`,
    }));
    const settings = normalizeSettings({ shortcuts: many });

    expect(settings.shortcutFavicons).toBe(false);
    expect(settings.shortcuts).toHaveLength(24);
  });
});

describe("normalizeSettings shortcut folders", () => {
  it("keeps folders and assigns their shortcuts", () => {
    const settings = normalizeSettings({
      shortcutFolders: [{ id: "f_work", name: " 仕事 " }],
      shortcuts: [
        {
          folderId: "f_work",
          id: "s1",
          label: "Docs",
          target: "https://docs.example",
        },
        {
          folderId: "f_missing",
          id: "s2",
          label: "Home",
          target: "[[Welcome]]",
        },
      ],
    });

    expect(settings.shortcutFolders).toEqual([{ id: "f_work", name: "仕事" }]);
    expect(settings.shortcuts[0]?.folderId).toBe("f_work");
    expect(settings.shortcuts[1]?.folderId).toBeNull();
  });

  it("drops empty folders and caps them", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `f_${index}`,
      name: `F${index}`,
    }));
    const settings = normalizeSettings({ shortcutFolders: many });

    expect(settings.shortcutFolders).toHaveLength(16);
    expect(
      normalizeSettings({ shortcutFolders: [{ id: "", name: " " }] })
        .shortcutFolders
    ).toEqual([]);
  });
});

describe("normalizeSettings Google Books", () => {
  it("APIキーをtrimし、未設定なら空文字にする", () => {
    expect(
      normalizeSettings({ googleBooksApiKey: "  key  " }).googleBooksApiKey
    ).toBe("key");
    expect(normalizeSettings({}).googleBooksApiKey).toBe("");
  });
});

describe("normalizeSettings calilLastResults", () => {
  it("keeps valid entries, fills defaults and sorts by checkedAt", () => {
    const settings = normalizeSettings({
      calilLastResults: {
        "": { checkedAt: "2026-10-29T05:00:00+09:00" },
        "9784101010014": { checkedAt: "2026-10-29T05:00:00+09:00" },
        "9784873119243": {
          checkedAt: "2026-10-28T05:00:00+09:00",
          configuredHits: 2,
          library: "東京都立",
          title: "本A",
          totalLibraries: 5,
        },
      },
    } as unknown as Partial<SeitonSettings>);

    expect(Object.keys(settings.calilLastResults)).toEqual([
      "9784101010014",
      "9784873119243",
    ]);
    expect(settings.calilLastResults["9784101010014"]).toEqual({
      checkedAt: "2026-10-29T05:00:00+09:00",
      configuredHits: 0,
      library: "",
      title: "",
      totalLibraries: 0,
    });
  });

  it("caps at 500 entries", () => {
    const many = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [
        `isbn-${index}`,
        {
          checkedAt: `2026-10-${String((index % 28) + 1).padStart(2, "0")}T00:00:00+09:00`,
        },
      ])
    );
    const settings = normalizeSettings({
      calilLastResults: many,
    } as unknown as Partial<SeitonSettings>);

    expect(Object.keys(settings.calilLastResults)).toHaveLength(500);
  });
});

describe("normalizeSettings academic / courses", () => {
  it("defaults grade to 3年 and term to 後期", () => {
    const settings = normalizeSettings({});
    expect(settings.currentGrade).toBe("3年");
    expect(settings.currentTerm).toBe("後期");
    expect(settings.courses).toEqual([]);
  });

  it("normalizes valid grades and terms, fallbacks invalid ones", () => {
    const valid = normalizeSettings({
      currentGrade: "2年",
      currentTerm: "前期",
    });
    expect(valid.currentGrade).toBe("2年");
    expect(valid.currentTerm).toBe("前期");

    const invalid = normalizeSettings({
      currentGrade: "5年" as never,
      currentTerm: "春学期" as never,
    });
    expect(invalid.currentGrade).toBe("3年");
    expect(invalid.currentTerm).toBe("後期");
  });

  it("normalizes courses and drops empty names", () => {
    const settings = normalizeSettings({
      courses: [
        {
          dayOfWeek: " 月 ",
          grade: "3年",
          id: "",
          name: " 認知科学 ",
          period: " 2限 ",
          term: "後期",
        },
        {
          grade: "1年",
          id: "c_keep",
          name: "",
          term: "前期",
        },
      ],
    });

    expect(settings.courses).toHaveLength(1);
    expect(settings.courses[0]).toEqual({
      dayOfWeek: "月",
      grade: "3年",
      id: expect.any(String),
      name: "認知科学",
      period: "2限",
      term: "後期",
    });
    expect(settings.courses[0]?.id).not.toBe("");
  });

  it("caps courses at 60 entries", () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      grade: "2年" as const,
      id: `c_${index}`,
      name: `科目${index}`,
      term: "前期" as const,
    }));
    const settings = normalizeSettings({ courses: many });
    expect(settings.courses).toHaveLength(60);
  });
});
