import { describe, expect, it } from "vitest";
import {
  appendMemoEntry,
  assertMemoAppendable,
  createMemoLogDocument,
  findMemoEntry,
  formatMemoEntry,
  MEMO_END_MARKER,
  MEMO_ESCAPE_MARKER,
  parseMemoLog,
  updateMemoEntry,
} from "../src/domain/memoLog";

const WEEK = "2026-W44";
const AT = "2026-10-26T09:32:00+09:00";

function baseDocument(): string {
  return createMemoLogDocument(WEEK, "2026-10-26T09:00:00+09:00");
}

function entryText(
  id: string,
  body: string,
  at = AT,
  state = "active"
): string {
  return formatMemoEntry({ at, body, id, state });
}

function documentWith(...entries: string[]): string {
  return `${baseDocument()}## 2026-10-26\n\n${entries.join("\n\n")}\n`;
}

describe("週次メモのファイル文法", () => {
  it("例示形式を解析できる", () => {
    const parsed = parseMemoLog(
      documentWith(
        entryText("m_01JABC", "ふと思ったこと。\n複数行も許容する。")
      )
    );
    expect(parsed.frontmatter.fields).toEqual({
      created: "2026-10-26T09:00:00+09:00",
      kind: "memo-log",
      week: WEEK,
    });
    expect(parsed.entries).toHaveLength(1);
    const entry = parsed.entries[0];
    expect(entry?.id).toBe("m_01JABC");
    expect(entry?.at).toBe(AT);
    expect(entry?.state).toBe("active");
    expect(entry?.body).toBe("ふと思ったこと。\n複数行も許容する。");
    expect(parsed.eol).toBe("\n");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("既存の未知frontmatter・本文・リンクを追記後も保持する", () => {
    const custom = [
      "---",
      "kind: memo-log",
      "week: 2026-W44",
      'created: "2026-10-26T09:00:00+09:00"',
      "aliases:",
      "  - 今週のメモ",
      "custom_key: keep-me",
      "---",
      "",
      "## 2026-10-26",
      "",
      "手で書いたメモ [[既存リンク]]",
      "",
      entryText("m_01OLD", "既存本文"),
      "",
    ].join("\n");
    const next = appendMemoEntry(custom, {
      at: AT,
      body: "追加本文",
      id: "m_01NEW",
    });
    expect(next).toContain("aliases:\n  - 今週のメモ");
    expect(next).toContain("custom_key: keep-me");
    expect(next).toContain("手で書いたメモ [[既存リンク]]");
    expect(next).toContain("既存本文");
    expect(next).toContain("追加本文");
    const parsed = parseMemoLog(next);
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      "m_01OLD",
      "m_01NEW",
    ]);
  });

  it("予約マーカーを含む本文をエスケープして完全に復元する", () => {
    const body = [
      "1行目",
      MEMO_END_MARKER,
      MEMO_ESCAPE_MARKER,
      '<!-- seiton:memo:start id="fake" at="2026-10-26T09:33:00+09:00" -->',
      "```ts",
      "const x = 1;",
      "```",
      "<!-- 普通のHTMLコメント -->",
    ].join("\n");
    const text = entryText("m_01BODY", body);
    expect(text).toContain(MEMO_ESCAPE_MARKER);
    const parsed = parseMemoLog(documentWith(text));
    expect(parsed.entries[0]?.body).toBe(body);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries[0]?.endOffset).toBeGreaterThan(
      parsed.entries[0]?.startOffset ?? 0
    );
  });

  it("CRLFを保ったまま追記・編集できる", () => {
    const eol = "\r\n";
    const content = `${createMemoLogDocument(WEEK, "2026-10-26T09:00:00+09:00", eol)}## 2026-10-26${eol}${eol}${formatMemoEntry(
      { at: AT, body: "CRLF本文", id: "m_01CRLF" },
      { eol }
    )}${eol}`;
    expect(content).toContain("\r\n");
    const parsed = parseMemoLog(content);
    expect(parsed.entries[0]?.body).toBe("CRLF本文");
    expect(parsed.eol).toBe("\r\n");

    const updated = updateMemoEntry(content, "m_01CRLF", {
      body: "更新後\n2行目",
    });
    expect(updated.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(parseMemoLog(updated).entries[0]?.body).toBe("更新後\n2行目");
  });

  it("終了マーカーのない項目がある文書には追記しない", () => {
    const broken = `${baseDocument()}## 2026-10-26\n\n<!-- seiton:memo:start id="m_BROKEN" at="${AT}" -->\n本文\n`;
    const parsed = parseMemoLog(broken);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.diagnostics[0]?.code).toBe("unclosed-entry");
    expect(() =>
      appendMemoEntry(broken, { at: AT, body: "追加", id: "m_NEW" })
    ).toThrow(/安全に追記できない/u);
    expect(() => updateMemoEntry(broken, "m_BROKEN", { body: "変更" })).toThrow(
      /安全に更新できない/u
    );
  });

  it("重複IDは解析できても更新を拒否する", () => {
    const duplicate = documentWith(
      entryText("m_SAME", "1件目"),
      entryText("m_SAME", "2件目")
    );
    const parsed = parseMemoLog(duplicate);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.diagnostics.some((d) => d.code === "duplicate-id")).toBe(
      true
    );
    expect(() =>
      updateMemoEntry(duplicate, "m_SAME", { body: "変更" })
    ).toThrow(/同じID/u);
    expect(() => findMemoEntry(parsed, "m_SAME")).toThrow(/複数/u);

    // 新規IDの追記は、既存の重複を壊さない限り可能。
    const appended = appendMemoEntry(duplicate, {
      at: AT,
      body: "3件目",
      id: "m_UNIQUE",
    });
    expect(parseMemoLog(appended).entries).toHaveLength(3);
  });

  it("コードフェンス内のマーカーを構造として解釈しない", () => {
    const content = `${baseDocument()}## 2026-10-26\n\n\`\`\`md\n<!-- seiton:memo:start id="m_FAKE" at="${AT}" -->\n\`\`\`\n`;
    const parsed = parseMemoLog(content);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.diagnostics).toEqual([]);
    expect(() =>
      appendMemoEntry(content, { at: AT, body: "追加", id: "m_REAL" })
    ).not.toThrow();
  });

  it("閉じていないコードフェンス・frontmatterを検出する", () => {
    const unclosedFence = `${baseDocument()}## 2026-10-26\n\n\`\`\`\n本文\n`;
    expect(parseMemoLog(unclosedFence).diagnostics[0]?.code).toBe(
      "unclosed-fence"
    );

    const unclosedFrontmatter = `---\nkind: memo-log\nweek: ${WEEK}\n`;
    const parsed = parseMemoLog(unclosedFrontmatter);
    expect(parsed.diagnostics[0]?.code).toBe("frontmatter-unclosed");
    expect(() =>
      appendMemoEntry(unclosedFrontmatter, {
        at: AT,
        body: "追加",
        id: "m_NEW",
      })
    ).toThrow(/安全に追記できない/u);
  });

  it("孤立した終了マーカーは警告だけにして本文を壊さない", () => {
    const content = `${baseDocument()}## 2026-10-26\n\n${MEMO_END_MARKER}\n`;
    const parsed = parseMemoLog(content);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.diagnostics[0]?.code).toBe("orphan-end");
    expect(parsed.diagnostics[0]?.severity).toBe("warning");
    const next = appendMemoEntry(content, {
      at: AT,
      body: "追加",
      id: "m_NEW",
    });
    expect(next).toContain(MEMO_END_MARKER);
  });

  it("不正な日時を診断する", () => {
    const bad = documentWith(
      '<!-- seiton:memo:start id="m_BADAT" at="2026-13-40T99:99:99+09:00" state="active" -->\n本文\n<!-- seiton:memo:end -->'
    );
    const parsed = parseMemoLog(bad);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.diagnostics.some((d) => d.code === "invalid-at")).toBe(true);
    expect(parsed.diagnostics[0]?.severity).toBe("error");
  });

  it("未知の状態・未知の属性を保持する", () => {
    const text =
      '<!-- seiton:memo:start id="m_CUSTOM" at="2026-10-26T09:32:00+09:00" state="waiting" custom="a&amp;b" -->\n本文\n<!-- seiton:memo:end -->';
    const parsed = parseMemoLog(documentWith(text));
    expect(parsed.entries[0]?.state).toBe("unknown");
    expect(parsed.entries[0]?.attributes.custom).toBe("a&b");
    expect(parsed.diagnostics.some((d) => d.code === "unknown-state")).toBe(
      true
    );

    const updated = updateMemoEntry(documentWith(text), "m_CUSTOM", {
      body: "更新",
    });
    expect(updated).toContain('state="waiting"');
    expect(updated).toContain('custom="a&amp;b"');
    expect(parseMemoLog(updated).entries[0]?.body).toBe("更新");
  });

  it("1件の更新で他の項目と前後の未知テキストを変更しない", () => {
    const before = `${baseDocument()}## 2026-10-26\n\n前置き\n\n${entryText(
      "m_ONE",
      "1件目"
    )}\n\n${entryText("m_TWO", "2件目")}\n\n${entryText(
      "m_THREE",
      "3件目"
    )}\n\n末尾\n`;
    const parsed = parseMemoLog(before);
    const middle = parsed.entries[1];
    expect(middle?.id).toBe("m_TWO");
    const after = updateMemoEntry(before, "m_TWO", { body: "2件目を更新" });
    const afterParsed = parseMemoLog(after);
    expect(afterParsed.entries[0]?.body).toBe("1件目");
    expect(afterParsed.entries[1]?.body).toBe("2件目を更新");
    expect(afterParsed.entries[2]?.body).toBe("3件目");
    expect(after.slice(0, middle?.startOffset)).toBe(
      before.slice(0, middle?.startOffset)
    );
    const afterMiddle = afterParsed.entries[1];
    expect(after.slice(afterMiddle?.endOffset ?? 0)).toBe(
      before.slice(middle?.endOffset ?? 0)
    );
  });

  it("空本文・末尾改行・絵文字をラウンドトリップする", () => {
    const cases = ["", "末尾改行\n", "絵文字 🎉 と日本語", "a\n\nb"];
    for (const body of cases) {
      const text = entryText("m_ROUND", body);
      const parsed = parseMemoLog(documentWith(text));
      expect(parsed.entries[0]?.body).toBe(body);
      const updated = updateMemoEntry(documentWith(text), "m_ROUND", {
        body,
      });
      expect(parseMemoLog(updated).entries[0]?.body).toBe(body);
    }
  });

  it("ソフト削除と復元の状態を表現できる", () => {
    const before = documentWith(entryText("m_DEL", "消す前の本文"));
    const deleted = updateMemoEntry(before, "m_DEL", {
      deletedAt: "2026-10-26T10:00:00+09:00",
      state: "deleted",
    });
    const deletedEntry = parseMemoLog(deleted).entries[0];
    expect(deletedEntry?.state).toBe("deleted");
    expect(deletedEntry?.body).toBe("消す前の本文");
    expect(deletedEntry?.deletedAt).toBe("2026-10-26T10:00:00+09:00");

    const restored = updateMemoEntry(deleted, "m_DEL", {
      deletedAt: null,
      state: "active",
    });
    const restoredEntry = parseMemoLog(restored).entries[0];
    expect(restoredEntry?.state).toBe("active");
    expect(restoredEntry?.deletedAt).toBeNull();
    expect(restoredEntry?.body).toBe("消す前の本文");
  });

  it("追記時に同じ日付見出しを再利用し、別日は見出しを追加する", () => {
    const first = documentWith(entryText("m_A", "A"));
    const sameDay = appendMemoEntry(first, {
      at: "2026-10-26T18:00:00+09:00",
      body: "B",
      id: "m_B",
    });
    expect(sameDay.match(/^## 2026-10-26$/gmu)?.length).toBe(1);

    const nextDay = appendMemoEntry(sameDay, {
      at: "2026-10-27T09:00:00+09:00",
      body: "C",
      id: "m_C",
    });
    expect(nextDay.match(/^## 2026-10-26$/gmu)?.length).toBe(1);
    expect(nextDay.match(/^## 2026-10-27$/gmu)?.length).toBe(1);
    expect(parseMemoLog(nextDay).entries.map((entry) => entry.body)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("追記後のファイルは追記可能な構造のまま", () => {
    const parsed = parseMemoLog(
      appendMemoEntry(baseDocument(), {
        at: AT,
        body: "本文",
        id: "m_OK",
      })
    );
    expect(() => assertMemoAppendable(parsed)).not.toThrow();
  });
});
