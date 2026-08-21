import { RGBA, type BoxRenderable, type OptimizedBuffer } from "@opentui/core";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { jixuNipponColors, jixuTheme } from "./theme.ts";

export const ULTRA_COMPOSER_BORDER_CADENCE_MS = 100;
const ULTRA_COMPOSER_BORDER_FRAME_COUNT = 64;

const BRAND_COLOR = RGBA.fromHex(jixuTheme.brand);
const ASAGI_COLOR = RGBA.fromHex(jixuNipponColors.mizuasagi);

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function mixColor(from: RGBA, to: RGBA, weight: number): RGBA {
  const eased = smoothstep(weight);
  return RGBA.fromValues(
    from.r + (to.r - from.r) * eased,
    from.g + (to.g - from.g) * eased,
    from.b + (to.b - from.b) * eased,
  );
}

const ULTRA_COMPOSER_BORDER_PALETTE = Object.freeze(
  Array.from({ length: ULTRA_COMPOSER_BORDER_FRAME_COUNT }, (_, index) => {
    const cycle = index / ULTRA_COMPOSER_BORDER_FRAME_COUNT;
    const wave = (1 - Math.cos(cycle * Math.PI * 2)) / 2;
    const saturatedWeight = smoothstep((wave - 0.18) / 0.64);
    return mixColor(BRAND_COLOR, ASAGI_COLOR, saturatedWeight);
  }),
);

function borderCellColor(
  index: number,
  perimeterLength: number,
  frameIndex: number,
): RGBA {
  const paletteIndex = Math.floor(
    (index / perimeterLength) * ULTRA_COMPOSER_BORDER_FRAME_COUNT,
  );
  const movingIndex =
    (paletteIndex - frameIndex + ULTRA_COMPOSER_BORDER_FRAME_COUNT) %
    ULTRA_COMPOSER_BORDER_FRAME_COUNT;
  return ULTRA_COMPOSER_BORDER_PALETTE[movingIndex] ?? BRAND_COLOR;
}

function drawBorderCell(
  buffer: OptimizedBuffer,
  box: BoxRenderable,
  characters: Uint32Array,
  attributes: Uint32Array,
  x: number,
  y: number,
  color: RGBA,
): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  const cellIndex = y * buffer.width + x;
  const character = characters[cellIndex];
  if (character === undefined || character === 0) return;
  buffer.drawChar(
    character,
    x,
    y,
    color,
    box.backgroundColor,
    attributes[cellIndex],
  );
}

function drawUltraComposerBorder(
  buffer: OptimizedBuffer,
  box: BoxRenderable,
  frameIndex: number,
): void {
  const width = box.width;
  const height = box.height;
  if (width < 2 || height < 2) return;

  const left = box.screenX;
  const top = box.screenY;
  const right = left + width - 1;
  const bottom = top + height - 1;
  const perimeterLength = width * 2 + height * 2 - 4;
  const { attributes, char: characters } = buffer.buffers;
  let index = 0;

  for (let x = left; x <= right; x += 1) {
    drawBorderCell(
      buffer,
      box,
      characters,
      attributes,
      x,
      top,
      borderCellColor(index, perimeterLength, frameIndex),
    );
    index += 1;
  }
  for (let y = top + 1; y <= bottom; y += 1) {
    drawBorderCell(
      buffer,
      box,
      characters,
      attributes,
      right,
      y,
      borderCellColor(index, perimeterLength, frameIndex),
    );
    index += 1;
  }
  for (let x = right - 1; x >= left; x -= 1) {
    drawBorderCell(
      buffer,
      box,
      characters,
      attributes,
      x,
      bottom,
      borderCellColor(index, perimeterLength, frameIndex),
    );
    index += 1;
  }
  for (let y = bottom - 1; y > top; y -= 1) {
    drawBorderCell(
      buffer,
      box,
      characters,
      attributes,
      left,
      y,
      borderCellColor(index, perimeterLength, frameIndex),
    );
    index += 1;
  }
}

export function ComposerFrame({
  children,
  maxHeight,
  minHeight,
  motion,
  ultra,
  width,
}: {
  readonly children: ReactNode;
  readonly maxHeight: number;
  readonly minHeight: number;
  readonly motion: boolean;
  readonly ultra: boolean;
  readonly width: number;
}) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!ultra || !motion) return;
    const timer = setInterval(() => {
      setFrameIndex(
        (index) => (index + 1) % ULTRA_COMPOSER_BORDER_FRAME_COUNT,
      );
    }, ULTRA_COMPOSER_BORDER_CADENCE_MS);
    return () => clearInterval(timer);
  }, [motion, ultra]);

  const renderAfter = useCallback(
    function (this: BoxRenderable, buffer: OptimizedBuffer): void {
      if (!ultra) return;
      drawUltraComposerBorder(buffer, this, motion ? frameIndex : 0);
    },
    [frameIndex, motion, ultra],
  );

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border={["top", "bottom", "left", "right"]}
      borderColor={jixuTheme.divider}
      id="composer"
      renderAfter={renderAfter}
      style={{
        alignItems: "flex-start",
        columnGap: 1,
        flexDirection: "row",
        flexShrink: 0,
        maxHeight,
        minHeight,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        width,
      }}
    >
      {children}
    </box>
  );
}
