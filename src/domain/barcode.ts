/**
 * バーコード（ISBN）解析・検知の純粋ロジック。
 */

import { isValidIsbn13, normalizeIsbn } from "./isbn";

/**
 * バーコードから読み取った文字列から、有効なISBN-13を抽出する。
 * 日本の書籍の2段バーコードのうち、上段（978または979で始まるISBN）のみを受理し、
 * 下段（192で始まるCコード/価格）や規格外コードは null を返す。
 */
export function extractIsbnFromBarcode(raw: string): string | null {
  const normalized = normalizeIsbn(raw);
  if (!isValidIsbn13(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * 直近のスキャン履歴と照合し、クールダウン期間内の重複検知かどうかを判定する。
 */
export function isScanCooldown(
  isbn: string,
  lastScannedIsbn: string | null,
  lastScannedAt: number,
  now: number,
  cooldownMs = 2000
): boolean {
  if (lastScannedIsbn === isbn && now - lastScannedAt < cooldownMs) {
    return true;
  }
  return false;
}

/**
 * Web Audio API を用いて、バーコード読み取り成功時の短い電子音（「ピッ」）を再生する。
 * 外部音声ファイルが不要で、オフラインかつ即座に発音できる。
 */
export function playScanSound(): void {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1760, ctx.currentTime); // 1760Hz (A6)
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    window.setTimeout(() => {
      void ctx.close();
    }, 120);
  } catch {
    // 音声再生に失敗してもユーザー体験を阻害しない
  }
}

/**
 * モバイル端末でバーコード認識時の短い振動（触覚フィードバック）を実行する。
 */
export function triggerScanHaptic(): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(40);
    }
  } catch {
    // 振動非対応環境は無視
  }
}
