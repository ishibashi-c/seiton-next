import { beforeEach, describe, expect, it } from "vitest";
import { PROMPTS_FOLDER } from "../src/config";
import { parsePromptLog } from "../src/domain/promptLog";
import { PromptService } from "../src/services/promptService";
import { MemoryVault } from "./helpers/memoryVault";

function sequencePromptIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `p_${String(counter).padStart(26, "0")}`;
  };
}

describe("PromptService", () => {
  let vault: MemoryVault;
  let service: PromptService;

  beforeEach(() => {
    vault = new MemoryVault();
    service = new PromptService({
      createId: sequencePromptIds(),
      now: () => new Date(2026, 9, 26, 10, 0, 0),
      vault,
    });
  });

  it("セッションを作成し、タイトル・プロジェクト・状態を読める", async () => {
    const session = await service.createSession({
      project: "Seiton",
      title: "UI再設計",
    });
    expect(session.path).toBe(
      "Seiton/System/Logs/Prompts/2026-10-26-UI再設計.md"
    );
    expect(session.title).toBe("UI再設計");
    expect(session.project).toBe("Seiton");
    expect(session.state).toBe("open");
    expect(session.promptCount).toBe(0);

    const content = vault.files.get(session.path) ?? "";
    expect(content).toContain("kind: prompt-session");
    expect(content).toContain('"[[Seiton]]"');
    expect(parsePromptLog(content).draft?.body).toBe("");
  });

  it("コピー履歴を追記し、同じ本文の再コピーは重複にしない", async () => {
    const session = await service.createSession({ title: "履歴" });
    const first = await service.appendCopiedPrompt(session.path, "最初の指示");
    expect(first.duplicate).toBe(false);
    expect(first.item?.body).toBe("最初の指示");

    const duplicate = await service.appendCopiedPrompt(
      session.path,
      "最初の指示"
    );
    expect(duplicate.duplicate).toBe(true);

    await service.appendCopiedPrompt(session.path, "2番目の指示");
    const snapshot = await service.readSession(session.path);
    expect(snapshot.parsed.prompts.map((prompt) => prompt.body)).toEqual([
      "最初の指示",
      "2番目の指示",
    ]);
  });

  it("同時に同じ本文をコピーしても1件だけ保存する", async () => {
    const session = await service.createSession({ title: "同時" });
    vault.delayMs = 4;
    const results = await Promise.all([
      service.appendCopiedPrompt(session.path, "同じ指示"),
      service.appendCopiedPrompt(session.path, "同じ指示"),
    ]);
    const snapshot = await service.readSession(session.path);
    expect(snapshot.parsed.prompts).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
  });

  it("下書きを保存・復元し、空にもできる", async () => {
    const session = await service.createSession({ title: "下書き" });
    await service.saveDraft(session.path, "次の指示\n複数行");
    expect((await service.readSession(session.path)).parsed.draft?.body).toBe(
      "次の指示\n複数行"
    );

    await service.saveDraft(session.path, "");
    expect((await service.readSession(session.path)).parsed.draft?.body).toBe(
      ""
    );
  });

  it("セッション状態を開閉できる", async () => {
    const session = await service.createSession({ title: "状態" });
    await service.setSessionState(session.path, "closed");
    expect((await service.readSession(session.path)).summary.state).toBe(
      "closed"
    );
    await service.setSessionState(session.path, "open");
    expect((await service.readSession(session.path)).summary.state).toBe(
      "open"
    );
  });

  it("保存失敗時は履歴を増やさず、再試行できる", async () => {
    const session = await service.createSession({ title: "失敗" });
    vault.failNextProcessPath = session.path;
    await expect(
      service.appendCopiedPrompt(session.path, "失敗する指示")
    ).rejects.toThrow(/コピー履歴の保存に失敗/u);

    expect(
      (await service.readSession(session.path)).parsed.prompts
    ).toHaveLength(0);
    await service.appendCopiedPrompt(session.path, "再試行の指示");
    expect(
      (await service.readSession(session.path)).parsed.prompts
    ).toHaveLength(1);
  });

  it("一覧を更新順で返し、壊れたファイルを問題として報告する", async () => {
    const first = await service.createSession({ title: "1つ目" });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = await service.createSession({ title: "2つ目" });
    const listed = await service.listSessions();
    expect(listed.sessions.map((session) => session.path)).toContain(
      first.path
    );
    expect(listed.sessions.map((session) => session.path)).toContain(
      second.path
    );

    vault.files.set(
      `${PROMPTS_FOLDER}/broken.md`,
      "---\nkind: note\n---\n\n本文\n"
    );
    const withBroken = await service.listSessions();
    expect(
      withBroken.problems.some((problem) => problem.path.endsWith("broken.md"))
    ).toBe(true);
  });

  it("タイトル衝突時は別名のセッションを作る", async () => {
    const first = await service.createSession({ title: "同名" });
    const second = await service.createSession({ title: "同名" });
    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/-[0-9A-Z]{8}\.md$/u);
  });

  it("外部パスや別種ファイルを拒否する", async () => {
    await expect(service.readSession("Seiton/Notes/other.md")).rejects.toThrow(
      /保存先が不正/u
    );

    const path = `${PROMPTS_FOLDER}/foreign.md`;
    vault.files.set(path, "---\nkind: note\n---\n\n本文\n");
    await expect(service.appendCopiedPrompt(path, "指示")).rejects.toThrow(
      /プロンプトセッションではありません/u
    );
  });

  it("履歴をMarkdownとして書き出せる", async () => {
    const session = await service.createSession({ title: "書き出し" });
    await service.appendCopiedPrompt(session.path, "A");
    await service.appendCopiedPrompt(session.path, "B");
    const exported = await service.exportHistory(session.path);
    expect(exported).toContain("# 書き出し");
    expect(exported).toContain("A");
    expect(exported).toContain("B");
  });
});

describe("PromptService 20件以上の履歴", () => {
  it("25件を追記しても順番と本文が安定する", async () => {
    const vault = new MemoryVault();
    const service = new PromptService({
      createId: sequencePromptIds(),
      now: () => new Date(2026, 9, 26, 10, 0, 0),
      vault,
    });
    const session = await service.createSession({ title: "長い履歴" });
    for (let index = 0; index < 25; index += 1) {
      await service.appendCopiedPrompt(session.path, `指示 ${index}`);
    }
    const snapshot = await service.readSession(session.path);
    expect(snapshot.parsed.prompts).toHaveLength(25);
    expect(snapshot.parsed.prompts.map((prompt) => prompt.body)).toEqual(
      Array.from({ length: 25 }, (_, index) => `指示 ${index}`)
    );
    expect(snapshot.summary.promptCount).toBe(25);
  });
});
