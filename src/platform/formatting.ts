import type { Editor, Menu, Plugin } from "obsidian";

import { showToast } from "./ui/toast";

function wrapSelection(editor: Editor, before: string, after: string): void {
  const selected = editor.getSelection();
  if (selected === "") {
    editor.replaceSelection(`${before}${after}`);
    const cursor = editor.getCursor();
    editor.setCursor({
      ch: Math.max(0, cursor.ch - after.length),
      line: cursor.line,
    });
    return;
  }
  editor.replaceSelection(`${before}${selected}${after}`);
}

function addFormattingCommands(plugin: Plugin): void {
  plugin.addCommand({
    editorCallback: (editor) => wrapSelection(editor, "**", "**"),
    id: "format-bold",
    name: "選択範囲を太字",
  });
  plugin.addCommand({
    editorCallback: (editor) => wrapSelection(editor, "==", "=="),
    id: "format-highlight",
    name: "選択範囲をハイライト",
  });
  plugin.addCommand({
    editorCallback: (editor) => wrapSelection(editor, "`", "`"),
    id: "format-code",
    name: "選択範囲をインラインコード",
  });
  plugin.addCommand({
    editorCallback: (editor) => {
      const selected = editor.getSelection();
      const label = selected || "リンク";
      editor.replaceSelection(`[${label}](url)`);
      if (!selected) {
        const cursor = editor.getCursor();
        editor.setCursor({
          ch: Math.max(0, cursor.ch - 6),
          line: cursor.line,
        });
      }
    },
    id: "format-link",
    name: "選択範囲をリンク",
  });
}

/**
 * 選択範囲をObsidianのMarkdown記法で包む薄いUI。
 * 独自エディターや広域DOM改変は行わない。
 */
export function registerFormatting(plugin: Plugin): void {
  addFormattingCommands(plugin);
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
      menu.addItem((item) => {
        item
          .setTitle("太字")
          .setIcon("bold")
          .onClick(() => wrapSelection(editor, "**", "**"));
      });
      menu.addItem((item) => {
        item
          .setTitle("ハイライト")
          .setIcon("highlighter")
          .onClick(() => wrapSelection(editor, "==", "=="));
      });
      menu.addItem((item) => {
        item
          .setTitle("インラインコード")
          .setIcon("code")
          .onClick(() => wrapSelection(editor, "`", "`"));
      });
      menu.addSeparator();
      menu.addItem((item) => {
        item
          .setTitle("Seiton: 選択範囲をコピー")
          .setIcon("copy")
          .onClick(() => {
            const selected = editor.getSelection();
            if (selected === "") {
              showToast("選択範囲がありません。");
              return;
            }
            void navigator.clipboard.writeText(selected).catch(() => {
              showToast("コピーに失敗しました。");
            });
          });
      });
    })
  );
}
