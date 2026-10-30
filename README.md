# Seiton

Obsidian の中で、思いつきを残し、あとから見つけ、再開するためのプラグインです。
メモ・ノート・本・Webクリップ・プロジェクト・プロンプトを、ひとつの Vault の中で扱います。

- 一言メモは**週ごとの Markdown** に追記するので、あとから通常のノートとして読めます
- すべてのデータは Markdown と Properties。プラグインを外しても内容は残ります
- 同期機能は持ちません。保存は「その端末の Vault に書けた」ところまで

対応: Obsidian 1.12.7 以降 / デスクトップ・モバイル

## 画面

| 画面 | 何をするか |
|---|---|
| **ホーム** | 今日のメモを書く。続きから、よく使うもの、最近の記録を見る |
| **つぶやき** | 書いたメモを日付ごとに読む・直す・削除する |
| **ライブラリ** | ノート・本・Webクリップ・アイデア・記事を種類と整理状態で絞り込む |
| **本棚** | 表紙つきで蔵書を並べる。カーリルで近くの図書館の蔵書を確認する |
| **プロジェクト** | 目的ごとのノートとセッションをまとめ、再開する |
| **Prompt Workbench** | 指示の下書きを書き、コピーして履歴に残す（AIへは送信しません） |

## インストール

### BRAT を使う

1. [BRAT](https://github.com/TfTHacker/obsidian42-brat) をインストールして有効化
2. コマンドパレットから `BRAT: Add a beta plugin for testing`
3. `ishibashi-c/seiton-next` を入力
4. 設定 → コミュニティプラグイン で **Seiton** を有効化

### 手動

[Releases](https://github.com/ishibashi-c/seiton-next/releases) から `main.js`、`manifest.json`、
`styles.css` をダウンロードし、Vault の `.obsidian/plugins/seiton-next/` に置いて Obsidian を再読み込みします。

## 使い方の流れ

1. **ホーム**で思いつきを書いて保存する（`Cmd/Ctrl + Enter`）
2. **ライブラリ**で種類・整理状態・検索から探す
3. 本は**本棚**で登録し、読書状態（積読 / 読書中 / 読了）を更新する
4. 目的のある作業は**プロジェクト**にまとめ、**Prompt**で指示を書いてコピーする

## 保存されるもの

| 内容 | 場所 |
|---|---|
| 一言メモ | `Seiton/System/Logs/Memos/YYYY-Www.md` |
| プロンプトのセッション | `Seiton/System/Logs/Prompts/` |
| ノート・本・Webクリップ | `Seiton/Notes/`（分類は frontmatter の `kind`） |
| 表紙画像 | `Seiton/System/Assets/Covers/{ISBN}.jpg` |
| テンプレート | `Seiton/System/Templates/` |
| Bases ビュー | `Seiton/System/Views/` |

ノートの分類はフォルダではなく `kind`（`note` / `class` / `idea` / `article` / `book` / `webclip` /
`project` など）で持ちます。フォルダを移動しても壊れません。

## 設定

設定 → **Seiton** から設定します。変更はその場で保存されます。

| 設定 | 用途 | 未設定のとき |
|---|---|---|
| Google Books APIキー | 表紙の取得 | Open Library を使う |
| カーリル APIキー | 近隣図書館の蔵書検索 | 本の登録と表紙取得は使える |
| 図書館を追加 | 調べる図書館のシステムID（`Univ_Kindai`、館を絞るなら `Univ_Kindai:108154`） | 蔵書検索は使えない |
| PCブックマークレット | ブラウザからWebクリップを保存 | Webクリップは手動登録のみ |

APIキーは Vault の `.obsidian/plugins/seiton-next/data.json` にのみ保存されます。
同期の対象外なので、端末ごとに設定してください。

## 主なコマンド

- 画面: `ホームを開く` / `つぶやきを開く` / `ライブラリを開く` / `本棚を開く` / `プロジェクトを開く` / `Prompt Workbenchを開く`
- 記録: `メモを追加`、`新しいノート`、`今週の一言メモを開く`
- 本: `書籍を追加`、`書籍を一括編集`、`ISBNをまとめて追加`、`カーリルで一括検索`、`表紙キャッシュを管理`
- 整理: `ライブラリを検索`、`整理トレイを開く`、`未整理を1件ずつ整理`、`Basesビューを開く`

## 外部との通信

Seiton はテレメトリを送りません。次の操作をしたときだけ、外部へ問い合わせます。

| 操作 | 送信先 | 内容 |
|---|---|---|
| 表紙の取得 | Google Books API / Open Library | ISBN・書名 |
| 蔵書検索 | カーリル API | ISBN・図書館ID |
| Webクリップの保存 | 対象ページ | タイトル・説明・OGP画像 |

URL の取得は http/https のみで、localhost・プライベートIP・`.local` は拒否します。

## 同期

同期機能は持ちません。Remotely Save など既存の仕組みと組み合わせてください。

- 保存の成功は「その端末の Vault に書けた」ことを意味します。クラウドへの反映ではありません
- 競合を自動マージしません。週次メモは追記型なので、同じ週に複数端末で書くと片方が消えることがあります
- 同期を使う場合は、書き込み前に同期・書き込み後に同期する運用にしてください

## 制限事項

- モバイルのレイアウトは狭幅（430px）で確認していますが、Android実機での確認は未実施です
- 表紙は取得元の解像度に依存します（128px の本は拡大されて粗く見えます）
- 本棚のカーリル検索は、館を絞り込んでも `/check` はシステム全体に問い合わせます
- 週次メモ・セッションは1ファイル追記型のため、同時編集に弱いです

## 開発

```sh
pnpm install
pnpm build      # styles.css の生成 + 型チェック + esbuild
pnpm test       # vitest
pnpm lint       # biome
```

`styles.css` は `src/styles/` から `scripts/build-styles.mjs` が生成します。直接編集せず、
`src/styles/` を変更してビルドしてください。

```
src/
  domain/     純粋なロジック（frontmatter、リンク、ISO週、カーリル、Google Books）
  services/   Vault の読み書き、索引、保存
  platform/   画面とモーダル（Obsidian の API に触れる層）
  styles/     CSS のソース
```

## ライセンス

MIT License. 全文は [LICENSE](LICENSE)。

商用利用、改変、再配布、販売を含めて自由に使えます。著作権表示とこの許諾文を残してください。
