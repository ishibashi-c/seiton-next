import { describe, expect, it } from "vitest";
import {
  appendPromptItem,
  createPromptSessionDocument,
  DRAFT_END_MARKER,
  exportPromptHistory,
  formatDraft,
  formatPromptItem,
  isDuplicateOfLatest,
  PROMPT_END_MARKER,
  parsePromptLog,
  promptHash,
  setPromptSessionState,
  updatePromptDraft,
} from "../src/domain/promptLog";

const AT = "2026-10-26T10:45:00+09:00";

function sessionDocument(title = "UI再設計", project = "Seiton"): string {
  return createPromptSessionDocument({
    createdAt: "2026-10-26T10:00:00+09:00",
    project,
    title,
  });
}

describe("Prompt Workbenchのファイル文法", () => {
  it("セッションを作成して解析できる", () => {
    const content = sessionDocument();
    expect(content).toContain("kind: prompt-session");
    expect(content).toContain('projects: \n  - "[[Seiton]]"');
    expect(content).toContain("session_state: open");
    const parsed = parsePromptLog(content);
    expect(parsed.title).toBe("UI再設計");
    expect(parsed.prompts).toHaveLength(0);
    expect(parsed.draft?.body).toBe("");
    expect(parsed.frontmatter.fields.kind).toBe("prompt-session");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("コピー履歴を下書きの直前へ追記する", () => {
    const first = appendPromptItem(sessionDocument(), {
      at: AT,
      body: "最初の指示",
      hash: promptHash("最初の指示"),
      id: "p_ONE",
    });
    const second = appendPromptItem(updatePromptDraft(first, "次の下書き"), {
      at: "2026-10-26T10:50:00+09:00",
      body: "2番目の指示",
      id: "p_TWO",
    });
    const parsed = parsePromptLog(second);
    expect(parsed.prompts.map((prompt) => prompt.body)).toEqual([
      "最初の指示",
      "2番目の指示",
    ]);
    expect(parsed.prompts.map((prompt) => prompt.id)).toEqual([
      "p_ONE",
      "p_TWO",
    ]);
    expect(parsed.draft?.body).toBe("次の下書き");
    expect(second.indexOf("2番目の指示")).toBeLessThan(
      second.indexOf("seiton:draft:start")
    );
  });

  it("下書きを更新しても履歴と未知テキストを壊さない", () => {
    const content = `${sessionDocument()}<!-- 手書きのメモ -->\n`;
    const withPrompt = appendPromptItem(content, {
      at: AT,
      body: "履歴",
      id: "p_HISTORY",
    });
    const updated = updatePromptDraft(withPrompt, "下書き1\n下書き2");
    const parsed = parsePromptLog(updated);
    expect(parsed.prompts[0]?.body).toBe("履歴");
    expect(parsed.draft?.body).toBe("下書き1\n下書き2");
    expect(updated).toContain("<!-- 手書きのメモ -->");
    expect(updated).toContain(DRAFT_END_MARKER);
  });

  it("予約マーカーを含む本文をエスケープして復元する", () => {
    const body = [
      "1行目",
      PROMPT_END_MARKER,
      "<!-- seiton:draft:end -->",
      "```md",
      "## 見出し",
      "```",
    ].join("\n");
    const withPrompt = appendPromptItem(sessionDocument(), {
      at: AT,
      body,
      id: "p_BODY",
    });
    const parsed = parsePromptLog(withPrompt);
    expect(parsed.prompts[0]?.body).toBe(body);
    expect(withPrompt).toContain("seiton:prompt:escape");
  });

  it("CRLFを保ったまま追記・下書き更新できる", () => {
    const eol = "\r\n";
    const content = createPromptSessionDocument({
      createdAt: "2026-10-26T10:00:00+09:00",
      eol,
      title: "CRLF",
    });
    const updated = updatePromptDraft(
      appendPromptItem(content, { at: AT, body: "CRLF本文", id: "p_CRLF" }),
      "下書き"
    );
    expect(updated.replace(/\r\n/gu, "")).not.toContain("\n");
    const parsed = parsePromptLog(updated);
    expect(parsed.prompts[0]?.body).toBe("CRLF本文");
    expect(parsed.draft?.body).toBe("下書き");
  });

  it("最新の指示と同じ内容を重複と判定する", () => {
    const content = appendPromptItem(sessionDocument(), {
      at: AT,
      body: "同じ指示",
      id: "p_SAME",
    });
    const parsed = parsePromptLog(content);
    expect(isDuplicateOfLatest(parsed, "同じ指示")).toBe(true);
    expect(isDuplicateOfLatest(parsed, " 同じ指示 \n")).toBe(true);
    expect(isDuplicateOfLatest(parsed, "違う指示")).toBe(false);
  });

  it("未完了の指示・下書き・重複IDを検出する", () => {
    const unclosed = `${sessionDocument()}<!-- seiton:prompt:start id="p_X" at="${AT}" -->\n本文\n`;
    expect(parsePromptLog(unclosed).diagnostics[0]?.code).toBe(
      "unclosed-entry"
    );

    const unclosedDraft =
      "---\nkind: prompt-session\nsession_state: open\n---\n\n# 下書きテスト\n\n<!-- seiton:draft:start -->\n下書き\n";
    expect(parsePromptLog(unclosedDraft).diagnostics[0]?.code).toBe(
      "unclosed-draft"
    );

    const duplicate = appendPromptItem(
      appendPromptItem(sessionDocument(), {
        at: AT,
        body: "A",
        id: "p_DUP",
      }),
      { at: AT, body: "B", id: "p_DUP" }
    );
    const parsed = parsePromptLog(duplicate);
    expect(parsed.prompts).toHaveLength(2);
    expect(
      parsed.diagnostics.some((item) => item.code === "duplicate-id")
    ).toBe(true);
  });

  it("セッションの開閉状態だけを更新する", () => {
    const content =
      "---\nkind: prompt-session\ncustom: keep\nsession_state: open\n---\n\n本文\n";
    const closed = setPromptSessionState(content, "closed");
    expect(closed).toContain("custom: keep");
    expect(closed).toContain("session_state: closed");
    expect(closed).not.toContain("session_state: open");
    expect(closed).toContain("本文");
  });

  it("履歴全体をMarkdownとして書き出せる", () => {
    const content = appendPromptItem(
      appendPromptItem(sessionDocument(), {
        at: AT,
        body: "A",
        id: "p_A",
      }),
      { at: "2026-10-26T10:50:00+09:00", body: "B", id: "p_B" }
    );
    const exported = exportPromptHistory(parsePromptLog(content));
    expect(exported).toContain("### 2026-10-26T10:45:00+09:00");
    expect(exported).toContain("A");
    expect(exported).toContain("B");
  });

  it("下書きの空本文と末尾改行を復元する", () => {
    for (const body of ["", "末尾改行\n", "a\n\nb"]) {
      const content = updatePromptDraft(sessionDocument(), body);
      expect(parsePromptLog(content).draft?.body).toBe(body);
    }
    expect(formatDraft("")).toContain(DRAFT_END_MARKER);
    expect(formatPromptItem({ at: AT, body: "x", id: "p_X" })).toContain(
      PROMPT_END_MARKER
    );
  });
});
