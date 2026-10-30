/**
 * 新Seiton の共通エラー。UIは code ではなく userMessage をそのまま表示してよい。
 */

export type SeitonErrorCode =
  | "EMPTY_MEMO"
  | "FOREIGN_FILE"
  | "INVALID_WEEK"
  | "MEMO_FORMAT"
  | "MEMO_ID_DUPLICATE"
  | "MEMO_NOT_FOUND"
  | "MEMO_STATE"
  | "PROMOTION_CONFLICT"
  | "PROMOTION_VERIFY_FAILED"
  | "VAULT_IO";

export interface SeitonErrorOptions {
  detail?: string;
  originalError?: unknown;
}

export class SeitonError extends Error {
  readonly code: SeitonErrorCode;
  readonly detail: string | undefined;
  readonly originalError: unknown;

  constructor(
    code: SeitonErrorCode,
    message: string,
    options: SeitonErrorOptions = {}
  ) {
    super(message);
    this.name = "SeitonError";
    this.code = code;
    this.detail = options.detail;
    this.originalError = options.originalError;
  }
}

export function isSeitonError(error: unknown): error is SeitonError {
  return error instanceof SeitonError;
}

/** 想定外の例外を、UIで表示できるエラーへ包む。 */
export function toSeitonError(
  error: unknown,
  fallbackMessage = "保存に失敗しました。入力内容は残っています。"
): SeitonError {
  if (isSeitonError(error)) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new SeitonError("VAULT_IO", fallbackMessage, {
    detail,
    originalError: error,
  });
}

/**
 * HTTPステータスを、利用者に意味の通る日本語へ言い換える。
 * 数字そのものは内部（detail・ログ）に残し、画面には出さない。
 */
export function httpStatusHint(status: number): string {
  if (status === 400) {
    return "リクエストの内容が受け付けられませんでした";
  }
  if (status === 401) {
    return "認証が必要です。APIキーを確認してください";
  }
  if (status === 403) {
    return "アクセスが拒否されました。APIキーか利用制限を確認してください";
  }
  if (status === 404) {
    return "見つかりませんでした";
  }
  if (status === 408 || status === 504) {
    return "応答が返ってきませんでした";
  }
  if (status === 429) {
    return "回数制限に達しました。しばらく待ってから試してください";
  }
  if (status >= 500) {
    return "相手先のサービスで問題が起きています。時間をおいて試してください";
  }
  return "通信できませんでした";
}

/** UI表示用。内部エラーの詳細はログへ、画面には短い説明を出す。 */
export function userMessageOf(error: unknown): string {
  if (isSeitonError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "不明なエラーが発生しました。";
}
