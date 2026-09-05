type FileStatus = "checking" | "ready" | "no-header" | "unknown" | "cleaned" | "error";

interface HeaderCandidate {
  type: "LoROM" | "HiROM" | "ExHiROM";
  offset: number;
}

/*
 * validateSnesHeader() either bails out early with just a score (nothing
 * else has been computed yet), or runs to completion and returns every
 * field it read -- there's no in-between, so a two-case union models it
 * exactly.
 */
interface InvalidHeader {
  valid: false;
  score: number;
}

interface ValidHeader {
  valid: true;
  score: number;
  mapMode: number;
  romType: number;
  romSize: number;
  romSizeCode: number;
  ramSizeCode: number;
  country: number;
  license: number;
  version: number;
  checksum: number;
  checksumComplement: number;
  checksumPairValid: boolean;
  resetVector: number;
  resetVectorValid: boolean;
  title: string;
}

type ValidationResult = InvalidHeader | ValidHeader;

interface DetectionUnknown {
  hasHeader: false;
  type: null;
  headerSize: 0;
  confidence: "unknown";
  reason: string;
  // Present so `entry.detection?.title` type-checks without narrowing
  // the union first -- there's no title when no header was detected.
  title?: undefined;
}

interface DetectionFound {
  hasHeader: boolean;
  type: HeaderCandidate["type"];
  headerSize: number;
  confidence: "high";
  score: number;
  title: string;
  romSize: number;
  mapMode: number;
  checksum: number;
  checksumComplement: number;
  resetVector: number;
}

type Detection = DetectionUnknown | DetectionFound;

interface FileEntry {
  file: File;
  status: FileStatus;
  detection: Detection | null;
  buffer: ArrayBuffer | null;
  cleaned: Blob | null;
}

/*
 * SNES internal header locations.
 *
 * Normal:
 *   LoROM   0x7FC0
 *   HiROM   0xFFC0
 *
 * ExHiROM:
 *   0x40FFC0
 */
const HEADER_CANDIDATES: HeaderCandidate[] = [
  { type: "LoROM", offset: 0x7fc0 },
  { type: "HiROM", offset: 0xffc0 },
  { type: "ExHiROM", offset: 0x40ffc0 }
];

// Headered ROMs carry a 512-byte copier header, so everything moves by this amount.
const COPIER_HEADER_SIZE = 0x200;

// Common LoROM/HiROM and extended map modes.
const VALID_MAP_MODES: ReadonlySet<number> = new Set([
  0x20, 0x21, 0x22, 0x23, 0x25,
  0x30, 0x31, 0x32, 0x35,
  0x3a, 0x3b
]);

// Length, in bytes, of the game title field in the SNES header.
const TITLE_LENGTH = 21;

// Gap between each staggered download; see downloadFiles().
const DOWNLOAD_STAGGER_MS = 300;

const STATUS_LABELS: Record<FileStatus, string> = {
  checking: "Checking…",
  ready: "✓ 512-byte header",
  "no-header": "— No header",
  unknown: "⚠ Unknown",
  cleaned: "✓ Header removed",
  error: "✕ Error"
};

class SnesHeaderCleaner extends HTMLElement {
  files: FileEntry[] = [];
  private initialized = false;

  input!: HTMLInputElement;
  dropzone!: HTMLLabelElement;
  fileList!: HTMLDivElement;
  summary!: HTMLDivElement;
  cleanButton!: HTMLButtonElement;
  downloadButton!: HTMLButtonElement;
  clearButton!: HTMLButtonElement;

  /*
   * Custom element constructors aren't allowed to add children to the
   * element itself (only to a shadow root), so the DOM is built in
   * connectedCallback() instead, once the element is actually in the
   * document.
   */
  connectedCallback(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    this.render();
    this.setupEvents();
  }

  setupEvents(): void {
    this.input.addEventListener("change", () => {
      // input.files is never null for <input type="file">.
      this.addFiles(this.input.files!);
      this.input.value = "";
    });

    this.dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      this.dropzone.classList.add("dragover");
    });

    this.dropzone.addEventListener("dragleave", () => {
      this.dropzone.classList.remove("dragover");
    });

    this.dropzone.addEventListener("drop", (event: DragEvent) => {
      event.preventDefault();
      this.dropzone.classList.remove("dragover");
      // A "drop" event always carries a dataTransfer.
      this.addFiles(event.dataTransfer!.files);
    });

    this.cleanButton.addEventListener("click", () => this.removeHeaders());
    this.downloadButton.addEventListener("click", () => this.downloadFiles());
    this.clearButton.addEventListener("click", () => this.clear());
  }

  /*
   * =========================================================
   * FILE MANAGEMENT
   * =========================================================
   */

  async addFiles(fileList: FileList | File[]): Promise<void> {
    for (const file of Array.from(fileList)) {
      const name = file.name.toLowerCase();

      if (!name.endsWith(".smc") && !name.endsWith(".sfc")) {
        continue;
      }

      if (this.files.some((entry) => entry.file === file)) {
        continue;
      }

      const entry: FileEntry = {
        file,
        status: "checking",
        detection: null,
        buffer: null,
        cleaned: null
      };

      this.files.push(entry);
      this.update();

      try {
        entry.buffer = await file.arrayBuffer();
        entry.detection = this.detectSnesHeader(new Uint8Array(entry.buffer));

        if (entry.detection.confidence !== "high") {
          entry.status = "unknown";
        } else {
          entry.status = entry.detection.hasHeader ? "ready" : "no-header";
        }

        // Only "ready" entries can still be cleaned, so that's the only
        // case where we need to hang on to the raw bytes.
        if (entry.status !== "ready") {
          entry.buffer = null;
        }
      } catch (error) {
        console.error(error);
        entry.status = "error";
        entry.buffer = null;
      }

      this.update();
    }
  }

  clear(): void {
    this.files = [];
    this.update();
  }

  /*
   * =========================================================
   * SNES HEADER DETECTION
   * =========================================================
   */

  detectSnesHeader(data: Uint8Array): Detection {
    const results: Array<
      ValidHeader & { type: HeaderCandidate["type"]; hasHeader: boolean; headerSize: number }
    > = [];

    for (const candidate of HEADER_CANDIDATES) {
      // Test unheadered location.
      const cleanResult = this.validateSnesHeader(data, candidate.offset);

      if (cleanResult.valid) {
        results.push({
          ...cleanResult,
          type: candidate.type,
          hasHeader: false,
          headerSize: 0
        });
      }

      // Test headered location.
      const headeredOffset = candidate.offset + COPIER_HEADER_SIZE;
      const headeredResult = this.validateSnesHeader(data, headeredOffset);

      if (headeredResult.valid) {
        results.push({
          ...headeredResult,
          type: candidate.type,
          hasHeader: true,
          headerSize: COPIER_HEADER_SIZE
        });
      }
    }

    // Nothing looked like a valid SNES header.
    if (results.length === 0) {
      return {
        hasHeader: false,
        type: null,
        headerSize: 0,
        confidence: "unknown",
        reason: "No valid SNES internal header found."
      };
    }

    // Prefer the candidate with the strongest score.
    results.sort((a, b) => b.score - a.score);

    const best = results[0];

    /*
     * If two candidates tie but disagree about whether the ROM
     * has a copier header, don't automatically modify the ROM.
     */
    const equallyStrong = results.filter((result) => result.score === best.score);
    const headerStates = new Set(equallyStrong.map((result) => result.hasHeader));

    if (headerStates.size > 1) {
      return {
        hasHeader: false,
        type: null,
        headerSize: 0,
        confidence: "unknown",
        reason: "Ambiguous SNES header locations."
      };
    }

    return {
      hasHeader: best.hasHeader,
      type: best.type,
      headerSize: best.headerSize,
      // Every candidate that reaches here already passed validateSnesHeader's
      // validity check, which requires score >= 7 -- so this is always "high".
      confidence: "high",
      score: best.score,
      title: best.title,
      romSize: best.romSize,
      mapMode: best.mapMode,
      checksum: best.checksum,
      checksumComplement: best.checksumComplement,
      resetVector: best.resetVector
    };
  }

  /*
   * =========================================================
   * SNES INTERNAL HEADER VALIDATOR
   * =========================================================
   */

  validateSnesHeader(data: Uint8Array, offset: number): ValidationResult {
    // SNES header occupies 0x40 bytes.
    if (offset < 0 || offset + 0x40 > data.length) {
      return { valid: false, score: 0 };
    }

    /*
     * -------------------------------------------------------
     * Header fields
     * -------------------------------------------------------
     */
    const mapMode = data[offset + 0x15];
    const romType = data[offset + 0x16];
    const romSizeCode = data[offset + 0x17];
    const ramSizeCode = data[offset + 0x18];
    const country = data[offset + 0x19];
    const license = data[offset + 0x1a];
    const version = data[offset + 0x1b];
    const checksumComplement = this.read16(data, offset + 0x1c);
    const checksum = this.read16(data, offset + 0x1e);

    // Native-mode reset vector.
    const resetVector = this.read16(data, offset + 0x3c);

    /*
     * -------------------------------------------------------
     * Game title
     * -------------------------------------------------------
     */
    const titleBytes = data.slice(offset, offset + TITLE_LENGTH);
    const title = this.decodeTitle(titleBytes);

    /*
     * -------------------------------------------------------
     * Validation
     * -------------------------------------------------------
     */
    let score = 0;

    // 1. Map mode
    if (VALID_MAP_MODES.has(mapMode)) {
      score += 1;
    } else {
      return { valid: false, score };
    }

    /*
     * 2. ROM size code
     *
     * SNES size codes are powers of two:
     *
     * 0x08 = 256 KiB
     * 0x09 = 512 KiB
     * 0x0A = 1 MiB
     * ...
     */
    if (romSizeCode >= 0x08 && romSizeCode <= 0x0e) {
      score += 1;
    } else {
      return { valid: false, score };
    }

    const declaredRomSize = Math.pow(2, romSizeCode + 10);

    /*
     * 3. Actual ROM size
     *
     * The actual ROM can be padded, so don't require exact
     * equality. It should at least be capable of containing
     * the declared ROM.
     */
    if (data.length >= declaredRomSize) {
      score += 1;
    }

    // 4. RAM size
    if (ramSizeCode >= 0x00 && ramSizeCode <= 0x07) {
      score += 1;
    } else {
      return { valid: false, score };
    }

    // 5. Country / region
    if (country <= 0x0f) {
      score += 1;
    } else {
      return { valid: false, score };
    }

    /*
     * 6. Version
     *
     * Normal SNES versions are small values.
     */
    if (version <= 0x0f) {
      score += 1;
    }

    /*
     * 7. Checksum complement relationship
     *
     * This is one of the strongest indicators that we've
     * actually found an SNES internal header.
     *
     * checksum + complement must equal 0xFFFF.
     */
    const checksumPairValid = ((checksum + checksumComplement) & 0xffff) === 0xffff;

    if (checksumPairValid) {
      score += 2;
    } else {
      /*
       * A broken checksum pair doesn't necessarily mean the ROM
       * isn't SNES -- ROM hacks and bad dumps exist.
       *
       * But we don't want to confidently strip the file.
       */
    }

    /*
     * 8. Reset vector
     *
     * Native reset vectors normally point into the cartridge
     * address space at $8000-$FFFF.
     */
    const resetVectorValid = resetVector >= 0x8000;

    if (resetVectorValid) {
      score += 1;
    }

    /*
     * 9. Title
     *
     * A legitimate title generally consists of printable ASCII
     * characters and padding.
     */
    if (this.isPlausibleTitle(titleBytes)) {
      score += 1;
    }

    /*
     * -------------------------------------------------------
     * Minimum validity
     * -------------------------------------------------------
     *
     * Require the checksum pair plus several structural fields
     * before calling this a valid header.
     */
    if (!(checksumPairValid && resetVectorValid && score >= 7)) {
      return { valid: false, score };
    }

    return {
      valid: true,
      score,

      mapMode,
      romType,
      romSize: declaredRomSize,
      romSizeCode,
      ramSizeCode,
      country,
      license,
      version,

      checksum,
      checksumComplement,

      checksumPairValid,
      resetVector,
      resetVectorValid,

      title
    };
  }

  /*
   * =========================================================
   * TITLE VALIDATION
   * =========================================================
   */

  isPlausibleTitle(bytes: Uint8Array): boolean {
    let printable = 0;
    let nonPadding = 0;

    for (const byte of bytes) {
      // SNES titles are normally ASCII.
      if (byte === 0x00 || byte === 0x20) {
        continue;
      }

      nonPadding++;

      if (byte >= 0x21 && byte <= 0x7e) {
        printable++;
      }
    }

    // Empty titles aren't useful evidence.
    if (nonPadding === 0) {
      return false;
    }

    // At least 80% of non-padding characters should be printable ASCII.
    return printable / nonPadding >= 0.8;
  }

  decodeTitle(bytes: Uint8Array): string {
    let result = "";

    for (const byte of bytes) {
      if (byte >= 0x20 && byte <= 0x7e) {
        result += String.fromCharCode(byte);
      } else if (byte === 0x00) {
        result += " ";
      } else {
        result += "?";
      }
    }

    return result.trim();
  }

  /*
   * =========================================================
   * BINARY HELPERS
   * =========================================================
   */

  read16(data: Uint8Array, offset: number): number {
    return data[offset] | (data[offset + 1] << 8);
  }

  /*
   * =========================================================
   * REMOVE HEADERS
   * =========================================================
   */

  removeHeaders(): void {
    this.cleanButton.disabled = true;

    for (const entry of this.files) {
      // Only pending, high-confidence headered ROMs are processed.
      if (entry.status !== "ready") {
        continue;
      }

      try {
        entry.cleaned = new Blob(
          [new Uint8Array(entry.buffer!).slice(COPIER_HEADER_SIZE)],
          { type: "application/octet-stream" }
        );

        entry.status = "cleaned";
        entry.buffer = null;
      } catch (error) {
        console.error(error);
        entry.status = "error";
        entry.buffer = null;
      }
    }

    this.update();
  }

  /*
   * =========================================================
   * DOWNLOAD
   * =========================================================
   */

  downloadFiles(): void {
    const cleanedFiles = this.files.filter((entry) => entry.cleaned);

    /*
     * Safari only honors the first synthetic <a download> click when
     * several fire back-to-back in the same task -- the rest are
     * silently dropped, so only one file ever comes down. Staggering
     * them onto separate ticks gets every one treated as its own
     * download instead.
     */
    cleanedFiles.forEach((entry, index) => {
      setTimeout(() => this.downloadFile(entry), index * DOWNLOAD_STAGGER_MS);
    });
  }

  downloadFile(entry: FileEntry): void {
    const filename = entry.file.name.replace(/\.smc$/i, ".sfc");
    const url = URL.createObjectURL(entry.cleaned!);

    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /*
   * =========================================================
   * UI
   * =========================================================
   */

  /*
   * One-time shell: builds the static structure and keeps direct
   * references to the parts that change (this.fileList, this.summary,
   * the toolbar buttons, the dropzone and its file input).
   */
  render(): void {
    this.cleanButton = this.createButton("Remove headers", "clean");
    this.downloadButton = this.createButton("Download files", "download secondary");
    this.clearButton = this.createButton("Clear", "clear danger");

    const toolbar = document.createElement("div");

    toolbar.className = "toolbar";
    toolbar.append(this.cleanButton, this.downloadButton, this.clearButton);

    this.input = document.createElement("input");
    this.input.type = "file";
    this.input.multiple = true;
    this.input.accept = ".smc,.sfc";

    const title = document.createElement("strong");

    title.textContent = "Drop your SNES ROM files here";

    const hint = document.createElement("span");

    hint.textContent = "or click to choose files";

    this.dropzone = document.createElement("label");

    this.dropzone.className = "dropzone";
    this.dropzone.append(this.input, title, hint);

    this.fileList = document.createElement("div");
    this.fileList.className = "files";

    this.summary = document.createElement("div");
    this.summary.className = "summary";

    this.append(toolbar, this.dropzone, this.fileList, this.summary);
  }

  createButton(label: string, className: string): HTMLButtonElement {
    const button = document.createElement("button");

    button.className = className;
    button.textContent = label;
    button.disabled = true;

    return button;
  }

  // Re-renders the parts that depend on file state: called after
  // every add, clean, or clear.
  update(): void {
    this.fileList.innerHTML = "";

    for (const entry of this.files) {
      this.fileList.appendChild(this.renderFileRow(entry));
    }

    this.renderSummary();
    this.renderButtons();
  }

  renderFileRow(entry: FileEntry): HTMLDivElement {
    const row = document.createElement("div");

    row.className = "file";
    row.append(this.renderFileInfo(entry), this.renderFileStatus(entry));

    return row;
  }

  renderFileInfo(entry: FileEntry): HTMLDivElement {
    const info = document.createElement("div");

    info.className = "file-info";

    const filename = document.createElement("div");

    filename.className = "filename";
    filename.textContent = entry.file.name;

    const details = document.createElement("div");

    details.className = "details";

    let detailText = this.formatSize(entry.file.size);

    if (entry.detection?.type) {
      detailText += ` · ${entry.detection.type}`;
    }

    if (entry.detection?.title) {
      detailText += ` · ${entry.detection.title}`;
    }

    details.textContent = detailText;

    info.append(filename, details);

    return info;
  }

  renderFileStatus(entry: FileEntry): HTMLDivElement {
    const status = document.createElement("div");

    status.className = "status";
    status.textContent = STATUS_LABELS[entry.status];
    status.classList.add(entry.status);

    return status;
  }

  renderSummary(): void {
    const total = this.files.length;

    if (total === 0) {
      this.summary.textContent = "";
      return;
    }

    const headered = this.files.filter((entry) => entry.detection?.hasHeader).length;
    const noHeader = this.files.filter((entry) => entry.status === "no-header").length;
    const cleaned = this.files.filter((entry) => entry.cleaned).length;

    this.summary.textContent =
      `${total} file${total === 1 ? "" : "s"} · ` +
      `${headered} headered · ` +
      `${noHeader} already clean · ` +
      `${cleaned} cleaned`;
  }

  renderButtons(): void {
    const hasReadyFiles = this.files.some((entry) => entry.status === "ready");
    const hasCleanedFiles = this.files.some((entry) => entry.cleaned);
    const checking = this.files.some((entry) => entry.status === "checking");

    this.cleanButton.disabled = !hasReadyFiles || checking;
    this.downloadButton.disabled = !hasCleanedFiles;
    this.clearButton.disabled = this.files.length === 0;
  }

  /*
   * =========================================================
   * HELPERS
   * =========================================================
   */

  formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}

customElements.define("snes-header-cleaner", SnesHeaderCleaner);

declare global {
  interface HTMLElementTagNameMap {
    "snes-header-cleaner": SnesHeaderCleaner;
  }
}

export { SnesHeaderCleaner };
export type { FileEntry, FileStatus, Detection, ValidationResult, HeaderCandidate };
