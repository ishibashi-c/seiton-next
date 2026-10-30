import { beforeEach, describe, expect, it } from "vitest";
import { memoFilePath } from "../src/config";
import { parseMemoLog } from "../src/domain/memoLog";
import { MemoService } from "../src/services/memoService";
import { MemoryVault } from "./helpers/memoryVault";

const WEEK_44 = "2026-W44";

function sequenceIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `m_${String(counter).padStart(26, "0")}`;
  };
}

function serviceFor(
  vault: MemoryVault,
  now: () => Date,
  createMemoId = sequenceIds()
): MemoService {
  return new MemoService({ createMemoId, now, vault });
}

describe("MemoService", () => {
  let vault: MemoryVault;

  beforeEach(() => {
    vault = new MemoryVault();
  });

  it("週次ファイルを作成し、端末内保存の結果を返す", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 32, 0));
    const result = await service.addMemo("思いついたこと");
    expect(result.week).toBe(WEEK_44);
    expect(result.path).toBe("Seiton/System/Logs/Memos/2026-W44.md");
    expect(result.at).toMatch(/^2026-10-26T09:32:00[+-]\d{2}:\d{2}$/u);

    const data = vault.files.get(result.path) ?? "";
    expect(data).toContain("kind: memo-log");
    expect(data).toContain("week: 2026-W44");
    const parsed = parseMemoLog(data);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.id).toBe(result.id);
    expect(parsed.entries[0]?.body).toBe("思いついたこと");
    expect(parsed.entries[0]?.state).toBe("active");
  });

  it("空文字・空白だけのメモを保存しない", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    await expect(service.addMemo("")).rejects.toThrow(/空のメモ/u);
    await expect(service.addMemo("  \n ")).rejects.toThrow(/空のメモ/u);
    expect(vault.files.size).toBe(0);
  });

  it("同じ日の連続保存を直列化し、すべて保持する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    vault.delayMs = 4;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.addMemo(`連続メモ ${index}`)
      )
    );
    const path = memoFilePath(WEEK_44);
    const parsed = parseMemoLog(vault.files.get(path) ?? "");
    expect(parsed.entries).toHaveLength(12);
    expect(new Set(parsed.entries.map((entry) => entry.id)).size).toBe(12);
    expect(results.map((result) => result.id)).toEqual(
      parsed.entries.map((entry) => entry.id)
    );
    expect(parsed.entries.map((entry) => entry.body)).toContain("連続メモ 11");
  });

  it("週跨ぎ・年跨ぎで正しいファイルへ保存する", async () => {
    let current = new Date(2026, 11, 31, 23, 0, 0);
    const service = serviceFor(vault, () => current);
    await service.addMemo("大晦日");
    current = new Date(2027, 0, 1, 0, 30, 0);
    await service.addMemo("元日");
    current = new Date(2027, 0, 4, 9, 0, 0);
    await service.addMemo("新しい週");

    expect(vault.files.has("Seiton/System/Logs/Memos/2026-W53.md")).toBe(true);
    expect(vault.files.has("Seiton/System/Logs/Memos/2027-W01.md")).toBe(true);
    const w53 = parseMemoLog(
      vault.files.get("Seiton/System/Logs/Memos/2026-W53.md") ?? ""
    );
    expect(w53.entries.map((entry) => entry.body)).toEqual(["大晦日", "元日"]);
  });

  it("未知のfrontmatterやSeiton以外のファイルを上書きしない", async () => {
    const path = memoFilePath(WEEK_44);
    const foreign = "---\nkind: note\ntitle: 別のノート\n---\n\n本文\n";
    vault.files.set(path, foreign);
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));

    await expect(service.addMemo("追記")).rejects.toThrow(
      /週次メモではありません/u
    );
    expect(vault.files.get(path)).toBe(foreign);
  });

  it("壊れた週次ファイルには追記しない", async () => {
    const path = memoFilePath(WEEK_44);
    const broken = `---\nkind: memo-log\nweek: ${WEEK_44}\n---\n\n<!-- seiton:memo:start id="m_BROKEN" at="2026-10-26T09:00:00+09:00" -->\n本文\n`;
    vault.files.set(path, broken);
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));

    await expect(service.addMemo("追記")).rejects.toThrow(
      /安全に追記できない/u
    );
    expect(vault.files.get(path)).toBe(broken);
  });

  it("既存1件だけを更新し、他のメモを変更しない", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const first = await service.addMemo("1件目");
    const second = await service.addMemo("2件目");
    const third = await service.addMemo("3件目");

    const updated = await service.updateMemoBody(
      WEEK_44,
      second.id,
      "2件目を更新\n複数行"
    );
    expect(updated.body).toBe("2件目を更新\n複数行");

    const parsed = parseMemoLog(vault.files.get(second.path) ?? "");
    expect(parsed.entries.map((entry) => entry.body)).toEqual([
      "1件目",
      "2件目を更新\n複数行",
      "3件目",
    ]);
    expect(parsed.entries.map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("ソフト削除・復元で本文を失わない", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("残す本文");

    const deleted = await service.setMemoDeleted(WEEK_44, memo.id, true);
    expect(deleted.state).toBe("deleted");
    expect(deleted.body).toBe("残す本文");

    const withoutDeleted = await service.listAll();
    expect(withoutDeleted.items).toHaveLength(0);
    const withDeleted = await service.listAll({ includeDeleted: true });
    expect(withDeleted.items).toHaveLength(1);

    const restored = await service.setMemoDeleted(WEEK_44, memo.id, false);
    expect(restored.state).toBe("active");
    expect(restored.body).toBe("残す本文");
    expect(restored.deletedAt).toBeNull();
  });

  it("複数週を横断して新しい順に返す", async () => {
    let current = new Date(2026, 9, 19, 9, 0, 0);
    const service = serviceFor(vault, () => current);
    await service.addMemo("先週のメモ");
    current = new Date(2026, 9, 26, 9, 0, 0);
    await service.addMemo("今週のメモ");

    const recent = await service.listAll();
    expect(recent.items.map((item) => item.entry.body)).toEqual([
      "今週のメモ",
      "先週のメモ",
    ]);
    expect(recent.items.map((item) => item.week)).toEqual([
      "2026-W44",
      "2026-W43",
    ]);
  });

  it("全期間の週ファイルを列挙し、8週の窓より前も返す", async () => {
    let current = new Date(2026, 4, 20, 9, 0, 0);
    const service = serviceFor(vault, () => current);
    await service.addMemo("5月のメモ");
    current = new Date(2026, 9, 26, 9, 0, 0);
    await service.addMemo("10月のメモ");

    const all = await service.listAll();
    expect(all.items.map((item) => item.entry.body)).toEqual([
      "10月のメモ",
      "5月のメモ",
    ]);
    expect(all.items.map((item) => item.week)).toEqual([
      "2026-W44",
      "2026-W21",
    ]);
    expect(all.problems).toEqual([]);
  });

  it("listAll は削除済みを既定で除き、指定すると含める", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const removed = await service.addMemo("消すメモ");
    await service.addMemo("残すメモ");
    await service.setMemoDeleted(WEEK_44, removed.id, true);

    const visible = await service.listAll();
    expect(visible.items.map((item) => item.entry.body)).toEqual(["残すメモ"]);

    const all = await service.listAll({ includeDeleted: true });
    expect(all.items.map((item) => item.entry.body)).toContain("消すメモ");
    expect(all.items).toHaveLength(2);
  });

  it("listAll は別種のファイルとweek不一致を問題として報告する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    await service.addMemo("正常な週のメモ");

    vault.files.set(
      "Seiton/System/Logs/Memos/2026-W43.md",
      "---\nkind: note\nweek: 2026-W43\n---\n\n別のノート\n"
    );
    vault.files.set(
      "Seiton/System/Logs/Memos/2026-W42.md",
      "---\nkind: memo-log\nweek: 2026-W41\n---\n\n## 2026-10-12\n"
    );

    const all = await service.listAll();
    expect(all.items.map((item) => item.entry.body)).toEqual([
      "正常な週のメモ",
    ]);
    expect(all.problems.map((problem) => problem.path).sort()).toEqual([
      "Seiton/System/Logs/Memos/2026-W42.md",
      "Seiton/System/Logs/Memos/2026-W43.md",
    ]);
  });

  it("重複IDがあるファイルの個別更新を拒否する", async () => {
    const path = memoFilePath(WEEK_44);
    const duplicate = `---\nkind: memo-log\nweek: ${WEEK_44}\n---\n\n## 2026-10-26\n\n<!-- seiton:memo:start id="m_SAME" at="2026-10-26T09:00:00+09:00" state="active" -->\nA\n<!-- seiton:memo:end -->\n\n<!-- seiton:memo:start id="m_SAME" at="2026-10-26T09:01:00+09:00" state="active" -->\nB\n<!-- seiton:memo:end -->\n`;
    vault.files.set(path, duplicate);
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    await expect(
      service.updateMemoBody(WEEK_44, "m_SAME", "変更")
    ).rejects.toThrow(/同じID/u);
    expect(vault.files.get(path)).toBe(duplicate);
  });

  it("独立ノートへ昇格し、再実行しても重複作成しない", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("買い物リストを整理するアイデア");

    const promoted = await service.promoteMemo({
      id: memo.id,
      kind: "idea",
      title: "買い物リスト",
      week: WEEK_44,
    });
    expect(promoted.alreadyPromoted).toBe(false);
    expect(promoted.notePath).toBe("Seiton/Notes/2026-10-26-買い物リスト.md");
    const note = vault.files.get(promoted.notePath) ?? "";
    expect(note).toContain("kind: idea");
    expect(note).toContain(`seiton_memo_id: "${memo.id}"`);
    expect(note).toContain("買い物リストを整理するアイデア");

    const weekly = parseMemoLog(vault.files.get(memo.path) ?? "");
    const entry = weekly.entries[0];
    expect(entry?.state).toBe("promoted");
    expect(entry?.promotedTo).toBe(promoted.notePath);
    expect(entry?.body).toContain(promoted.link);

    const second = await service.promoteMemo({
      id: memo.id,
      kind: "idea",
      title: "買い物リスト",
      week: WEEK_44,
    });
    expect(second.alreadyPromoted).toBe(true);
    expect(
      [...vault.files.keys()].filter((path) => path.startsWith("Seiton/Notes/"))
    ).toHaveLength(1);
  });

  it("昇格リンクの書き込みに失敗しても元メモを残し、再試行でノートを再利用する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("失敗しても残る本文");
    vault.failNextProcessPath = memo.path;

    await expect(
      service.promoteMemo({
        id: memo.id,
        kind: "idea",
        title: "失敗テスト",
        week: WEEK_44,
      })
    ).rejects.toThrow(/昇格に失敗/u);

    const notePath = "Seiton/Notes/2026-10-26-失敗テスト.md";
    expect(vault.files.has(notePath)).toBe(true);
    const unchanged = parseMemoLog(vault.files.get(memo.path) ?? "");
    expect(unchanged.entries[0]?.state).toBe("active");
    expect(unchanged.entries[0]?.body).toBe("失敗しても残る本文");

    const retried = await service.promoteMemo({
      id: memo.id,
      kind: "idea",
      title: "失敗テスト",
      week: WEEK_44,
    });
    expect(retried.reusedExisting).toBe(true);
    expect(retried.notePath).toBe(notePath);
    const updated = parseMemoLog(vault.files.get(memo.path) ?? "");
    expect(updated.entries[0]?.state).toBe("promoted");
    expect(
      [...vault.files.keys()].filter((path) => path.startsWith("Seiton/Notes/"))
    ).toHaveLength(1);
  });

  it("削除済みメモは昇格しない", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("削除済み");
    await service.setMemoDeleted(WEEK_44, memo.id, true);
    await expect(
      service.promoteMemo({
        id: memo.id,
        kind: "idea",
        title: "昇格不可",
        week: WEEK_44,
      })
    ).rejects.toThrow(/削除済み/u);
  });

  it("タイトル衝突時は識別子付きの別名を使う", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("本文");
    vault.files.set(
      "Seiton/Notes/2026-10-26-同じ名前.md",
      "---\nkind: note\n---\n\n別のノート\n"
    );
    const promoted = await service.promoteMemo({
      id: memo.id,
      kind: "idea",
      title: "同じ名前",
      week: WEEK_44,
    });
    expect(promoted.notePath).not.toBe("Seiton/Notes/2026-10-26-同じ名前.md");
    expect(promoted.notePath).toMatch(/-[0-9A-Z]{8}\.md$/u);
    expect(vault.files.get("Seiton/Notes/2026-10-26-同じ名前.md")).toContain(
      "別のノート"
    );
  });
  it("保存失敗時はファイルを壊さず、再試行で1件だけ追加する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const first = await service.addMemo("1件目");
    vault.failNextProcessPath = first.path;

    await expect(service.addMemo("失敗する2件目")).rejects.toThrow(
      /保存に失敗/u
    );
    const afterFailure = parseMemoLog(vault.files.get(first.path) ?? "");
    expect(afterFailure.entries.map((entry) => entry.body)).toEqual(["1件目"]);

    await service.addMemo("再試行の2件目");
    const retried = parseMemoLog(vault.files.get(first.path) ?? "");
    expect(retried.entries.map((entry) => entry.body)).toEqual([
      "1件目",
      "再試行の2件目",
    ]);
  });

  it("更新失敗時は元の本文を残す", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    const memo = await service.addMemo("元の本文");
    vault.failNextProcessPath = memo.path;

    await expect(
      service.updateMemoBody(WEEK_44, memo.id, "失敗する更新")
    ).rejects.toThrow(/更新に失敗/u);
    const parsed = parseMemoLog(vault.files.get(memo.path) ?? "");
    expect(parsed.entries[0]?.body).toBe("元の本文");
  });

  it("サービスを再生成しても既存ファイルへ追記する（再起動相当）", async () => {
    const ids = sequenceIds();
    const now = (): Date => new Date(2026, 9, 26, 9, 0);
    const firstService = serviceFor(vault, now, ids);
    await firstService.addMemo("再起動前");

    const secondService = serviceFor(vault, now, ids);
    await secondService.addMemo("再起動後");

    const parsed = parseMemoLog(vault.files.get(memoFilePath(WEEK_44)) ?? "");
    expect(parsed.entries.map((entry) => entry.body)).toEqual([
      "再起動前",
      "再起動後",
    ]);
    expect(new Set(parsed.entries.map((entry) => entry.id)).size).toBe(2);
  });

  it("壊れた週次ファイルや別種ファイルを問題として報告し、他の週は表示する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    await service.addMemo("正常な週のメモ");

    vault.files.set(
      "Seiton/System/Logs/Memos/2026-W43.md",
      "---\nkind: note\nweek: 2026-W43\n---\n\n別のノート\n"
    );
    vault.files.set(
      "Seiton/System/Logs/Memos/2026-W42.md",
      '---\nkind: memo-log\nweek: 2026-W42\n---\n\n<!-- seiton:memo:start id="m_BROKEN" at="2026-10-19T09:00:00+09:00" -->\n閉じない\n'
    );

    const recent = await service.listAll();
    expect(recent.items.map((item) => item.entry.body)).toEqual([
      "正常な週のメモ",
    ]);
    expect(recent.problems.map((problem) => problem.path).sort()).toEqual([
      "Seiton/System/Logs/Memos/2026-W42.md",
      "Seiton/System/Logs/Memos/2026-W43.md",
    ]);
  });

  it("不正な週識別子を拒否する", async () => {
    const service = serviceFor(vault, () => new Date(2026, 9, 26, 9, 0));
    await expect(service.readEntry("2026-W54", "m_X")).rejects.toThrow(
      /週識別子/u
    );
  });
});
