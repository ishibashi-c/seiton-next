/**
 * タブ切り替えモーション制御（v0.7.0 より即時応答 0ms 化のため No-op）。
 * インターフェース互換性のためにエクスポートを維持し、アニメーション処理を排して即時表示する。
 */

export type TabDirection = 1 | -1;

export function beginTabMotion(
  _fromType: string,
  _toType: string,
  _fromIndex: number,
  _toIndex: number
): void {
  // No-op: Instant tab switch
}

export function clearTabMotion(): void {
  // No-op: Instant tab switch
}

export function applyTabEnter(_container: HTMLElement, _type: string): void {
  // No-op: Instant tab switch
}
