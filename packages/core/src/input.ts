import { ArtifactError, InvalidTransitionError } from "./errors.ts";

export const MAX_INPUT_IMAGES = 10;
export const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_INPUT_IMAGE_PLACEHOLDER_LENGTH = 64;

export type ImageMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface ArtifactReference {
  readonly byteLength: number;
  readonly digest: string;
  readonly mediaType: ImageMediaType;
}

export interface TextThreadInputPart {
  readonly text: string;
  readonly type: "text";
}

export interface ImageThreadInputPart {
  readonly data: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly placeholder?: string;
  readonly type: "image";
}

export type ThreadInputPart = ImageThreadInputPart | TextThreadInputPart;

export interface StructuredThreadInput {
  readonly content: readonly ThreadInputPart[];
}

export type ThreadInput = string | StructuredThreadInput;

export interface StoredTextInputPart {
  readonly text: string;
  readonly type: "text";
}

export interface StoredImageInputPart {
  readonly artifact: ArtifactReference;
  readonly placeholder: string;
  readonly type: "image";
}

export type StoredInputPart = StoredImageInputPart | StoredTextInputPart;

export interface AcceptedInput {
  readonly content: string;
  readonly parts?: readonly StoredInputPart[];
}

export interface PreparedArtifact {
  readonly bytes: Uint8Array;
  readonly reference: ArtifactReference;
}

export interface PreparedThreadInput {
  readonly artifacts: readonly PreparedArtifact[];
  readonly payload: AcceptedInput;
}

const placeholderPattern = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function artifactDigest(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return [...expected].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function hasImageSignature(bytes: Uint8Array, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case "image/png":
      return hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
    case "image/jpeg":
      return hasPrefix(bytes, [255, 216, 255]);
    case "image/gif":
      return hasAscii(bytes, 0, "GIF87a") || hasAscii(bytes, 0, "GIF89a");
    case "image/webp":
      return hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP");
  }
}

function assertImageMediaType(value: string): asserts value is ImageMediaType {
  if (
    value !== "image/png" &&
    value !== "image/jpeg" &&
    value !== "image/gif" &&
    value !== "image/webp"
  ) {
    throw new ArtifactError(
      "artifact_media_type_unsupported",
      `Image media type ${value} is not supported`,
    );
  }
}

function validatePlaceholder(value: string): string {
  const placeholder = value.trim();
  if (
    placeholder.length === 0 ||
    placeholder.length > MAX_INPUT_IMAGE_PLACEHOLDER_LENGTH ||
    !placeholderPattern.test(placeholder)
  ) {
    throw new ArtifactError(
      "artifact_placeholder_invalid",
      `Image placeholder must contain 1-${MAX_INPUT_IMAGE_PLACEHOLDER_LENGTH} letters, numbers, spaces, underscores, or hyphens`,
    );
  }
  return placeholder;
}

export async function assertArtifactBytes(
  reference: ArtifactReference,
  bytes: Uint8Array,
): Promise<void> {
  assertArtifactReference(reference);
  if (bytes.byteLength !== reference.byteLength) {
    throw new ArtifactError(
      "artifact_corrupt",
      `Image Artifact ${reference.digest} byte length does not match its reference`,
    );
  }
  if (!hasImageSignature(bytes, reference.mediaType)) {
    throw new ArtifactError(
      "artifact_media_mismatch",
      `Image Artifact ${reference.digest} does not match ${reference.mediaType}`,
    );
  }
  const digest = await artifactDigest(bytes);
  if (digest !== reference.digest) {
    throw new ArtifactError(
      "artifact_corrupt",
      `Image Artifact ${reference.digest} failed digest verification`,
    );
  }
}

export function assertArtifactReference(
  reference: ArtifactReference,
): void {
  assertImageMediaType(reference.mediaType);
  if (!/^sha256:[a-f0-9]{64}$/u.test(reference.digest)) {
    throw new ArtifactError(
      "artifact_digest_invalid",
      "Image Artifact digest must be a lowercase SHA-256 digest",
    );
  }
  if (
    !Number.isInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > MAX_INPUT_IMAGE_BYTES
  ) {
    throw new ArtifactError(
      "artifact_size_invalid",
      `Image Artifact byte length must be between 1 and ${MAX_INPUT_IMAGE_BYTES}`,
    );
  }
}

async function prepareImage(
  part: ImageThreadInputPart,
  imageNumber: number,
): Promise<{
  readonly artifact: PreparedArtifact;
  readonly part: StoredImageInputPart;
}> {
  assertImageMediaType(part.mediaType);
  if (!(part.data instanceof Uint8Array)) {
    throw new ArtifactError(
      "artifact_data_invalid",
      "Image input data must be a Uint8Array",
    );
  }
  if (part.data.byteLength < 1 || part.data.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new ArtifactError(
      "artifact_size_invalid",
      `Each image must contain between 1 and ${MAX_INPUT_IMAGE_BYTES} bytes`,
    );
  }
  const bytes = Uint8Array.from(part.data);
  if (!hasImageSignature(bytes, part.mediaType)) {
    throw new ArtifactError(
      "artifact_media_mismatch",
      `Image bytes do not match ${part.mediaType}`,
    );
  }
  const placeholder = validatePlaceholder(
    part.placeholder ?? `image ${imageNumber}`,
  );
  const reference: ArtifactReference = {
    byteLength: bytes.byteLength,
    digest: await artifactDigest(bytes),
    mediaType: part.mediaType,
  };
  return {
    artifact: { bytes, reference },
    part: { artifact: reference, placeholder, type: "image" },
  };
}

export async function prepareThreadInput(
  input: ThreadInput,
): Promise<PreparedThreadInput> {
  if (typeof input === "string") {
    if (input.trim().length === 0) {
      throw new InvalidTransitionError("Thread input must not be empty");
    }
    return { artifacts: [], payload: { content: input } };
  }
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.content)
  ) {
    throw new InvalidTransitionError(
      "Thread input must be text or ordered text-and-image content",
    );
  }

  const stored: StoredInputPart[] = [];
  const artifacts: PreparedArtifact[] = [];
  const placeholders = new Set<string>();
  let imageCount = 0;
  let totalImageBytes = 0;

  for (const [index, part] of input.content.entries()) {
    if (part === null || typeof part !== "object") {
      throw new InvalidTransitionError(`Thread input part ${index} is invalid`);
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new InvalidTransitionError(
          `Thread input text part ${index} must contain text`,
        );
      }
      if (part.text.length > 0) {
        stored.push({ text: part.text, type: "text" });
      }
      continue;
    }
    if (part.type !== "image") {
      throw new InvalidTransitionError(
        `Thread input part ${index} has an unsupported type`,
      );
    }
    imageCount += 1;
    if (imageCount > MAX_INPUT_IMAGES) {
      throw new ArtifactError(
        "artifact_count_exceeded",
        `One Thread input supports at most ${MAX_INPUT_IMAGES} images`,
      );
    }
    const prepared = await prepareImage(part, imageCount);
    if (placeholders.has(prepared.part.placeholder)) {
      throw new ArtifactError(
        "artifact_placeholder_duplicate",
        `Image placeholder ${prepared.part.placeholder} is duplicated`,
      );
    }
    placeholders.add(prepared.part.placeholder);
    totalImageBytes += prepared.artifact.reference.byteLength;
    if (totalImageBytes > MAX_INPUT_TOTAL_IMAGE_BYTES) {
      throw new ArtifactError(
        "artifact_total_size_exceeded",
        `One Thread input supports at most ${MAX_INPUT_TOTAL_IMAGE_BYTES} image bytes`,
      );
    }
    stored.push(prepared.part);
    artifacts.push(prepared.artifact);
  }

  const content = stored
    .map((part) =>
      part.type === "text" ? part.text : `[${part.placeholder}]`,
    )
    .join("");
  if (imageCount === 0 && content.trim().length === 0) {
    throw new InvalidTransitionError("Thread input must not be empty");
  }
  return {
    artifacts,
    payload: { content, parts: stored },
  };
}
