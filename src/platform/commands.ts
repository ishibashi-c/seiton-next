import type { Plugin } from "obsidian";

export interface SeitonCommandsHost {
  bulkEditBooks: () => void;
  newPromptSession: () => void;
  openActiveWebClipPreview: () => void;
  openAddBook: () => void;
  openBases: () => Promise<void>;
  openBookshelf: () => Promise<void>;
  openBulkIsbn: () => void;
  openCoverCacheForAll: () => Promise<void>;
  openCurrentWeek: () => Promise<void>;
  openHome: () => Promise<void>;
  openLibrary: () => Promise<void>;
  openMemoCapture: () => void;
  openMigration: () => void;
  openNewNote: () => void;
  openProjects: () => Promise<void>;
  openPrompt: () => Promise<void>;
  openReviewTray: () => Promise<void>;
  openTriage: () => void;
  openTsubuyaki: () => Promise<void>;
  runCalilBulk: () => Promise<void>;
  searchLibrary: () => Promise<void>;
}

export function registerCommands(
  plugin: Plugin,
  host: SeitonCommandsHost
): void {
  plugin.addCommand({
    callback: () => void host.openHome(),
    hotkeys: [{ key: "h", modifiers: ["Mod", "Shift"] }],
    id: "open-home",
    name: "ホームを開く",
  });
  plugin.addCommand({
    callback: () => void host.openLibrary(),
    hotkeys: [{ key: "l", modifiers: ["Mod", "Shift"] }],
    id: "open-library",
    name: "ライブラリを開く",
  });
  plugin.addCommand({
    callback: () => void host.openBookshelf(),
    hotkeys: [{ key: "b", modifiers: ["Mod", "Alt"] }],
    id: "open-bookshelf",
    name: "本棚を開く",
  });
  plugin.addCommand({
    callback: () => void host.searchLibrary(),
    hotkeys: [{ key: "k", modifiers: ["Mod", "Alt"] }],
    id: "search-library",
    name: "ライブラリを検索",
  });
  plugin.addCommand({
    callback: () => void host.openReviewTray(),
    hotkeys: [{ key: "r", modifiers: ["Mod", "Alt"] }],
    id: "open-review-tray",
    name: "整理トレイを開く",
  });
  plugin.addCommand({
    callback: () => host.openTriage(),
    id: "start-triage",
    name: "未整理を1件ずつ整理",
  });
  plugin.addCommand({
    callback: () => void host.openProjects(),
    hotkeys: [{ key: "p", modifiers: ["Mod", "Alt"] }],
    id: "open-projects",
    name: "プロジェクトを開く",
  });
  plugin.addCommand({
    callback: () => void host.openPrompt(),
    hotkeys: [{ key: "w", modifiers: ["Mod", "Alt"] }],
    id: "open-prompt-workbench",
    name: "Prompt Workbenchを開く",
  });
  plugin.addCommand({
    callback: () => host.newPromptSession(),
    id: "new-prompt-session",
    name: "新しいプロンプトセッション",
  });
  plugin.addCommand({
    callback: () => host.openNewNote(),
    id: "new-note",
    name: "新しいノート",
  });
  plugin.addCommand({
    callback: () => void host.openBases(),
    id: "open-bases",
    name: "Basesビューを開く",
  });
  plugin.addCommand({
    callback: () => host.openAddBook(),
    id: "add-book",
    name: "書籍を追加",
  });
  plugin.addCommand({
    callback: () => host.bulkEditBooks(),
    id: "bulk-edit-books",
    name: "書籍を一括編集",
  });
  plugin.addCommand({
    callback: () => host.openBulkIsbn(),
    id: "add-books-bulk",
    name: "ISBNをまとめて追加",
  });
  plugin.addCommand({
    callback: () => void host.runCalilBulk(),
    id: "calil-bulk-search",
    name: "カーリルで一括検索",
  });
  plugin.addCommand({
    callback: () => void host.openCoverCacheForAll(),
    id: "manage-cover-cache",
    name: "表紙キャッシュを管理",
  });
  plugin.addCommand({
    callback: () => host.openMigration(),
    id: "migrate-legacy-preview",
    name: "旧Seitonデータの移行（プレビュー）",
  });
  plugin.addCommand({
    callback: () => host.openActiveWebClipPreview(),
    id: "preview-active-webclip",
    name: "現在のWebクリップのプレビューを更新",
  });
  plugin.addCommand({
    callback: () => host.openMemoCapture(),
    hotkeys: [{ key: "m", modifiers: ["Mod", "Shift"] }],
    id: "add-memo",
    name: "メモを追加",
  });
  plugin.addCommand({
    callback: () => void host.openTsubuyaki(),
    id: "open-tsubuyaki",
    name: "つぶやきを開く",
  });
  plugin.addCommand({
    callback: () => void host.openCurrentWeek(),
    id: "open-current-week-memo",
    name: "今週の一言メモを開く",
  });
}
