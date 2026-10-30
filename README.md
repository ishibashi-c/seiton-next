# Seiton

Obsidian 用の、個人の記録・整理・再発見プラグインです。
思いつきを一言メモとして残し、あとからライブラリで見つけ、プロジェクトやプロンプトを再開するための6つの画面を持ちます。

- **ホーム** — 今日のメモ入力、続きから、最近の記録
- **つぶやき** — 日付ごとのメモ一覧
- **ライブラリ** — ノート・本・Webクリップ・アイデアを横断して探す
- **本棚** — 表紙付きの蔵書管理（カーリルで近くの図書館の蔵書も確認）
- **プロジェクト** — 目的ごとの再開地点
- **Prompt Workbench** — 指示の下書きと履歴

## インストール

[BRAT](https://github.com/TfTHacker/obsidian42-brat) を使う場合:

1. BRAT を入れ、`Add beta plugin` に `ishibashi-c/seiton-next` を指定
2. バージョンを選んで有効化

手動の場合は、[Releases](https://github.com/ishibashi-c/seiton-next/releases) から
`main.js`、`manifest.json`、`styles.css` をダウンロードし、
Vault の `.obsidian/plugins/seiton-next/` に置いてください。

## 保存形式

- 一言メモ: `Seiton/System/Logs/Memos/` の週次 Markdown に追記
- プロンプト: `Seiton/System/Logs/Prompts/` のセッション Markdown
- ノート: `Seiton/Notes/` の Markdown（分類は frontmatter の `kind`）
- 表紙: `Seiton/System/Assets/Covers/`

同期機能は持ちません。保存の成功は「その端末の Vault に書けた」ことを意味し、
同期は Remotely Save など既存の仕組みに任せます。

## 開発

```sh
pnpm install
pnpm build      # styles.css の生成 + 型チェック + esbuild
pnpm test       # vitest
pnpm lint       # biome
```

`styles.css` は `src/styles/` から `scripts/build-styles.mjs` が生成します。
直接編集せず、`src/styles/` を変更してください。

## ライセンス

未設定（個人用）。再利用したい場合は issue で連絡してください。
