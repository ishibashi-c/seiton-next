import { type App, TFile } from "obsidian";
import { VIEW_TYPE_LIBRARY } from "../config";
import {
  buildNoteDocument,
  buildTemplateBody,
  classNotePath,
} from "../domain/noteTemplates";
import type { MemoService } from "../services/memoService";
import { NoteService } from "../services/noteService";
import { PropertyService } from "../services/propertyService";
import type { NoteRecord, VaultIndexService } from "../services/vaultIndex";
import { SeitonLibraryView } from "./libraryView";
import { NewNoteModal } from "./newNoteModal";
import { showToast } from "./ui/toast";
import type { WebClipCaptureInput } from "./webClipCaptureModal";

export interface SeitonUriHost {
  addShortcutLink: (url: string, title: string) => Promise<void> | void;
  app: App;
  indexService: VaultIndexService;
  memoService: MemoService;
  openAddBook: (isbn: string) => void;
  openAssets: () => Promise<void>;
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
  if (action === "link" || action === "shortcut") {
    if (webClipUrl === "") {
      showToast("url がありません。");
      return;
    }
    await host.addShortcutLink(webClipUrl, (params.title ?? "").trim());
    return;
  }

  if (
    action === "webclip" ||
    action === "web-clip" ||
    action === "clip" ||
    (action === "" && webClipUrl !== "") ||
    webClipUrl !== ""
  ) {
    if (webClipUrl === "") {
      showToast("url がありません。");
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
      showToast("text がありません。");
      return;
    }
    try {
      await host.memoService.addMemo(text);
      showToast("メモを保存しました。");
      host.refreshHomeViews();
    } catch (error) {
      showToast(
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
    if (view === "assets" || view === "snapshot") {
      await host.openAssets();
      return;
    }
    await host.openHome();
    return;
  }

  if (action === "snapshot") {
    await host.openAssets();
    return;
  }

  if (
    action === "class" ||
    (params.course !== undefined && params.course.trim() !== "")
  ) {
    const course = (params.course ?? "").trim();
    if (course !== "") {
      const now = new Date();
      const today = [
        String(now.getFullYear()).padStart(4, "0"),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("-");
      const path = classNotePath(today, course);
      const existing = host.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await host.app.workspace.openLinkText(path, "", false);
        showToast(`授業ノートを開きました: ${today} ${course}`);
        return;
      }
      const folder = "Seiton/Notes";
      if (!host.app.vault.getAbstractFileByPath(folder)) {
        await host.app.vault.createFolder(folder);
      }
      const content = buildNoteDocument({
        body: buildTemplateBody("class"),
        course,
        createdAt: new Date().toISOString(),
        kind: "class",
        lectureDate: today,
        title: `${today} ${course}`,
      });
      await host.app.vault.create(path, content);
      await host.app.workspace.openLinkText(path, "", false);
      showToast(`授業ノートを作成しました: ${today} ${course}`);
      return;
    }

    const properties = new PropertyService(host.app);
    const noteService = new NoteService(host.app, properties);
    new NewNoteModal(
      host.app,
      noteService,
      host.indexService,
      "",
      (createdPath) => {
        void host.app.workspace.openLinkText(createdPath, "", false);
      }
    ).open();
    return;
  }

  if (action === "book") {
    const isbn = (params.isbn ?? "").replace(/[^0-9Xx]/gu, "");
    if (isbn === "") {
      showToast("isbn がありません。");
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

  showToast(
    `未対応の操作です（v${host.version} / action="${action}" / keys=${
      Object.keys(params).join(",") || "なし"
    }）`
  );
}
