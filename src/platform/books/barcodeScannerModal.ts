/**
 * 本のバーコード（ISBN）スキャナーモーダル。
 * カメラ映像からEAN-13（ISBN）を自動認識し、連続スキャン＆一括追加を行う。
 */

import {
  BarcodeFormat,
  BrowserCodeReader,
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import { type App, Modal, setIcon } from "obsidian";
import {
  extractIsbnFromBarcode,
  isScanCooldown,
  playScanSound,
  triggerScanHaptic,
} from "../../domain/barcode";
import type { BookCandidate } from "../../domain/book";
import { userMessageOf } from "../../domain/errors";
import type { BookService } from "../../services/bookService";
import { markSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

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
  onSaved?: (count: number) => void;
  onScanSingle?: (isbn: string) => void;
  /** 1冊だけスキャンして即時完了するモード */
  single?: boolean;
}

export class BarcodeScannerModal extends Modal {
  private readonly bookService: BookService;
  private readonly options: BarcodeScannerModalOptions;

  private reader: BrowserMultiFormatReader | null = null;
  private controls: IScannerControls | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private flashTimer: number | null = null;
  private noticeEl: HTMLElement | null = null;
  private noticeTimer: number | null = null;

  private queueListEl: HTMLElement | null = null;
  private countBadgeEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  private items: ScannedBookItem[] = [];
  private lastScannedIsbn: string | null = null;
  private lastScannedAt = 0;
  private isScanning = false;
  private videoDevices: MediaDeviceInfo[] = [];
  private currentDeviceIndex = 0;
  private saving = false;

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
    markSeitonModal(this);
    this.modalEl.addClass("seiton-scanner-modal");
    this.setTitle(
      this.options.single ? "バーコードをスキャン" : "バーコードで本を追加"
    );

    this.renderUI();
    void this.startScanner();
  }

  override onClose(): void {
    this.stopScanner();
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.contentEl.empty();
    this.items = [];
    this.videoEl = null;
    this.overlayEl = null;
    this.noticeEl = null;
    this.queueListEl = null;
    this.countBadgeEl = null;
    this.submitBtn = null;
  }

  private renderUI(): void {
    const content = this.contentEl;
    content.empty();

    // 1. スキャナー上部（ファインダー）
    const viewport = content.createDiv({ cls: "seiton-scanner-viewport" });

    const video = viewport.createEl("video", {
      attr: {
        autoplay: "true",
        muted: "true",
        playsinline: "true",
      },
      cls: "seiton-scanner-video",
    });
    this.videoEl = video;

    const overlay = viewport.createDiv({ cls: "seiton-scanner-overlay" });
    this.overlayEl = overlay;

    // ガイド枠
    const frame = overlay.createDiv({ cls: "seiton-scanner-frame" });
    frame.createDiv({ cls: "seiton-scanner-laser" });

    // 一時通知メッセージ（「すでに追加されています」など）
    this.noticeEl = overlay.createDiv({ cls: "seiton-scanner-notice" });

    // カメラ操作ボタン（カメラ切替）
    const controlsBar = overlay.createDiv({ cls: "seiton-scanner-controls" });
    const switchCamBtn = controlsBar.createEl("button", {
      attr: { "aria-label": "カメラを切り替え", type: "button" },
      cls: "seiton-scanner-btn",
    });
    setIcon(switchCamBtn, "switch-camera");
    switchCamBtn.addEventListener("click", () => {
      void this.switchCamera();
    });

    content.createEl("p", {
      cls: "seiton-scanner-hint",
      text: "本の裏表紙のバーコード（上段のISBN）を枠に合わせてください。",
    });

    // 2. 単体スキャンモードの場合はキュー一覧は不要
    if (this.options.single) {
      return;
    }

    // 3. 連続スキャン用キュー一覧
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

    // 4. フッター（保存・キャンセル）
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

  private renderQueueItems(): void {
    const list = this.queueListEl;
    if (!list) {
      return;
    }
    list.empty();

    if (this.items.length === 0) {
      list.createDiv({
        cls: "seiton-scanner-empty",
        text: "バーコードをかざすと、ここに本が自動で追加されます。",
      });
      this.updateSubmitButton();
      return;
    }

    for (const item of this.items) {
      const card = list.createDiv({ cls: "seiton-scanner-card" });

      // 表紙サムネイル
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

      // 書誌情報
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

      // 削除ボタン
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

  private showNotice(message: string): void {
    if (!this.noticeEl) {
      return;
    }
    this.noticeEl.setText(message);
    this.noticeEl.addClass("is-visible");
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = window.setTimeout(() => {
      this.noticeTimer = null;
      this.noticeEl?.removeClass("is-visible");
    }, 1800);
  }

  private flashSuccess(): void {
    if (!this.overlayEl) {
      return;
    }
    this.overlayEl.addClass("is-success");
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
    }
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null;
      this.overlayEl?.removeClass("is-success");
    }, 400);
  }

  private async startScanner(): Promise<void> {
    if (!this.videoEl) {
      return;
    }
    try {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
      this.reader = new BrowserMultiFormatReader(hints);

      // 利用可能なビデオ入力デバイスを取得
      const devices = await BrowserCodeReader.listVideoInputDevices();
      this.videoDevices = devices;

      let selectedDeviceId: string | undefined;
      if (devices.length > 0) {
        // 背面カメラ（environment）を優先的に探す
        const backCameraIndex = devices.findIndex((d) =>
          /back|rear|environment/iu.test(d.label)
        );
        this.currentDeviceIndex = backCameraIndex >= 0 ? backCameraIndex : 0;
        selectedDeviceId = devices[this.currentDeviceIndex]?.deviceId;
      }

      this.isScanning = true;
      this.controls = await this.reader.decodeFromVideoDevice(
        selectedDeviceId,
        this.videoEl,
        (result) => {
          if (!this.isScanning || !result) {
            return;
          }
          const text = result.getText();
          this.handleDetectedBarcode(text);
        }
      );
    } catch (error) {
      showToast(`カメラの起動に失敗しました: ${userMessageOf(error)}`);
    }
  }

  private async switchCamera(): Promise<void> {
    if (this.videoDevices.length <= 1) {
      this.showNotice("切り替え可能なカメラがありません");
      return;
    }
    this.currentDeviceIndex =
      (this.currentDeviceIndex + 1) % this.videoDevices.length;
    const device = this.videoDevices[this.currentDeviceIndex];
    if (!device) {
      return;
    }

    this.stopScanner();
    try {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
      this.reader = new BrowserMultiFormatReader(hints);
      this.isScanning = true;
      if (this.videoEl) {
        this.controls = await this.reader.decodeFromVideoDevice(
          device.deviceId,
          this.videoEl,
          (result) => {
            if (!this.isScanning || !result) {
              return;
            }
            this.handleDetectedBarcode(result.getText());
          }
        );
      }
      this.showNotice(device.label || `カメラ ${this.currentDeviceIndex + 1}`);
    } catch (error) {
      showToast(`カメラ切替に失敗しました: ${userMessageOf(error)}`);
    }
  }

  private stopScanner(): void {
    this.isScanning = false;
    if (this.controls) {
      this.controls.stop();
      this.controls = null;
    }
    this.reader = null;
  }

  private handleDetectedBarcode(rawText: string): void {
    const isbn = extractIsbnFromBarcode(rawText);
    if (!isbn) {
      return;
    }

    const now = Date.now();
    if (isScanCooldown(isbn, this.lastScannedIsbn, this.lastScannedAt, now)) {
      return;
    }

    this.lastScannedIsbn = isbn;
    this.lastScannedAt = now;

    // 単体スキャンモードの場合
    if (this.options.single) {
      playScanSound();
      triggerScanHaptic();
      this.flashSuccess();
      this.options.onScanSingle?.(isbn);
      this.close();
      return;
    }

    // すでにスキャンリストにあるか確認
    if (this.items.some((item) => item.isbn === isbn)) {
      this.showNotice("すでに追加されています");
      return;
    }

    // 読み取り成功
    playScanSound();
    triggerScanHaptic();
    this.flashSuccess();

    // キューに追加
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
    this.items.unshift(newItem); // 最新を先頭へ
    this.renderQueueItems();

    // バックグラウンドで書誌照会
    void this.lookupItem(id, isbn);
  }

  private async lookupItem(id: string, isbn: string): Promise<void> {
    try {
      const result = await this.bookService.lookupIsbn(isbn);
      const candidate = result.candidate;
      const target = this.items.find((item) => item.id === id);
      if (!target) {
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
      if (target) {
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
