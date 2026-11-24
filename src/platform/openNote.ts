import type { App } from "obsidian";
import { MarkdownView, TFile } from "obsidian";
import { showToast } from "./ui/toast";

/**
 * Markdownファイルを開き、ドキュメント末尾へカーソルを移動してフォーカスする。
 * 授業ノートのように開いた直後から書き始めたい場面で使う。
 */
export async function openMarkdownAtEnd(
  app: App,
  path: string
): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    showToast("ファイルが見つかりません。");
    return false;
  }
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  app.workspace.setActiveLeaf(leaf, { focus: true });

  const focusEnd = () => {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.getMode() !== "preview") {
      const lastLine = view.editor.lastLine();
      const ch = view.editor.getLine(lastLine).length;
      view.editor.setCursor({ ch, line: lastLine });
      view.editor.focus();
    }
  };

  focusEnd();
  if (typeof window !== "undefined") {
    window.requestAnimationFrame(focusEnd);
  }
  return true;
}
