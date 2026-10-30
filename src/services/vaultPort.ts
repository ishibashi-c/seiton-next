/**
 * Obsidian Vault API の薄い境界。サービス層はこのインターフェースだけに依存する。
 */

export interface VaultPort {
  /** 既存ファイルを上書きしない作成。存在すれば例外。 */
  create(path: string, data: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  exists(path: string): boolean;
  /** フォルダ直下のMarkdownファイルのVault絶対パス。 */
  listMarkdown(folder: string): Promise<string[]>;
  /** 最終更新時刻（ミリ秒）。存在しなければ0。 */
  mtime(path: string): number;
  /** 読み込み・変更・書き込みを1回のAPI呼び出しで行う。 */
  process(path: string, transform: (data: string) => string): Promise<string>;
  read(path: string): Promise<string>;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
