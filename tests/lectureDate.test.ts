import { describe, expect, it } from "vitest";
import { frontmatterField } from "../src/domain/frontmatter";
import {
  lectureDateFromBasename,
  normalizeLectureDate,
} from "../src/domain/lectureDate";
import {
  buildNoteDocument,
  classExtraNotePath,
  classNotePath,
} from "../src/domain/noteTemplates";

describe("講義日", () => {
  it("既存ファイル名の日付形式を読む", () => {
    expect(lectureDateFromBasename("20260513")).toBe("2026-05-13");
    expect(lectureDateFromBasename("20260527 社会デザイン概論")).toBe(
      "2026-05-27"
    );
    expect(lectureDateFromBasename("0518_コンピュータ実習1", 2026)).toBe(
      "2026-05-18"
    );
    expect(lectureDateFromBasename("オンデマンド_01", 2026)).toBe("");
  });

  it("lecture_dateを正規化する", () => {
    expect(normalizeLectureDate("2026-05-13")).toBe("2026-05-13");
    expect(normalizeLectureDate("2026-05-13T00:00:00+09:00")).toBe(
      "2026-05-13"
    );
    expect(normalizeLectureDate("")).toBe("");
    expect(normalizeLectureDate("not-a-date")).toBe("");
  });
});

describe("授業ノートの生成", () => {
  it("同日・別科目を区別するファイル名を作る", () => {
    expect(classNotePath("2026-05-13", "社会デザイン概論")).toBe(
      "Seiton/Notes/2026-05-13 社会デザイン概論.md"
    );
    expect(classNotePath("2026-05-13", "感性学概論")).toBe(
      "Seiton/Notes/2026-05-13 感性学概論.md"
    );
  });

  it("lecture_dateとcreatedを分けて保存し、タグを自動付与しない", () => {
    const document = buildNoteDocument({
      body: "## 授業メモ\n",
      course: "社会デザイン概論",
      createdAt: "2026-05-13T10:00:00+09:00",
      kind: "class",
      lectureDate: "2026-05-13",
      title: "2026-05-13 社会デザイン概論",
    });
    expect(frontmatterField(document, "lecture_date")).toBe("2026-05-13");
    expect(frontmatterField(document, "created")).toBe(
      "2026-05-13T10:00:00+09:00"
    );
    expect(frontmatterField(document, "course")).toBe("社会デザイン概論");
    expect(document).not.toContain("tags:");
  });

  it("session と class_note_type=extra と授業外パスを生成する", () => {
    expect(classExtraNotePath("2026-11-19", "科学・技術と社会", "宿題")).toBe(
      "Seiton/Notes/2026-11-19 科学・技術と社会 宿題.md"
    );
    expect(classExtraNotePath("2026-11-19", "現代の社会論", "")).toBe(
      "Seiton/Notes/2026-11-19 現代の社会論 授業外.md"
    );

    const lectureDoc = buildNoteDocument({
      body: "",
      classNoteType: "lecture",
      course: "表象文化論",
      createdAt: "2026-11-24T10:40:00+09:00",
      grade: "1年",
      kind: "class",
      lectureDate: "2026-11-24",
      pinned: true,
      session: 8,
      term: "後期",
      title: "2026-11-24 表象文化論",
    });
    expect(frontmatterField(lectureDoc, "session")).toBe("8");
    expect(frontmatterField(lectureDoc, "class_note_type")).toBeNull();

    const extraDoc = buildNoteDocument({
      body: "",
      classNoteType: "extra",
      course: "科学・技術と社会",
      createdAt: "2026-11-19T18:00:00+09:00",
      grade: "1年",
      kind: "class",
      lectureDate: "2026-11-19",
      pinned: true,
      session: 9,
      term: "後期",
      title: "2026-11-19 科学・技術と社会 宿題",
    });
    expect(frontmatterField(extraDoc, "class_note_type")).toBe("extra");
    expect(frontmatterField(extraDoc, "session")).toBeNull();
  });
});
