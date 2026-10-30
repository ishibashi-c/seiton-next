/**
 * `obsidian://seiton-next?...` の処理。
 * main.ts から呼ばれ、画面やサービスを直接触らないようホスト経由で操作する。
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import { VIEW_TYPE_LIBRARY } from "../config";
import type { MemoService } from "../services/memoService";
import type { NoteRecord, VaultIndexService } from "../services/vaultIndex";
import { SeitonLibraryView } from "./libraryView";
import type { WebClipCaptureInput } from "./webClipCaptureModal";

export interface SeitonUriHost {
  app: App;
  indexService: VaultIndexService;
  memoService: MemoService;
  openAddBook: (isbn: string) => void;
  openBookDetail: (record: NoteRecord) => void;
  openBookshelf: () => Promise<void>;
  openHome: () => Promise<void>;
  openLibrary: () => Promise<void>;
  openProjects: () => Promise<void>;
  openPromptView: () => Promise<void>;
  openTsubuyaki: () => Promise<void>;
  openWebClipCapture: (input: WebClipCaptureInput) => void;
  refreshHomeViews: () => void;
  version: string;
}

export async function handleSeitonUri(
  host: SeitonUriHost,
  params: Record<string, string>
): Promise<void> {
  const action = (params.action ?? "").trim().toLowerCase();
  const text = (params.text ?? "").trim().slice(0, 1500);

  const webClipUrl =
    (params.url ?? "").trim() ||
    Object.values(params)
      .find((value) => /^https?:\/\//u.test(value))
      ?.trim() ||
    "";
  if (
    action === "webclip" ||
    action === "web-clip" ||
    action === "clip" ||
    (action === "" && webClipUrl !== "") ||
    webClipUrl !== ""
  ) {
    if (webClipUrl === "") {
      new Notice("url がありません。");
      return;
    }
    host.openWebClipCapture({
      capture: params.capture,
      note: params.note,
      title: params.title,
      url: webClipUrl,
    });
    return;
  }

  if (action === "memo" || (action === "" && text !== "")) {
    if (text === "") {
      new Notice("text がありません。");
      return;
    }
    try {
      await host.memoService.addMemo(text);
      new Notice("メモを保存しました。");
      host.refreshHomeViews();
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "メモを保存できませんでした。"
      );
    }
    return;
  }

  if (action === "open") {
    const view = (params.view ?? "home").trim().toLowerCase();
    const query = (params.q ?? "").trim();
    if (view === "library") {
      await host.openLibrary();
      if (query !== "") {
        const leaf = host.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
        if (leaf?.view instanceof SeitonLibraryView) {
          await leaf.view.setSearch(query);
        }
      }
      return;
    }
    if (view === "bookshelf") {
      await host.openBookshelf();
      return;
    }
    if (view === "tsubuyaki") {
      await host.openTsubuyaki();
      return;
    }
    if (view === "projects") {
      await host.openProjects();
      return;
    }
    if (view === "prompt") {
      await host.openPromptView();
      return;
    }
    await host.openHome();
    return;
  }

  if (action === "book") {
    const isbn = (params.isbn ?? "").replace(/[^0-9Xx]/gu, "");
    if (isbn === "") {
      new Notice("isbn がありません。");
      return;
    }
    const index = await host.indexService.get();
    const note = index.notes.find(
      (candidate) =>
        candidate.kind === "book" &&
        (candidate.book.book_isbn ?? "").replace(/[^0-9Xx]/gu, "") === isbn
    );
    if (note) {
      host.openBookDetail(note);
      return;
    }
    host.openAddBook(isbn);
    return;
  }

  new Notice(
    `未対応の操作です（v${host.version} / action="${action}" / keys=${
      Object.keys(params).join(",") || "なし"
    }）`
  );
}
