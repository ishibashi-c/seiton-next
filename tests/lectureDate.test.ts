import { describe, expect, it } from "vitest";
import { frontmatterField } from "../src/domain/frontmatter";
import {
  lectureDateFromBasename,
  normalizeLectureDate,
} from "../src/domain/lectureDate";
import { buildNoteDocument, classNotePath } from "../src/domain/noteTemplates";

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
});
