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
