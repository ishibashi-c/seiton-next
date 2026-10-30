import type { App, Plugin } from "obsidian";
import {
  Notice,
  PluginSettingTab,
  Setting,
  type TextComponent,
} from "obsidian";
import { WEB_CLIP_BOOKMARKLET } from "../domain/webclip";
import type { SeitonSettings } from "../services/settings";

export interface SettingsHost {
  saveSettings(patch: Partial<SeitonSettings>): Promise<void>;
  settings: SeitonSettings;
}

export class SeitonSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost & Plugin;

  constructor(app: App, host: SettingsHost & Plugin) {
    super(app, host);
    this.host = host;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Seiton" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "記録、検索、本棚、プロンプトをこのVaultで使うための設定です。変更はその場で保存されます。",
    });

    containerEl.createEl("h3", { text: "本と表紙" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "本の表紙を自動で取得するための設定です。キーがなくても、本の登録と仮表紙は使えます。",
    });
    new Setting(containerEl)
      .setName("Google Books APIキー")
      .setDesc(
        "表紙の取得に使います。未設定の場合はOpen Libraryを使います。キーはこのVaultの設定にだけ保存されます。"
      )
      .addText((text: TextComponent) => {
        text.inputEl.type = "password";
        text
          .setValue(this.host.settings.googleBooksApiKey)
          .onChange((value) => {
            void this.host.saveSettings({ googleBooksApiKey: value.trim() });
          });
      });

    containerEl.createEl("h3", { text: "図書館の蔵書" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "カーリルを使って、近くの図書館に本があるか調べます。APIキーがなくても本棚は使えます。",
    });
    new Setting(containerEl)
      .setName("カーリル APIキー")
      .setDesc(
        "蔵書検索に使います。未設定の場合、本の登録や表紙取得はそのまま使えます。"
      )
      .addText((text: TextComponent) => {
        text.inputEl.type = "password";
        text.setValue(this.host.settings.calilApiKey).onChange((value) => {
          void this.host.saveSettings({ calilApiKey: value.trim() });
        });
      });

    new Setting(containerEl)
      .setName("図書館を追加")
      .setDesc(
        "調べたい図書館のIDを入力します。複数はカンマ区切り。IDが分からない場合は、下の「カーリルで図書館を探す」から確認できます。"
      )
      .addText((text: TextComponent) => {
        text.setValue(this.host.settings.calilLibrary).onChange((value) => {
          void this.host.saveSettings({ calilLibrary: value.trim() });
        });
      })
      .addButton((button) => {
        button.setButtonText("カーリルで図書館を探す").onClick(() => {
          window.open("https://calil.jp/library", "_blank", "noopener");
        });
      });

    const libraryAdvanced = containerEl.createEl("details", {
      cls: "seiton-settings-advanced",
    });
    libraryAdvanced.createEl("summary", {
      text: "IDの形式（上級者向け）",
    });
    libraryAdvanced.createEl("p", {
      cls: "setting-item-description",
      text: "システムIDを入力します（例: Univ_Kindai）。館を限定する場合は Univ_Kindai:108154 のように :libid を付けます。図書館名では検索できません。",
    });

    containerEl.createEl("h3", { text: "Webクリップ" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "WebページをSeitonに保存するための設定です。保存したページはWebクリップとして本棚やライブラリに表示されます。",
    });
    new Setting(containerEl)
      .setName("PCブックマークレット")
      .setDesc("ブラウザのブックマークに登録して、ページを保存します。")
      .addButton((button) => {
        button.setButtonText("コードをコピー").onClick(async () => {
          try {
            await navigator.clipboard.writeText(WEB_CLIP_BOOKMARKLET);
            new Notice("ブックマークレットをコピーしました。");
          } catch {
            new Notice(
              "コピーできませんでした。下のコードを選択してください。"
            );
          }
        });
      });
    const code = containerEl.createEl("pre", { cls: "seiton-bookmarklet" });
    code.createEl("code", { text: WEB_CLIP_BOOKMARKLET });

    const webClipAdvanced = containerEl.createEl("details", {
      cls: "seiton-settings-advanced",
    });
    webClipAdvanced.createEl("summary", {
      text: "保存の仕組み（上級者向け）",
    });
    webClipAdvanced.createEl("p", {
      cls: "setting-item-description",
      text: "保存時にページを取得し、Defuddleで本文をMarkdownにします。プレビュー取得は明示操作時だけ行い、localhostやプライベートIPは拒否します。",
    });

    new Setting(containerEl)
      .setName("ページのプレビューを取得")
      .setDesc(
        "Webクリップ保存時に、タイトル・説明・画像を取得します。オフにすると本文だけを保存します。"
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.host.settings.enableUrlPreview)
          .onChange((value) => {
            void this.host.saveSettings({ enableUrlPreview: value });
          });
      });

    containerEl.createEl("h3", { text: "ホーム" });
    new Setting(containerEl)
      .setName("ショートカットにfaviconを表示")
      .setDesc(
        "ホームのショートカットにサイトのアイコンを表示します。外部通信が発生し、取得できない場合は頭文字になります。"
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.host.settings.shortcutFavicons)
          .onChange((value) => {
            void this.host.saveSettings({ shortcutFavicons: value });
          });
      });

    containerEl.createEl("h3", { text: "検索" });
    new Setting(containerEl)
      .setName("検索結果の上限")
      .setDesc("ライブラリで一度に描画する最大件数です。")
      .addText((text: TextComponent) => {
        text.inputEl.type = "number";
        text
          .setValue(String(this.host.settings.maxSearchResults))
          .onChange((value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              void this.host.saveSettings({ maxSearchResults: parsed });
            }
          });
      });
  }
}
