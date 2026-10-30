/**
 * 表紙画像が「表紙なし」の代替画像かどうかを判定する。
 *
 * Google Books は表紙が無い本に対して、灰色に斜線バーを載せた共通の画像を返す。
 * サイズによってハッシュが変わるため、既知のハッシュと画素の統計の両方で見る。
 */

/** これまでに確認したGoogleの代替画像（128px / 300px）。 */
export const COVER_PLACEHOLDER_HASHES: readonly string[] = [
  "a9af512c1e52ed9cafd06b8f212bf13940976703ee3a38573df558e28ce31a21",
  "3efa8c43e5b4348f303a528c81adf435f0111ea752fe9f0f6241478b60987fa6",
];

export interface ImageStats {
  /** 彩度の平均（0〜1）。灰色なら0に近い。 */
  saturation: number;
  /** 明度の標準偏差（0〜255）。一様な画像ほど小さい。 */
  stddev: number;
}

/** 既知の代替画像ハッシュか。 */
export function isPlaceholderHash(hash: string): boolean {
  return COVER_PLACEHOLDER_HASHES.includes(hash.toLowerCase());
}

/**
 * 画素の統計から代替画像とみなすか。
 * 灰色（彩度がほぼ無い）かつ一様（明度のばらつきが小さい）なら表紙ではない。
 */
export function isLikelyPlaceholder(stats: ImageStats): boolean {
  return stats.saturation < 0.04 && stats.stddev < 14;
}
