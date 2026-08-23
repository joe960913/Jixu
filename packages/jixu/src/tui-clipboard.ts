import type {
  ClipboardService,
  CliRenderer,
  KeyEvent,
  PasteMetadata,
  Selection,
} from "@opentui/core";
import { decodePasteBytes } from "@opentui/core";

import {
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  MAX_INPUT_TOTAL_IMAGE_BYTES,
} from "jixu-core";
import type { ImageMediaType, ThreadInput } from "jixu-core";

interface SelectionClipboardService {
  readonly dispose: () => Promise<void>;
  readonly writeText: (
    text: string,
    options: { readonly destination: "best-available" },
  ) => Promise<unknown>;
}

export const SELECTION_COPY_FEEDBACK_DURATION_MS = 1_000;

export type SelectionCopyFeedbackState = "copied" | "idle";

export interface SelectionCopyFeedbackSource {
  readonly getSnapshot: () => SelectionCopyFeedbackState;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface SelectionCopyFeedback extends SelectionCopyFeedbackSource {
  readonly copySucceeded: () => void;
  readonly dispose: () => void;
}

export interface SelectionCopyFeedbackOptions {
  readonly durationMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  return () => clearTimeout(timeout);
}

export function createSelectionCopyFeedback(
  options: SelectionCopyFeedbackOptions = {},
): SelectionCopyFeedback {
  const durationMs =
    options.durationMs ?? SELECTION_COPY_FEEDBACK_DURATION_MS;
  const schedule = options.schedule ?? scheduleTimeout;
  const listeners = new Set<() => void>();
  let active = true;
  let cancelExpiry: (() => void) | undefined;
  let state: SelectionCopyFeedbackState = "idle";

  const publish = () => {
    for (const listener of listeners) listener();
  };
  const setState = (next: SelectionCopyFeedbackState) => {
    if (state === next) return;
    state = next;
    publish();
  };

  return {
    copySucceeded: () => {
      if (!active) return;
      cancelExpiry?.();
      setState("copied");
      cancelExpiry = schedule(() => {
        cancelExpiry = undefined;
        setState("idle");
      }, durationMs);
    },
    dispose: () => {
      active = false;
      cancelExpiry?.();
      cancelExpiry = undefined;
      state = "idle";
      listeners.clear();
    },
    getSnapshot: () => state,
    subscribe: (listener) => {
      if (!active) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface PendingPastedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly placeholder: string;
  readonly sourceByteLength: number;
}

export interface PasteFallback {
  readonly bytes: Uint8Array;
  readonly metadata?: PasteMetadata;
}

export type JixuClipboardRead =
  | {
      readonly bytes: Uint8Array;
      readonly kind: "image";
      readonly mediaType: ImageMediaType;
    }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unavailable" };

const preferredClipboardTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
] as const;

function imageMediaType(value: string | undefined): ImageMediaType | null {
  return value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/gif" ||
    value === "image/webp"
    ? value
    : null;
}

export function pastedImageToken(image: PendingPastedImage): string {
  return `[${image.placeholder}]`;
}

export function pendingPastedImageError(
  current: readonly PendingPastedImage[],
  bytes: Uint8Array,
): string | null {
  if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    return `Each pasted image must be at most ${MAX_INPUT_IMAGE_BYTES} bytes.`;
  }
  if (current.length >= MAX_INPUT_IMAGES) {
    return `One input supports at most ${MAX_INPUT_IMAGES} pasted images.`;
  }
  const total = current.reduce(
    (sum, image) => sum + image.sourceByteLength,
    0,
  );
  if (total + bytes.byteLength > MAX_INPUT_TOTAL_IMAGE_BYTES) {
    return `One input supports at most ${MAX_INPUT_TOTAL_IMAGE_BYTES} source image bytes.`;
  }
  return null;
}

export function pendingNormalizedImageError(
  current: readonly PendingPastedImage[],
  bytes: Uint8Array,
): string | null {
  const total = current.reduce((sum, image) => sum + image.bytes.byteLength, 0);
  return total + bytes.byteLength > MAX_INPUT_TOTAL_IMAGE_BYTES
    ? `One input supports at most ${MAX_INPUT_TOTAL_IMAGE_BYTES} normalized image bytes.`
    : null;
}

export async function readJixuClipboard(
  clipboard: Pick<ClipboardService, "read">,
  fallback?: PasteFallback,
): Promise<JixuClipboardRead> {
  const fallbackMediaType = imageMediaType(fallback?.metadata?.mimeType);
  if (
    fallbackMediaType !== null &&
    fallback !== undefined &&
    fallback.bytes.byteLength > 0
  ) {
    return {
      bytes: Uint8Array.from(fallback.bytes),
      kind: "image",
      mediaType: fallbackMediaType,
    };
  }

  try {
    const result = await clipboard.read({ preferredTypes: preferredClipboardTypes });
    if (result.status === "read") {
      const mediaType = imageMediaType(result.representation.mimeType);
      if (mediaType !== null) {
        return {
          bytes: Uint8Array.from(result.representation.bytes),
          kind: "image",
          mediaType,
        };
      }
      if (result.representation.mimeType === "text/plain") {
        return {
          kind: "text",
          text: decodePasteBytes(result.representation.bytes),
        };
      }
    }
  } catch {
    // Host clipboard support is optional; terminal paste bytes remain usable.
  }

  if (fallback !== undefined && fallback.bytes.byteLength > 0) {
    return { kind: "text", text: decodePasteBytes(fallback.bytes) };
  }
  return { kind: "unavailable" };
}

export function buildThreadInputFromComposer(
  value: string,
  images: readonly PendingPastedImage[],
): ThreadInput | null {
  const clean = value.trim();
  if (clean.length === 0) return null;
  if (images.length === 0) return clean;

  const remaining = new Set(images);
  const content: Exclude<ThreadInput, string>["content"][number][] = [];
  let cursor = 0;
  while (remaining.size > 0) {
    let nextImage: PendingPastedImage | undefined;
    let nextIndex = Number.POSITIVE_INFINITY;
    for (const image of remaining) {
      const index = clean.indexOf(pastedImageToken(image), cursor);
      if (index >= 0 && index < nextIndex) {
        nextImage = image;
        nextIndex = index;
      }
    }
    if (nextImage === undefined) break;
    if (nextIndex > cursor) {
      content.push({ text: clean.slice(cursor, nextIndex), type: "text" });
    }
    content.push({
      data: Uint8Array.from(nextImage.bytes),
      mediaType: nextImage.mediaType,
      placeholder: nextImage.placeholder,
      type: "image",
    });
    cursor = nextIndex + pastedImageToken(nextImage).length;
    remaining.delete(nextImage);
  }
  if (content.every((part) => part.type === "text")) return clean;
  if (cursor < clean.length) {
    content.push({ text: clean.slice(cursor), type: "text" });
  }
  return { content };
}

export interface JixuSelectionClipboardBinding {
  readonly dispose: () => Promise<void>;
  readonly settled: () => Promise<void>;
}

export interface JixuSelectionClipboardOptions {
  readonly feedback?: Pick<SelectionCopyFeedback, "copySucceeded">;
}

const writeOptions = Object.freeze({
  destination: "best-available" as const,
});

export function installJixuSelectionClipboard(
  renderer: CliRenderer,
  clipboard: SelectionClipboardService,
  options: JixuSelectionClipboardOptions = {},
): JixuSelectionClipboardBinding {
  let accepting = true;
  let writes = Promise.resolve();
  let disposePromise: Promise<void> | undefined;

  const enqueue = (text: string) => {
    if (!accepting || text.length === 0) return;
    writes = writes.then(async () => {
      try {
        await clipboard.writeText(text, writeOptions);
        options.feedback?.copySucceeded();
      } catch {
        // Clipboard failures are presentation-local and must not stop later copies.
      }
    });
  };

  const copySelection = (selection: Selection) => {
    enqueue(selection.getSelectedText());
  };

  const copyWithShortcut = (key: KeyEvent) => {
    if (key.name !== "c" || key.super !== true || key.repeated === true) return;

    key.preventDefault();
    key.stopPropagation();
    const editorText = renderer.currentFocusedEditor?.getSelectedText() ?? "";
    const rendererText = renderer.getSelection()?.getSelectedText() ?? "";
    enqueue(editorText.length > 0 ? editorText : rendererText);
  };

  renderer.on("selection", copySelection);
  renderer.keyInput.on("keypress", copyWithShortcut);

  return {
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;

      accepting = false;
      renderer.off("selection", copySelection);
      renderer.keyInput.off("keypress", copyWithShortcut);
      disposePromise = writes.then(async () => {
        try {
          await clipboard.dispose();
        } catch {
          // Teardown must remain reliable even if a clipboard backend fails.
        }
      });
      return disposePromise;
    },
    settled: () => writes,
  };
}
