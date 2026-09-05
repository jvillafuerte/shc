import { afterEach, describe, expect, it, vi } from "vitest";
// Side-effect import: registers the element. Needed as its own import
// because SnesHeaderCleaner is only ever used below in type position, so
// a transpile-time-only (no type info) transform can mistake the named
// import for type-only and elide it -- silently dropping the
// customElements.define() call along with it.
import "./shc";
import { SnesHeaderCleaner } from "./shc";
import type { FileEntry } from "./shc";

/*
 * =========================================================
 * FIXTURE HELPERS
 *
 * writeHeader() writes a 0x40-byte SNES header at a given offset
 * inside a buffer, defaulting every field to something that makes
 * validateSnesHeader() consider it valid (score 9, well past the
 * required 7) so each test only has to override the field it cares
 * about.
 * =========================================================
 */

interface HeaderFields {
  mapMode: number;
  romType: number;
  romSizeCode: number;
  ramSizeCode: number;
  country: number;
  license: number;
  version: number;
  checksum: number;
  checksumComplement: number;
  resetVector: number;
  title: string;
}

const VALID_HEADER: HeaderFields = {
  mapMode: 0x20, // LoROM
  romType: 0x00,
  romSizeCode: 0x09, // 512 KiB declared -- comfortably bigger than our tiny test buffers
  ramSizeCode: 0x00,
  country: 0x01,
  license: 0x00,
  version: 0x00,
  checksum: 0x1234,
  checksumComplement: 0xedcb, // 0x1234 + 0xedcb === 0xffff
  resetVector: 0x8000,
  title: "TEST GAME"
};

function writeHeader(data: Uint8Array, offset: number, overrides: Partial<HeaderFields> = {}): void {
  const fields = { ...VALID_HEADER, ...overrides };
  const title = fields.title.padEnd(21, " ").slice(0, 21);

  for (let i = 0; i < 21; i++) {
    data[offset + i] = title.charCodeAt(i);
  }

  data[offset + 0x15] = fields.mapMode;
  data[offset + 0x16] = fields.romType;
  data[offset + 0x17] = fields.romSizeCode;
  data[offset + 0x18] = fields.ramSizeCode;
  data[offset + 0x19] = fields.country;
  data[offset + 0x1a] = fields.license;
  data[offset + 0x1b] = fields.version;
  data[offset + 0x1c] = fields.checksumComplement & 0xff;
  data[offset + 0x1d] = (fields.checksumComplement >> 8) & 0xff;
  data[offset + 0x1e] = fields.checksum & 0xff;
  data[offset + 0x1f] = (fields.checksum >> 8) & 0xff;
  data[offset + 0x3c] = fields.resetVector & 0xff;
  data[offset + 0x3d] = (fields.resetVector >> 8) & 0xff;
}

// A LoROM offset (0x7fc0) with just enough room for a header at it.
const LOROM_UNHEADERED = 0x7fc0;
const LOROM_HEADERED = LOROM_UNHEADERED + 0x200;

function makeRom(size: number, headers: Array<[number, Partial<HeaderFields>?]> = []): Uint8Array {
  const data = new Uint8Array(size);

  for (const [offset, overrides] of headers) {
    writeHeader(data, offset, overrides);
  }

  return data;
}

function makeFile(name: string, data: Uint8Array): File {
  // Uint8Array's ArrayBufferLike-vs-ArrayBuffer generic doesn't match
  // BlobPart exactly, though the runtime shapes are identical here --
  // this file never touches a SharedArrayBuffer.
  return new File([data as BlobPart], name);
}

function mount(): SnesHeaderCleaner {
  const el = document.createElement("snes-header-cleaner");

  document.body.appendChild(el);

  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/*
 * =========================================================
 * BINARY / TITLE HELPERS
 * =========================================================
 */

describe("read16", () => {
  it("combines two bytes little-endian", () => {
    const el = mount();

    expect(el.read16(new Uint8Array([0x34, 0x12]), 0)).toBe(0x1234);
  });
});

describe("decodeTitle", () => {
  it("decodes printable ASCII, nulls as spaces, and everything else as '?', then trims", () => {
    const el = mount();

    // 0x00 -> space (leading one trimmed away), 0x41 -> "A", 0x00 -> space
    // (kept, it's in the middle), 0x01 -> "?", 0x00 -> space (trimmed away)
    const bytes = new Uint8Array([0x00, 0x41, 0x00, 0x01, 0x00]);

    expect(el.decodeTitle(bytes)).toBe("A ?");
  });
});

describe("isPlausibleTitle", () => {
  it("is false when every byte is padding", () => {
    const el = mount();

    expect(el.isPlausibleTitle(new Uint8Array([0x00, 0x20, 0x00, 0x20]))).toBe(false);
  });

  it("is true right at the 80% printable threshold", () => {
    const el = mount();

    // 8 printable, 2 non-printable, 10 non-padding bytes -> exactly 0.8
    const bytes = new Uint8Array([
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x01, 0x01
    ]);

    expect(el.isPlausibleTitle(bytes)).toBe(true);
  });

  it("is false just below the 80% printable threshold", () => {
    const el = mount();

    // 7 printable, 3 non-printable, 10 non-padding bytes -> 0.7
    const bytes = new Uint8Array([
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x01, 0x01, 0x01
    ]);

    expect(el.isPlausibleTitle(bytes)).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    const el = mount();

    expect(el.formatSize(500)).toBe("500 B");
  });

  it("formats kilobytes, right at the 1024-byte boundary", () => {
    const el = mount();

    expect(el.formatSize(1024)).toBe("1.0 KB");
  });

  it("formats megabytes, right at the 1 MiB boundary", () => {
    const el = mount();

    expect(el.formatSize(1024 * 1024)).toBe("1.00 MB");
  });
});

/*
 * =========================================================
 * SNES INTERNAL HEADER VALIDATOR
 * =========================================================
 */

describe("validateSnesHeader", () => {
  it("rejects an offset that doesn't leave room for a full header", () => {
    const el = mount();

    expect(el.validateSnesHeader(new Uint8Array(10), 0)).toEqual({ valid: false, score: 0 });
  });

  it("rejects an invalid map mode", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { mapMode: 0x00 }]]);

    expect(el.validateSnesHeader(data, 0)).toEqual({ valid: false, score: 0 });
  });

  it("rejects an invalid ROM size code", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { romSizeCode: 0xff }]]);

    expect(el.validateSnesHeader(data, 0)).toEqual({ valid: false, score: 1 });
  });

  it("rejects an invalid RAM size code", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { ramSizeCode: 0xff }]]);

    expect(el.validateSnesHeader(data, 0)).toEqual({ valid: false, score: 2 });
  });

  it("rejects an invalid country code", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { country: 0xff }]]);

    expect(el.validateSnesHeader(data, 0)).toEqual({ valid: false, score: 3 });
  });

  it("is invalid when the checksum pair doesn't add up, even with an otherwise-sufficient score", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { checksumComplement: 0x0000 }]]);

    const result = el.validateSnesHeader(data, 0);

    // mandatory 4 + version 1 + resetVector 1 + title 1 = 7, but checksumPairValid
    // is a hard requirement independent of the score total.
    expect(result).toEqual({ valid: false, score: 7 });
  });

  it("is invalid when the reset vector doesn't point into cartridge space", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { resetVector: 0x0000 }]]);

    const result = el.validateSnesHeader(data, 0);

    expect(result).toEqual({ valid: false, score: 8 });
  });

  it("is valid without the optional version bonus", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { version: 0xff }]]);

    const result = el.validateSnesHeader(data, 0);

    expect(result.valid).toBe(true);
    expect(result.score).toBe(8);
  });

  it("is valid without the optional plausible-title bonus", () => {
    const el = mount();
    const data = makeRom(0x100, [[0, { title: "" }]]);

    const result = el.validateSnesHeader(data, 0);

    expect(result.valid).toBe(true);
    expect(result.score).toBe(8);
    expect(result.valid && result.title).toBe("");
  });

  it("awards the actual-ROM-size bonus when the file is at least as big as declared", () => {
    const el = mount();
    // romSizeCode 0x08 -> declared 256 KiB.
    const small = makeRom(0x100, [[0, { romSizeCode: 0x08 }]]);
    const big = makeRom(256 * 1024, [[0, { romSizeCode: 0x08 }]]);

    expect(el.validateSnesHeader(small, 0).score).toBe(9);
    expect(el.validateSnesHeader(big, 0).score).toBe(10);
  });

  it("returns every field for a fully valid header", () => {
    const el = mount();
    const data = makeRom(0x100, [[0]]);

    const result = el.validateSnesHeader(data, 0);

    expect(result.valid).toBe(true);
    if (!result.valid) {
      throw new Error("expected a valid result");
    }

    expect(result).toMatchObject({
      mapMode: 0x20,
      romSize: 512 * 1024,
      title: "TEST GAME",
      checksumPairValid: true,
      resetVectorValid: true
    });
  });
});

/*
 * =========================================================
 * SNES HEADER DETECTION
 * =========================================================
 */

describe("detectSnesHeader", () => {
  it("reports no header when nothing validates", () => {
    const el = mount();
    const data = new Uint8Array(0x100);

    expect(el.detectSnesHeader(data)).toEqual({
      hasHeader: false,
      type: null,
      headerSize: 0,
      confidence: "unknown",
      reason: "No valid SNES internal header found."
    });
  });

  it("detects an unheadered ROM", () => {
    const el = mount();
    const data = makeRom(LOROM_UNHEADERED + 0x40, [[LOROM_UNHEADERED]]);

    const detection = el.detectSnesHeader(data);

    expect(detection).toMatchObject({
      hasHeader: false,
      type: "LoROM",
      headerSize: 0,
      confidence: "high"
    });
  });

  it("detects a headered ROM", () => {
    const el = mount();
    const data = makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]);

    const detection = el.detectSnesHeader(data);

    expect(detection).toMatchObject({
      hasHeader: true,
      type: "LoROM",
      headerSize: 0x200,
      confidence: "high"
    });
  });

  it("refuses to guess when unheadered and headered locations tie", () => {
    const el = mount();
    const data = makeRom(LOROM_HEADERED + 0x40, [[LOROM_UNHEADERED], [LOROM_HEADERED]]);

    expect(el.detectSnesHeader(data)).toEqual({
      hasHeader: false,
      type: null,
      headerSize: 0,
      confidence: "unknown",
      reason: "Ambiguous SNES header locations."
    });
  });
});

/*
 * =========================================================
 * CUSTOM ELEMENT SHELL / LIFECYCLE
 * =========================================================
 */

describe("connectedCallback / render", () => {
  it("builds the toolbar, dropzone, file list, and summary", () => {
    const el = mount();

    const buttons = el.querySelectorAll(".toolbar button");

    expect(buttons).toHaveLength(3);
    expect(Array.from(buttons).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    expect(el.querySelector('input[type="file"]')).not.toBeNull();
    expect(el.querySelector(".dropzone strong")?.textContent).toBe("Drop your SNES ROM files here");
    expect(el.querySelector(".dropzone span")?.textContent).toBe("or click to choose files");
    expect(el.querySelector(".files")).not.toBeNull();
    expect(el.querySelector(".summary")?.textContent).toBe("");
  });

  it("only builds the shell once, even if reconnected", () => {
    const el = mount();
    const originalCleanButton = el.cleanButton;

    el.remove();
    document.body.appendChild(el);

    expect(el.cleanButton).toBe(originalCleanButton);
  });
});

describe("setupEvents wiring", () => {
  it("change: adds the selected files and clears the input", () => {
    const el = mount();
    const file = makeFile("game.smc", new Uint8Array(4));
    const addFiles = vi.spyOn(el, "addFiles").mockResolvedValue(undefined);

    Object.defineProperty(el.input, "files", { value: [file], configurable: true });
    el.input.dispatchEvent(new Event("change"));

    expect(addFiles).toHaveBeenCalledWith([file]);
    expect(el.input.value).toBe("");
  });

  it("dragover: prevents the default and adds the dragover class", () => {
    const el = mount();
    const event = new Event("dragover", { cancelable: true });
    const preventDefault = vi.spyOn(event, "preventDefault");

    el.dropzone.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(el.dropzone.classList.contains("dragover")).toBe(true);
  });

  it("dragleave: removes the dragover class", () => {
    const el = mount();

    el.dropzone.classList.add("dragover");
    el.dropzone.dispatchEvent(new Event("dragleave"));

    expect(el.dropzone.classList.contains("dragover")).toBe(false);
  });

  it("drop: prevents the default, clears dragover, and adds the dropped files", () => {
    const el = mount();
    const file = makeFile("game.smc", new Uint8Array(4));
    const addFiles = vi.spyOn(el, "addFiles").mockResolvedValue(undefined);
    const event = new Event("drop", { cancelable: true });

    Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
    const preventDefault = vi.spyOn(event, "preventDefault");

    el.dropzone.classList.add("dragover");
    el.dropzone.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(el.dropzone.classList.contains("dragover")).toBe(false);
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it("clicking the buttons calls removeHeaders, downloadFiles, and clear", () => {
    const el = mount();

    const removeHeaders = vi.spyOn(el, "removeHeaders").mockImplementation(() => {});
    const downloadFiles = vi.spyOn(el, "downloadFiles").mockImplementation(() => {});
    const clear = vi.spyOn(el, "clear").mockImplementation(() => {});

    // Disabled buttons don't dispatch clicks -- enable them to test the wiring itself.
    el.cleanButton.disabled = false;
    el.downloadButton.disabled = false;
    el.clearButton.disabled = false;

    el.cleanButton.click();
    el.downloadButton.click();
    el.clearButton.click();

    expect(removeHeaders).toHaveBeenCalled();
    expect(downloadFiles).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });
});

/*
 * =========================================================
 * FILE MANAGEMENT
 * =========================================================
 */

describe("addFiles", () => {
  it("ignores files that aren't .smc or .sfc", async () => {
    const el = mount();

    await el.addFiles([makeFile("readme.txt", new Uint8Array(4))]);

    expect(el.files).toHaveLength(0);
  });

  it("ignores a file already added", async () => {
    const el = mount();
    const file = makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]));

    await el.addFiles([file]);
    await el.addFiles([file]);

    expect(el.files).toHaveLength(1);
  });

  it("marks a headered ROM as ready and keeps its buffer", async () => {
    const el = mount();
    const file = makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]));

    await el.addFiles([file]);

    expect(el.files[0]?.status).toBe("ready");
    expect(el.files[0]?.buffer).not.toBeNull();
    expect(el.files[0]?.detection?.hasHeader).toBe(true);
  });

  it("marks an unheadered ROM as no-header and drops its buffer", async () => {
    const el = mount();
    const file = makeFile("game.sfc", makeRom(LOROM_UNHEADERED + 0x40, [[LOROM_UNHEADERED]]));

    await el.addFiles([file]);

    expect(el.files[0]?.status).toBe("no-header");
    expect(el.files[0]?.buffer).toBeNull();
  });

  it("marks an unrecognized file as unknown and drops its buffer", async () => {
    const el = mount();
    const file = makeFile("mystery.smc", new Uint8Array(0x100));

    await el.addFiles([file]);

    expect(el.files[0]?.status).toBe("unknown");
    expect(el.files[0]?.buffer).toBeNull();
  });

  it("marks a file as errored if reading it throws", async () => {
    const el = mount();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = makeFile("game.smc", new Uint8Array(4));

    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("read failed"));

    await el.addFiles([file]);

    expect(el.files[0]?.status).toBe("error");
    expect(el.files[0]?.buffer).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it("disables the clean button while a file is still checking", async () => {
    const el = mount();
    const file = makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]));

    const pending = el.addFiles([file]);

    expect(el.files[0]?.status).toBe("checking");
    expect(el.cleanButton.disabled).toBe(true);

    await pending;
  });
});

describe("clear", () => {
  it("empties the file list and re-renders", async () => {
    const el = mount();

    await el.addFiles([makeFile("game.smc", new Uint8Array(0x100))]);
    expect(el.files).toHaveLength(1);

    el.clear();

    expect(el.files).toHaveLength(0);
    expect(el.fileList.children).toHaveLength(0);
    expect(el.summary.textContent).toBe("");
  });
});

/*
 * =========================================================
 * REMOVE HEADERS
 * =========================================================
 */

describe("removeHeaders", () => {
  it("strips exactly the copier header from ready entries and leaves others alone", async () => {
    const el = mount();

    const readyFile = makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]));
    const cleanFile = makeFile("clean.sfc", makeRom(LOROM_UNHEADERED + 0x40, [[LOROM_UNHEADERED]]));

    await el.addFiles([readyFile, cleanFile]);

    const originalBytes = new Uint8Array(el.files[0]!.buffer!);

    el.removeHeaders();

    const ready = el.files[0]!;
    const untouched = el.files[1]!;

    expect(ready.status).toBe("cleaned");
    expect(ready.buffer).toBeNull();
    expect(untouched.status).toBe("no-header");

    const cleanedBytes = new Uint8Array(await ready.cleaned!.arrayBuffer());

    expect(cleanedBytes).toEqual(originalBytes.slice(0x200));
  });

  it("marks an entry as errored if its buffer is missing", () => {
    const el = mount();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const entry: FileEntry = {
      file: makeFile("broken.smc", new Uint8Array(4)),
      status: "ready",
      detection: null,
      buffer: null,
      cleaned: null
    };

    // `new Uint8Array(null)` doesn't actually throw, so force the failure
    // explicitly to exercise the defensive catch block. A no-op setter
    // keeps removeHeaders' own `entry.buffer = null` (in that same catch
    // block) from throwing a second time.
    Object.defineProperty(entry, "buffer", {
      get(): ArrayBuffer {
        throw new Error("buffer missing");
      },
      set() {}
    });

    el.files.push(entry);
    el.removeHeaders();

    expect(entry.status).toBe("error");
    expect(consoleError).toHaveBeenCalled();
  });
});

/*
 * =========================================================
 * DOWNLOAD
 * =========================================================
 */

describe("downloadFiles", () => {
  it("does nothing when there are no cleaned files", () => {
    const el = mount();
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    el.downloadFiles();

    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads a cleaned file renamed to .sfc, then revokes the object URL", () => {
    const el = mount();

    vi.useFakeTimers();

    const objectUrl = "blob:http://localhost/mock-id";
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const appendChild = vi.spyOn(document.body, "appendChild");
    // jsdom doesn't implement navigation and logs a noisy warning for it;
    // downloadFiles doesn't rely on the click actually navigating anywhere.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const entry: FileEntry = {
      file: makeFile("game.smc", new Uint8Array(4)),
      status: "cleaned",
      detection: null,
      buffer: null,
      cleaned: new Blob(["cleaned"], { type: "application/octet-stream" })
    };

    el.files.push(entry);
    el.downloadFiles();

    // Even a single file's download is scheduled (via a 0ms timer), not fired inline.
    expect(createObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);

    expect(createObjectURL).toHaveBeenCalledWith(entry.cleaned);

    const link = appendChild.mock.calls[0]?.[0] as HTMLAnchorElement;

    expect(link.download).toBe("game.sfc");
    expect(link.href).toBe(objectUrl);
    expect(document.body.contains(link)).toBe(false);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("leaves a .sfc filename as-is", () => {
    const el = mount();

    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock-id");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const appendChild = vi.spyOn(document.body, "appendChild");
    // jsdom doesn't implement navigation and logs a noisy warning for it;
    // downloadFiles doesn't rely on the click actually navigating anywhere.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const entry: FileEntry = {
      file: makeFile("already-clean.sfc", new Uint8Array(4)),
      status: "cleaned",
      detection: null,
      buffer: null,
      cleaned: new Blob(["cleaned"])
    };

    el.files.push(entry);
    el.downloadFiles();
    vi.runAllTimers();

    const link = appendChild.mock.calls[0]?.[0] as HTMLAnchorElement;

    expect(link.download).toBe("already-clean.sfc");
  });

  it("staggers multiple downloads instead of firing them in the same task", () => {
    // Safari drops every synthetic <a download> click after the first when
    // several fire back-to-back in one task, so each file's click must land
    // on its own timer tick.
    const el = mount();

    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/mock-id");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const appendChild = vi.spyOn(document.body, "appendChild");

    const makeCleanedEntry = (name: string): FileEntry => ({
      file: makeFile(name, new Uint8Array(4)),
      status: "cleaned",
      detection: null,
      buffer: null,
      cleaned: new Blob(["cleaned"])
    });

    el.files.push(makeCleanedEntry("first.smc"), makeCleanedEntry("second.smc"));
    el.downloadFiles();

    // Nothing fires synchronously.
    expect(appendChild).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect((appendChild.mock.calls[0]?.[0] as HTMLAnchorElement).download).toBe("first.sfc");

    // The second file's download only fires once the stagger delay has passed.
    vi.advanceTimersByTime(299);
    expect(appendChild).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(appendChild).toHaveBeenCalledTimes(2);
    expect((appendChild.mock.calls[1]?.[0] as HTMLAnchorElement).download).toBe("second.sfc");
  });
});

/*
 * =========================================================
 * UI
 * =========================================================
 */

describe("renderFileStatus", () => {
  const cases: Array<[FileEntry["status"], string]> = [
    ["checking", "Checking…"],
    ["ready", "✓ 512-byte header"],
    ["no-header", "— No header"],
    ["unknown", "⚠ Unknown"],
    ["cleaned", "✓ Header removed"],
    ["error", "✕ Error"]
  ];

  it.each(cases)("renders the %s status with its label and class", (status, label) => {
    const el = mount();
    const entry: FileEntry = {
      file: makeFile("game.smc", new Uint8Array(4)),
      status,
      detection: null,
      buffer: null,
      cleaned: null
    };

    const node = el.renderFileStatus(entry);

    expect(node.textContent).toBe(label);
    expect(node.classList.contains(status)).toBe(true);
  });
});

describe("renderFileInfo", () => {
  it("shows only the size while a file is still checking", () => {
    const el = mount();
    const entry: FileEntry = {
      file: makeFile("game.smc", new Uint8Array(500)),
      status: "checking",
      detection: null,
      buffer: null,
      cleaned: null
    };

    const info = el.renderFileInfo(entry);

    expect(info.querySelector(".details")?.textContent).toBe("500 B");
  });

  it("appends the detected type and title once resolved", () => {
    const el = mount();
    const entry: FileEntry = {
      file: makeFile("game.smc", new Uint8Array(500)),
      status: "ready",
      detection: {
        hasHeader: true,
        type: "LoROM",
        headerSize: 0x200,
        confidence: "high",
        score: 9,
        title: "TEST GAME",
        romSize: 512 * 1024,
        mapMode: 0x20,
        checksum: 0x1234,
        checksumComplement: 0xedcb,
        resetVector: 0x8000
      },
      buffer: null,
      cleaned: null
    };

    const info = el.renderFileInfo(entry);

    expect(info.querySelector(".details")?.textContent).toBe("500 B · LoROM · TEST GAME");
  });

  it("skips an empty (but still present) title", () => {
    const el = mount();
    const entry: FileEntry = {
      file: makeFile("game.smc", new Uint8Array(500)),
      status: "ready",
      detection: {
        hasHeader: true,
        type: "LoROM",
        headerSize: 0x200,
        confidence: "high",
        score: 8,
        title: "",
        romSize: 512 * 1024,
        mapMode: 0x20,
        checksum: 0x1234,
        checksumComplement: 0xedcb,
        resetVector: 0x8000
      },
      buffer: null,
      cleaned: null
    };

    const info = el.renderFileInfo(entry);

    expect(info.querySelector(".details")?.textContent).toBe("500 B · LoROM");
  });
});

describe("renderSummary", () => {
  it("is blank with no files", () => {
    const el = mount();

    el.renderSummary();

    expect(el.summary.textContent).toBe("");
  });

  it("uses the singular form for exactly one file", async () => {
    const el = mount();

    await el.addFiles([makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]))]);

    expect(el.summary.textContent).toBe("1 file · 1 headered · 0 already clean · 0 cleaned");
  });

  it("uses the plural form and counts each category for multiple files", async () => {
    const el = mount();

    await el.addFiles([
      makeFile("headered.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]])),
      makeFile("clean.sfc", makeRom(LOROM_UNHEADERED + 0x40, [[LOROM_UNHEADERED]]))
    ]);

    el.removeHeaders();

    expect(el.summary.textContent).toBe("2 files · 1 headered · 1 already clean · 1 cleaned");
  });
});

describe("renderButtons", () => {
  it("disables everything with no files", () => {
    const el = mount();

    el.renderButtons();

    expect(el.cleanButton.disabled).toBe(true);
    expect(el.downloadButton.disabled).toBe(true);
    expect(el.clearButton.disabled).toBe(true);
  });

  it("enables clear and clean once a ready file is present", async () => {
    const el = mount();

    await el.addFiles([makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]))]);

    expect(el.cleanButton.disabled).toBe(false);
    expect(el.clearButton.disabled).toBe(false);
    expect(el.downloadButton.disabled).toBe(true);
  });

  it("enables download once a file has been cleaned", async () => {
    const el = mount();

    await el.addFiles([makeFile("game.smc", makeRom(LOROM_HEADERED + 0x40, [[LOROM_HEADERED]]))]);
    el.removeHeaders();

    expect(el.downloadButton.disabled).toBe(false);
    expect(el.cleanButton.disabled).toBe(true);
  });
});
