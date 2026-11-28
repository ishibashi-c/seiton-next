/**
 * 本のバーコード（ISBN）スキャナーモーダル。
 *
 * - Android 版 Obsidian（APK に CAMERA 権限がない環境）では、GitHub Pages で配信する
 *   ゼロ保存 Web スキャナー（Chrome）を起動し、`obsidian://seiton-next` URI で戻る。
 * - PC / カメラ権限のある環境では背面カメラ（ライブプレビュー）を既定にし、ガイド枠内から自動検出する。
 * - 画像ファイル選択 / D&D / 貼り付け / ISBN 手動入力・USBリーダーにも併用対応。
 * - 撮影画像を端末や Vault に一切保存しない。
 */

import { type App, Modal, Platform, setIcon } from "obsidian";
import {
  extractIsbnFromBarcode,
  formatCameraErrorMessage,
  formatScanErrorMessage,
  isScanCooldown,
  playScanSound,
  triggerScanHaptic,
} from "../../domain/barcode";
import type { BookCandidate } from "../../domain/book";
import { userMessageOf } from "../../domain/errors";
import type { BookService } from "../../services/bookService";
import { markSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";
import { BarcodeDecoder } from "./barcodeDecoder";

export const SCANNER_WEB_URL =
  "https://ishibashi-c.github.io/seiton-next/scanner/";

export function openBrowserBarcodeScanner(
  app: App,
  mode: "batch" | "single" = "batch"
): void {
  const url = `${SCANNER_WEB_URL}?mode=${encodeURIComponent(
    mode
  )}&vault=${encodeURIComponent(app.vault.getName())}`;
  window.open(url, "_blank");
}

export interface ScannedBookItem {
  authors: string;
  candidate: BookCandidate | null;
  coverUrl: string;
  error?: string;
  id: string;
  isbn: string;
  loading: boolean;
  publisher: string;
  title: string;
}

export interface BarcodeScannerModalOptions {
  /** Chrome Web スキャナー等から受け取った ISBN 群を初期キューに入れる */
  initialIsbns?: string[];
  onSaved?: (count: number) => void;
  onScanSingle?: (isbn: string) => void;
  /** 1冊だけスキャンして即時完了するモード */
  single?: boolean;
}

type StatusTone = "error" | "loading" | "success" | "warn";

interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  torch?: boolean;
}

const LIVE_SCAN_INTERVAL_MS = 180;
const PRICE_HINT_THROTTLE_MS = 1800;

export class BarcodeScannerModal extends Modal {
  private readonly bookService: BookService;
  private readonly options: BarcodeScannerModalOptions;
  private readonly decoder = new BarcodeDecoder();

  private videoEl: HTMLVideoElement | null = null;
  private fallbackEl: HTMLElement | null = null;
  private fallbackMsgEl: HTMLElement | null = null;
  private fallbackRetryBtn: HTMLButtonElement | null = null;
  private fallbackChromeBtn: HTMLButtonElement | null = null;
  private guideEl: HTMLElement | null = null;
  private torchBtn: HTMLButtonElement | null = null;
  private toggleCamBtn: HTMLButtonElement | null = null;
  private fileBtn: HTMLButtonElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;

  private queueListEl: HTMLElement | null = null;
  private countBadgeEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  private stream: MediaStream | null = null;
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scanTimer: number | null = null;
  private statusTimer: number | null = null;
  private frameIndex = 0;
  private frameInFlight = false;
  private cameraPaused = false;
  private torchOn = false;
  private isAnalyzingImage = false;
  private closed = false;

  private items: ScannedBookItem[] = [];
  private lastScannedIsbn: string | null = null;
  private lastScannedAt = 0;
  private lastPriceHintAt = 0;
  private saving = false;

  private pasteHandler: ((e: ClipboardEvent) => void) | null = null;

  constructor(
    app: App,
    bookService: BookService,
    options: BarcodeScannerModalOptions = {}
  ) {
    super(app);
    this.bookService = bookService;
    this.options = options;
  }

  override onOpen(): void {
    this.closed = false;
    markSeitonModal(this);
    this.modalEl.addClass("seiton-scanner-modal");
    this.setTitle(
      this.options.single ? "バーコードをスキャン" : "バーコードで本を追加"
    );

    this.renderUI();
    this.registerGlobalPaste();

    const initial = this.options.initialIsbns ?? [];
    if (initial.length > 0) {
      this.seedInitialIsbns(initial);
      return;
    }

    if (Platform.isAndroidApp) {
      this.showAndroidHandoff();
      return;
    }

    void this.startCamera();
  }

  override onClose(): void {
    this.closed = true;
    this.stopCamera();

    if (this.pasteHandler) {
      window.removeEventListener("paste", this.pasteHandler);
      this.pasteHandler = null;
    }
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.contentEl.empty();
    this.items = [];
    this.videoEl = null;
    this.fallbackEl = null;
    this.fallbackMsgEl = null;
    this.fallbackRetryBtn = null;
    this.fallbackChromeBtn = null;
    this.guideEl = null;
    this.torchBtn = null;
    this.toggleCamBtn = null;
    this.fileBtn = null;
    this.fileInput = null;
    this.statusEl = null;
    this.queueListEl = null;
    this.countBadgeEl = null;
    this.submitBtn = null;
    this.scratchCanvas = null;
  }

  private renderUI(): void {
    const content = this.contentEl;
    content.empty();

    this.renderCameraSection(content);
    this.renderManualInput(content);

    if (this.options.single) {
      return;
    }

    const queueSection = content.createDiv({ cls: "seiton-scanner-queue" });
    const queueHead = queueSection.createDiv({
      cls: "seiton-scanner-queue-head",
    });
    const headTitle = queueHead.createEl("h3", { text: "スキャンした本" });
    this.countBadgeEl = headTitle.createSpan({
      cls: "seiton-scanner-count-badge",
      text: "0冊",
    });

    this.queueListEl = queueSection.createDiv({
      cls: "seiton-scanner-queue-list",
    });
    this.renderQueueItems();

    const footer = content.createDiv({ cls: "seiton-modal-footer" });
    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    this.submitBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "本棚に追加 (0冊)",
    });
    this.submitBtn.disabled = true;
    this.submitBtn.addEventListener("click", () => {
      void this.saveAll();
    });
  }

  private renderCameraSection(container: HTMLElement): void {
    const wrap = container.createDiv({ cls: "seiton-scanner-viewfinder-wrap" });

    // 画像ドロップ＆貼り付けにも対応（OSカメラを起動しない純粋な画像選択）
    const fileInput = wrap.createEl("input", {
      attr: {
        accept: "image/*",
        style: "display: none;",
        type: "file",
      },
      cls: "seiton-scanner-file-input",
    });
    this.fileInput = fileInput;
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) {
        void this.scanImageFile(file);
      }
      fileInput.value = "";
    });

    wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrap.addClass("is-dragover");
    });
    wrap.addEventListener("dragleave", () => {
      wrap.removeClass("is-dragover");
    });
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      wrap.removeClass("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file?.type.startsWith("image/")) {
        void this.scanImageFile(file);
      }
    });

    // ライブカメラ領域
    const stage = wrap.createDiv({ cls: "seiton-scanner-stage" });
    const video = stage.createEl("video", {
      attr: {
        autoplay: "true",
        muted: "true",
        playsinline: "true",
      },
      cls: "seiton-scanner-video",
    });
    video.muted = true;
    video.playsInline = true;
    this.videoEl = video;

    const overlay = stage.createDiv({ cls: "seiton-scanner-overlay" });
    const guide = overlay.createDiv({ cls: "seiton-scanner-guide" });
    guide.createDiv({ cls: "seiton-scanner-guide-line" });
    this.guideEl = guide;

    overlay.createDiv({
      cls: "seiton-scanner-guide-caption",
      text: "上段のバーコード（978…）を枠内に合わせてください",
    });

    // カメラ停止・失敗・Android Chrome 連携時のフォールバック表示
    const fallback = stage.createDiv({ cls: "seiton-scanner-fallback" });
    fallback.hide();
    this.fallbackEl = fallback;
    this.fallbackMsgEl = fallback.createDiv({
      cls: "seiton-scanner-fallback-msg",
      text: "カメラを起動しています…",
    });

    const chromeBtn = fallback.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-retry-btn",
      text: "Chromeでバーコードをスキャン",
    });
    chromeBtn.hide();
    this.fallbackChromeBtn = chromeBtn;
    chromeBtn.addEventListener("click", () => {
      openBrowserBarcodeScanner(
        this.app,
        this.options.single ? "single" : "batch"
      );
      if (!this.options.single) {
        this.close();
      }
    });

    const retryBtn = fallback.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-retry-btn",
      text: "カメラを再起動",
    });
    this.fallbackRetryBtn = retryBtn;
    retryBtn.addEventListener("click", () => {
      void this.startCamera();
    });

    // コントロール行
    const controls = wrap.createDiv({ cls: "seiton-scanner-controls" });

    const toggleBtn = controls.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-ctrl-btn",
      text: "カメラを停止",
    });
    this.toggleCamBtn = toggleBtn;
    if (Platform.isAndroidApp) {
      toggleBtn.hide();
    }
    toggleBtn.addEventListener("click", () => {
      if (this.stream && !this.cameraPaused) {
        this.cameraPaused = true;
        this.stopCamera();
        this.showCameraFallback("カメラを一時停止しています。");
      } else {
        this.cameraPaused = false;
        void this.startCamera();
      }
    });

    const torchBtn = controls.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-ctrl-btn",
      text: "ライト",
    });
    torchBtn.hide();
    this.torchBtn = torchBtn;
    torchBtn.addEventListener("click", () => {
      void this.toggleTorch();
    });

    const browserBtn = controls.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-ctrl-btn",
      text: "ブラウザでスキャン",
    });
    browserBtn.addEventListener("click", () => {
      openBrowserBarcodeScanner(
        this.app,
        this.options.single ? "single" : "batch"
      );
    });

    const fileBtn = controls.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-ctrl-btn",
      text: "画像から読み取り",
    });
    this.fileBtn = fileBtn;
    fileBtn.addEventListener("click", () => {
      if (!this.isAnalyzingImage) {
        this.fileInput?.click();
      }
    });

    this.statusEl = wrap.createDiv({ cls: "seiton-scanner-status" });
  }

  private showAndroidHandoff(): void {
    this.fallbackMsgEl?.setText(
      "Android版Obsidianアプリはカメラ権限を持たないため、Chromeの高速スキャナーで読み取ってSeitonへ戻ります（画像は一切保存されません）。"
    );
    this.fallbackRetryBtn?.hide();
    this.fallbackChromeBtn?.show();
    this.fallbackEl?.show();
    this.showStatus(
      "Chromeでスキャンするか、下のISBN手入力をご利用ください。",
      "loading"
    );
  }

  private seedInitialIsbns(rawList: readonly string[]): void {
    let added = 0;
    for (const raw of rawList) {
      const isbn = extractIsbnFromBarcode(raw);
      if (!isbn || this.items.some((item) => item.isbn === isbn)) {
        continue;
      }
      const id = `scan_${Date.now()}_${added}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      this.items.push({
        authors: "",
        candidate: null,
        coverUrl: "",
        id,
        isbn,
        loading: true,
        publisher: "",
        title: "",
      });
      added += 1;
    }

    this.renderQueueItems();
    for (const item of this.items) {
      void this.lookupItem(item.id, item.isbn);
    }

    if (Platform.isAndroidApp) {
      this.fallbackMsgEl?.setText(
        `スキャンした ${added}冊 を取り込みました。内容を確認して「本棚に追加」を押してください。`
      );
      this.fallbackChromeBtn?.setText("Chromeで追加スキャン");
      this.fallbackRetryBtn?.hide();
      this.fallbackChromeBtn?.show();
      this.fallbackEl?.show();
    } else {
      this.fallbackMsgEl?.setText(
        `スキャンした ${added}冊 を取り込みました。内容を確認して「本棚に追加」を押してください。`
      );
      this.fallbackChromeBtn?.hide();
      this.fallbackRetryBtn?.setText("カメラで追加スキャン");
      this.fallbackRetryBtn?.show();
      this.fallbackEl?.show();
    }

    if (added > 0) {
      this.showStatus(`スキャンした ${added}冊 を書誌照会中…`, "loading");
    }
  }

  private async startCamera(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.stopCamera();
    this.cameraPaused = false;
    this.updateCameraToggleButton();

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      this.showCameraFallback(
        "この環境ではライブカメラを利用できません。「ブラウザでスキャン」または「画像から読み取り」をご利用ください。"
      );
      return;
    }

    this.showStatus("カメラを起動しています…", "loading");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          height: { ideal: 720 },
          width: { ideal: 1280 },
        },
      });
      if (this.closed) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }

      this.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (track) {
        await this.configureTrack(track);
      }

      if (this.videoEl) {
        this.videoEl.srcObject = stream;
        await this.videoEl.play().catch(() => undefined);
      }

      this.fallbackEl?.hide();
      this.updateCameraToggleButton();
      const engine = await this.decoder.init();
      if (this.closed) {
        return;
      }
      this.showStatus(
        engine === "native"
          ? "かざすだけで自動読み取り中（画像は保存されません）"
          : "バーコードを枠に合わせて自動読み取り中",
        "loading"
      );
      this.scheduleNextScan();
    } catch (error) {
      if (this.closed) {
        return;
      }
      this.stopCamera();
      this.showCameraFallback(formatCameraErrorMessage(error));
      this.showStatus(
        "「ブラウザでスキャン」や画像ファイル・手動入力でも登録できます。",
        "warn"
      );
    }
  }

  private async configureTrack(track: MediaStreamTrack): Promise<void> {
    if (typeof track.getCapabilities !== "function") {
      return;
    }
    try {
      const caps = track.getCapabilities() as ExtendedTrackCapabilities;
      if (
        Array.isArray(caps.focusMode) &&
        caps.focusMode.includes("continuous")
      ) {
        await track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
      }
      if (caps.torch && this.torchBtn) {
        this.torchBtn.show();
      }
    } catch {
      // 端末側で非対応の機能は無視
    }
  }

  private async toggleTorch(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) {
      return;
    }
    const next = !this.torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      this.torchOn = next;
      this.torchBtn?.toggleClass("is-active", next);
      this.torchBtn?.setText(next ? "ライト ON" : "ライト");
    } catch {
      showToast("ライトを切り替えられませんでした。");
    }
  }

  private stopCamera(): void {
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.frameInFlight = false;
    this.torchOn = false;
    this.torchBtn?.removeClass("is-active");
    this.torchBtn?.setText("ライト");
    this.torchBtn?.hide();

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
    this.updateCameraToggleButton();
  }

  private showCameraFallback(message: string): void {
    this.fallbackMsgEl?.setText(message);
    this.fallbackChromeBtn?.hide();
    this.fallbackRetryBtn?.setText("カメラを再起動");
    this.fallbackRetryBtn?.show();
    this.fallbackEl?.show();
    this.updateCameraToggleButton();
  }

  private updateCameraToggleButton(): void {
    if (!this.toggleCamBtn || Platform.isAndroidApp) {
      return;
    }
    this.toggleCamBtn.setText(this.stream ? "カメラを停止" : "カメラを開始");
  }

  private scheduleNextScan(): void {
    if (this.closed || !this.stream || this.cameraPaused) {
      return;
    }
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
    }
    this.scanTimer = window.setTimeout(() => {
      void this.scanTick();
    }, LIVE_SCAN_INTERVAL_MS);
  }

  private async scanTick(): Promise<void> {
    if (
      this.closed ||
      !this.stream ||
      this.cameraPaused ||
      this.frameInFlight ||
      this.isAnalyzingImage ||
      !this.videoEl
    ) {
      this.scheduleNextScan();
      return;
    }

    this.frameInFlight = true;
    try {
      if (!this.scratchCanvas) {
        this.scratchCanvas = document.createElement("canvas");
      }
      this.frameIndex += 1;
      const outcome = await this.decoder.detectFromVideoFrame(
        this.videoEl,
        this.scratchCanvas,
        this.frameIndex
      );
      if (this.closed) {
        return;
      }
      if (outcome.isbn) {
        this.flashGuideSuccess();
        this.handleDetectedBarcode(outcome.isbn);
      } else if (outcome.sawPriceBarcode) {
        const now = Date.now();
        if (now - this.lastPriceHintAt > PRICE_HINT_THROTTLE_MS) {
          this.lastPriceHintAt = now;
          this.showStatus(
            "下段の価格コード（192…）が読まれました。上段の 978… を枠に合わせてください。",
            "warn"
          );
        }
      }
    } finally {
      this.frameInFlight = false;
      this.scheduleNextScan();
    }
  }

  private flashGuideSuccess(): void {
    const guide = this.guideEl;
    if (!guide) {
      return;
    }
    guide.addClass("is-detected");
    window.setTimeout(() => {
      guide.removeClass("is-detected");
    }, 450);
  }

  private registerGlobalPaste(): void {
    this.pasteHandler = (e: ClipboardEvent) => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void this.scanImageFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener("paste", this.pasteHandler);
  }

  private renderManualInput(container: HTMLElement): void {
    const manualSection = container.createDiv({
      cls: "seiton-scanner-manual",
    });
    const form = manualSection.createEl("form", {
      cls: "seiton-scanner-manual-form",
    });
    const input = form.createEl("input", {
      attr: {
        autocomplete: "off",
        inputmode: "numeric",
        placeholder: "ISBN（13桁）を手入力、またはUSBリーダーで読取…",
        type: "text",
      },
      cls: "seiton-scanner-manual-input",
    });

    form.createEl("button", {
      attr: { type: "submit" },
      cls: "seiton-scanner-manual-btn",
      text: this.options.single ? "確定" : "追加",
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) {
        return;
      }
      const isbn = extractIsbnFromBarcode(raw);
      if (!isbn) {
        showToast("有効なISBN（13桁）を入力してください。");
        return;
      }
      input.value = "";
      this.handleDetectedBarcode(isbn);
      input.focus();
    });
  }

  private async scanImageFile(file: File | Blob): Promise<void> {
    if (!file.type.startsWith("image/")) {
      this.showStatus("画像ファイルを選択してください。", "error");
      return;
    }

    this.isAnalyzingImage = true;
    if (this.fileBtn) {
      this.fileBtn.disabled = true;
      this.fileBtn.setText("解析中…");
    }
    this.showStatus("画像を解析中…", "loading");

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await this.loadImage(objectUrl);
      const outcome = await this.decoder.detectFromImage(img);
      if (this.closed) {
        return;
      }

      if (!outcome.isbn) {
        const msg = outcome.sawPriceBarcode
          ? "下段の価格コード（192…）のみ検出されました。上段（978…）も写るように撮り直してください。"
          : "バーコードが見つかりませんでした。ピントを合わせて978で始まる上段バーコード全体が写るようにしてください。";
        this.showStatus(msg, "error");
        return;
      }

      this.handleDetectedBarcode(outcome.isbn);
    } catch (error) {
      this.showStatus(formatScanErrorMessage(error), "error");
    } finally {
      URL.revokeObjectURL(objectUrl);
      this.isAnalyzingImage = false;
      if (this.fileBtn) {
        this.fileBtn.disabled = false;
        this.fileBtn.setText("画像から読み取り");
      }
    }
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
      img.src = src;
    });
  }

  private showStatus(message: string, type: StatusTone): void {
    if (!this.statusEl) {
      return;
    }
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.statusEl.empty();
    this.statusEl.className = `seiton-scanner-status is-${type}`;
    this.statusEl.setText(message);

    if (type !== "loading") {
      this.statusTimer = window.setTimeout(() => {
        this.statusTimer = null;
        if (!this.statusEl) {
          return;
        }
        if (this.stream && !this.cameraPaused) {
          this.statusEl.className = "seiton-scanner-status is-loading";
          this.statusEl.setText(
            "かざすだけで自動読み取り中（画像は保存されません）"
          );
        } else {
          this.statusEl.empty();
          this.statusEl.className = "seiton-scanner-status";
        }
      }, 2800);
    }
  }

  private renderQueueItems(): void {
    const list = this.queueListEl;
    if (!list) {
      return;
    }
    list.empty();

    if (this.items.length === 0) {
      list.createDiv({
        cls: "seiton-scanner-empty",
        text: "バーコードをかざすかISBNを入力すると、ここに本が自動で追加されます。",
      });
      this.updateSubmitButton();
      return;
    }

    for (const item of this.items) {
      const card = list.createDiv({ cls: "seiton-scanner-card" });

      const coverEl = card.createDiv({ cls: "seiton-scanner-card-cover" });
      if (item.coverUrl) {
        coverEl.createEl("img", {
          attr: { alt: item.title, src: item.coverUrl },
        });
      } else {
        const placeholder = coverEl.createDiv({
          cls: "seiton-scanner-cover-placeholder",
        });
        setIcon(placeholder, "book");
      }

      const metaEl = card.createDiv({ cls: "seiton-scanner-card-meta" });
      if (item.loading) {
        metaEl.createDiv({
          cls: "seiton-scanner-card-title is-loading",
          text: `照会中… (${item.isbn})`,
        });
      } else {
        metaEl.createDiv({
          cls: "seiton-scanner-card-title",
          text: item.title || item.isbn,
        });
        const sub: string[] = [];
        if (item.authors) {
          sub.push(item.authors);
        }
        if (item.publisher) {
          sub.push(item.publisher);
        }
        if (sub.length > 0) {
          metaEl.createDiv({
            cls: "seiton-scanner-card-sub",
            text: sub.join(" · "),
          });
        }
        metaEl.createDiv({
          cls: "seiton-scanner-card-isbn",
          text: `ISBN: ${item.isbn}`,
        });
      }

      const deleteBtn = card.createEl("button", {
        attr: { "aria-label": "スキャンから削除", type: "button" },
        cls: "seiton-scanner-card-del",
      });
      setIcon(deleteBtn, "x");
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeItem(item.id);
      });
    }

    this.updateSubmitButton();
  }

  private updateSubmitButton(): void {
    const count = this.items.length;
    if (this.countBadgeEl) {
      this.countBadgeEl.setText(`${count}冊`);
    }
    if (this.submitBtn) {
      this.submitBtn.setText(`本棚に追加 (${count}冊)`);
      this.submitBtn.disabled = count === 0 || this.saving;
    }
  }

  private removeItem(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
    this.renderQueueItems();
  }

  private handleDetectedBarcode(isbn: string): void {
    const now = Date.now();
    if (isScanCooldown(isbn, this.lastScannedIsbn, this.lastScannedAt, now)) {
      return;
    }

    this.lastScannedIsbn = isbn;
    this.lastScannedAt = now;

    if (this.options.single) {
      playScanSound();
      triggerScanHaptic();
      this.options.onScanSingle?.(isbn);
      this.close();
      return;
    }

    if (this.items.some((item) => item.isbn === isbn)) {
      this.showStatus(`ISBN: ${isbn} はすでにリストにあります`, "warn");
      return;
    }

    playScanSound();
    triggerScanHaptic();
    this.showStatus(`ISBN: ${isbn} を読み取りました`, "success");

    const id = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newItem: ScannedBookItem = {
      authors: "",
      candidate: null,
      coverUrl: "",
      id,
      isbn,
      loading: true,
      publisher: "",
      title: "",
    };
    this.items.unshift(newItem);
    this.renderQueueItems();

    void this.lookupItem(id, isbn);
  }

  private async lookupItem(id: string, isbn: string): Promise<void> {
    try {
      const result = await this.bookService.lookupIsbn(isbn);
      const candidate = result.candidate;
      const target = this.items.find((item) => item.id === id);
      if (!target || this.closed) {
        return;
      }
      target.loading = false;
      if (candidate) {
        target.candidate = candidate;
        target.title = candidate.title;
        target.authors = candidate.authors.join(", ");
        target.publisher = candidate.publisher;
        target.coverUrl = candidate.coverUrl ?? "";
      } else {
        target.title = `ISBN: ${isbn}`;
      }
      this.renderQueueItems();
    } catch {
      const target = this.items.find((item) => item.id === id);
      if (target && !this.closed) {
        target.loading = false;
        target.title = `ISBN: ${isbn}`;
        this.renderQueueItems();
      }
    }
  }

  private async saveAll(): Promise<void> {
    if (this.items.length === 0 || this.saving) {
      return;
    }
    this.saving = true;
    this.updateSubmitButton();

    let successCount = 0;
    try {
      for (const item of this.items) {
        const candidate = item.candidate;
        await this.bookService.createBook({
          authors: item.authors,
          category: "",
          coverUrl: item.coverUrl,
          isbn: item.isbn,
          publisher: item.publisher,
          readingStatus: "tbr",
          title: item.title || candidate?.title || item.isbn,
        });
        successCount += 1;
      }

      showToast(`${successCount}冊の本を本棚に追加しました。`);
      this.options.onSaved?.(successCount);
      this.close();
    } catch (error) {
      showToast(`追加中にエラーが発生しました: ${userMessageOf(error)}`);
      this.saving = false;
      this.updateSubmitButton();
    }
  }
}
