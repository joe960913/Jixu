import { NativeImage, type ImageFormat } from "@opentui/core";
import { encode } from "fast-png";

import {
  MAX_INPUT_IMAGE_BYTES,
  type ImageMediaType,
} from "jixu-core";

export const PASTED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const PASTED_IMAGE_MAX_EDGE = 4_096;
export const PASTED_IMAGE_MAX_PIXELS = 4 * 1024 * 1024;

const expectedFormat: Readonly<Record<ImageMediaType, ImageFormat>> = {
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export class PastedImageNormalizationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PastedImageNormalizationError";
  }
}

export interface NormalizedPastedImage {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly mediaType: "image/png";
  readonly sourceByteLength: number;
  readonly width: number;
}

function boundedDimensions(
  width: number,
  height: number,
): { readonly height: number; readonly width: number } {
  const scale = Math.min(
    1,
    PASTED_IMAGE_MAX_EDGE / width,
    PASTED_IMAGE_MAX_EDGE / height,
    Math.sqrt(PASTED_IMAGE_MAX_PIXELS / (width * height)),
  );
  if (scale === 1) return { height, width };
  return {
    height: Math.max(1, Math.floor(height * scale)),
    width: Math.max(1, Math.floor(width * scale)),
  };
}

function encodedPng(image: NativeImage): Uint8Array {
  const raw = image.raw("rgba8");
  return encode(
    {
      channels: 4,
      data: raw.data,
      depth: 8,
      height: raw.height,
      width: raw.width,
    },
    { zlib: { level: 9 } },
  );
}

function hasAnimationControl(source: Uint8Array): boolean {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 8;
  while (offset + 12 <= source.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > source.byteLength || end < offset) return false;
    const type = String.fromCharCode(
      source[offset + 4] ?? 0,
      source[offset + 5] ?? 0,
      source[offset + 6] ?? 0,
      source[offset + 7] ?? 0,
    );
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset = end;
  }
  return false;
}

function smallerDimensions(
  width: number,
  height: number,
  byteLength: number,
): { readonly height: number; readonly width: number } {
  const scale = Math.min(
    0.9,
    Math.sqrt(PASTED_IMAGE_MAX_BYTES / byteLength) * 0.95,
  );
  let nextWidth = Math.max(1, Math.floor(width * scale));
  let nextHeight = Math.max(1, Math.floor(height * scale));
  if (nextWidth === width && width > 1) nextWidth -= 1;
  if (nextHeight === height && height > 1) nextHeight -= 1;
  return { height: nextHeight, width: nextWidth };
}

export function normalizePastedImage(
  source: Uint8Array,
  mediaType: ImageMediaType,
): NormalizedPastedImage {
  if (source.byteLength < 1 || source.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new PastedImageNormalizationError(
      `Each pasted image must contain between 1 and ${MAX_INPUT_IMAGE_BYTES} bytes.`,
    );
  }

  const sourceByteLength = source.byteLength;
  let image: NativeImage;
  try {
    image = NativeImage.decode(source);
  } catch {
    throw new PastedImageNormalizationError(
      `The pasted image could not be decoded as ${mediaType}.`,
    );
  }

  try {
    const info = image.info();
    if (info.format !== expectedFormat[mediaType]) {
      throw new PastedImageNormalizationError(
        `The pasted image bytes do not match ${mediaType}.`,
      );
    }

    const bounded = boundedDimensions(image.width, image.height);
    const sourceAlreadyConforms =
      mediaType === "image/png" &&
      !hasAnimationControl(source) &&
      bounded.width === image.width &&
      bounded.height === image.height &&
      sourceByteLength <= PASTED_IMAGE_MAX_BYTES;
    if (sourceAlreadyConforms) {
      return {
        bytes: Uint8Array.from(source),
        height: image.height,
        mediaType: "image/png",
        sourceByteLength,
        width: image.width,
      };
    }

    if (bounded.width !== image.width || bounded.height !== image.height) {
      const resized = image.resize({ ...bounded, kernel: "area" });
      image.dispose();
      image = resized;
    }

    let bytes = encodedPng(image);
    while (
      bytes.byteLength > PASTED_IMAGE_MAX_BYTES &&
      (image.width > 1 || image.height > 1)
    ) {
      const next = smallerDimensions(image.width, image.height, bytes.byteLength);
      const resized = image.resize({ ...next, kernel: "area" });
      image.dispose();
      image = resized;
      bytes = encodedPng(image);
    }
    if (bytes.byteLength > PASTED_IMAGE_MAX_BYTES) {
      throw new PastedImageNormalizationError(
        "The pasted image could not be reduced to the Composer image limit.",
      );
    }

    return {
      bytes,
      height: image.height,
      mediaType: "image/png",
      sourceByteLength,
      width: image.width,
    };
  } catch (error) {
    if (error instanceof PastedImageNormalizationError) throw error;
    throw new PastedImageNormalizationError(
      "The pasted image could not be normalized to PNG.",
    );
  } finally {
    image.dispose();
  }
}
