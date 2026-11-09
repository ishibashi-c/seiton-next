/** 新Seiton の保存先。プロジェクト固有の意味分類フォルダは作らない。 */
export const SYSTEM_FOLDER = "Seiton/System";
export const MEMOS_FOLDER = `${SYSTEM_FOLDER}/Logs/Memos`;
export const PROMPTS_FOLDER = `${SYSTEM_FOLDER}/Logs/Prompts`;
export const NOTES_FOLDER = "Seiton/Notes";
/** ホームのショートカット。設定ではなくVault内のノートに置く。 */
export const LINKS_FILE = `${SYSTEM_FOLDER}/Links.md`;
/** 授業の当学期・履修科目台帳。Vault内のMarkdownに保存し端末間で同期する。 */
export const COURSES_FILE = `${SYSTEM_FOLDER}/Courses.md`;
export const ASSETS_FOLDER = `${SYSTEM_FOLDER}/Assets`;
export const VIEWS_FOLDER = `${SYSTEM_FOLDER}/Views`;
export const TEMPLATES_FOLDER = `${SYSTEM_FOLDER}/Templates`;
export const ARCHIVE_FOLDER = `${SYSTEM_FOLDER}/Archive`;
export const MIGRATION_FOLDER = `${SYSTEM_FOLDER}/Migration`;
export const VIEW_TYPE_HOME = "seiton-next-home";
export const VIEW_TYPE_TSUBUYAKI = "seiton-next-tsubuyaki";
export const VIEW_TYPE_PROMPT = "seiton-next-prompt";
export const PLUGIN_ID = "seiton-next";

export function memosFolderPath(): string {
  return MEMOS_FOLDER;
}

export function memoFilePath(week: string): string {
  return `${MEMOS_FOLDER}/${week}.md`;
}

export const VIEW_TYPE_LIBRARY = "seiton-next-library";
export const VIEW_TYPE_BOOKSHELF = "seiton-next-bookshelf";
export const VIEW_TYPE_CLASSES = "seiton-next-classes";
export const VIEW_TYPE_PROJECTS = "seiton-next-projects";
export const VIEW_TYPE_ASSETS = "seiton-next-assets";
