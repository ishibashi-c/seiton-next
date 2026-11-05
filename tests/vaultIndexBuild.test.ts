import type { App, TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { createMemoLogDocument, formatMemoEntry } from "../src/domain/memoLog";
import { VaultIndexService } from "../src/services/vaultIndex";

interface FileEntry {
  content: string;
  frontmatter?: Record<string, unknown>;
  path: string;
}

function createMockApp(files: FileEntry[]): App {
  const fileMap = new Map<string, FileEntry>();
  const mockFiles: TFile[] = [];

  for (const entry of files) {
    fileMap.set(entry.path, entry);
    const basename = entry.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    mockFiles.push({
      basename,
      extension: "md",
      name: `${basename}.md`,
      parent: null,
      path: entry.path,
      stat: { ctime: 1000, mtime: 2000, size: entry.content.length },
      vault: null as unknown as App["vault"],
    } as unknown as TFile);
  }

  return {
    metadataCache: {
      getFileCache: (file: TFile) => {
        const entry = fileMap.get(file.path);
        return entry?.frontmatter ? { frontmatter: entry.frontmatter } : null;
      },
    },
    vault: {
      cachedRead: async (file: TFile) => fileMap.get(file.path)?.content ?? "",
      getMarkdownFiles: () => mockFiles,
    },
  } as unknown as App;
}

describe("VaultIndexService.build()", () => {
  it("Seiton/System/ 配下の台帳・設定ファイルを通常の notes としてインデックスしない", async () => {
    const memoDoc = `${createMemoLogDocument("2026-W45", "2026-11-04T09:00:00+09:00")}## 2026-11-04\n\n${formatMemoEntry(
      {
        at: "2026-11-04T10:00:00+09:00",
        body: "つぶやきテスト",
        id: "m_01JABC",
        state: "active",
      }
    )}\n`;

    const app = createMockApp([
      {
        content: "# 通常メモ\n本文です",
        frontmatter: { title: "通常メモ" },
        path: "Seiton/Notes/regular-note.md",
      },
      {
        content: "---\nkind: asset-accounts\n---\n# 口座設定",
        frontmatter: { kind: "asset-accounts" },
        path: "Seiton/System/Assets/Accounts.md",
      },
      {
        content: "---\nkind: asset-snapshots\n---\n# スナップショット",
        frontmatter: { kind: "asset-snapshots" },
        path: "Seiton/System/Assets/Snapshots.md",
      },
      {
        content: "---\nkind: asset-stocks\n---\n# ストック支出",
        frontmatter: { kind: "asset-stocks" },
        path: "Seiton/System/Assets/Stocks.md",
      },
      {
        content: "# リンク集",
        path: "Seiton/System/Links.md",
      },
      {
        content: "# テンプレート",
        path: "Seiton/System/Templates/Daily.md",
      },
      {
        content: memoDoc,
        frontmatter: { kind: "memo-log", week: "2026-W45" },
        path: "Seiton/System/Logs/Memos/2026-W45.md",
      },
    ]);

    const service = new VaultIndexService(app);
    const index = await service.build();

    // 通常メモのみが notes に登録される
    expect(index.notes).toHaveLength(1);
    expect(index.notes[0]?.path).toBe("Seiton/Notes/regular-note.md");

    // System/Logs/Memos は memos に振り分けられる
    expect(index.memos).toHaveLength(1);
    expect(index.memos[0]?.body).toContain("つぶやきテスト");

    // System/ 配下のシステムファイルは notes に絶対に漏れない
    const indexedPaths = index.notes.map((n) => n.path);
    expect(indexedPaths).not.toContain("Seiton/System/Assets/Accounts.md");
    expect(indexedPaths).not.toContain("Seiton/System/Assets/Snapshots.md");
    expect(indexedPaths).not.toContain("Seiton/System/Assets/Stocks.md");
    expect(indexedPaths).not.toContain("Seiton/System/Links.md");
    expect(indexedPaths).not.toContain("Seiton/System/Templates/Daily.md");
  });
});
