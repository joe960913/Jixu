import { useEffect, useState } from "react";

import { jixuNipponColors, jixuTheme } from "./theme.ts";

// Fixed density reductions of the maintainer-provided hudie.txt source. Both
// preserve its roughly 2.5:1 character aspect ratio; 16 rows is a hard maximum
// so a larger terminal adds breathing room instead of enlarging the mark.

const COMPACT_BUTTERFLY_MARK = Object.freeze([
  "   -++=.                         -+++:",
  " +%*+++++*=-                :=*++++*#%#",
  " :++=-:--=+++-            -++=--=+++**:",
  "   :+==-:---=+=:        :==+--====++-",
  "    -+=-::---:-+-.    .-=--======++-",
  "    :+=--:-----:==:  :===+++=---=++.",
  "     =+---::--=-=++::+***+=-----=+-",
  "     :+=-:::::--=+*%%##**+=-==-=++:",
  "       :-=+=-::::-*%%*+=---==+*+=.",
  "     .=*+----=+=++*#%*==-=+====+*+-",
  "     :**+==++++*****+****+*****+**=",
  "      =*++++++**##*=:+##*********+:",
  "      .+*******#**-. :*****#*##**-",
  "       -*******#*:    :********#-",
  "       .-+****#+:      .=##***+=:",
  "         -====            ====-",
] satisfies readonly string[]);

const SMALL_BUTTERFLY_MARK = Object.freeze([
  " =++=-.           .=-+*+-",
  " ++---+=-       -=+-=+*+:",
  "  :+-:--==.   :-=====+-",
  "   =------=: -+=+=--==",
  "   -=-:::-=****+=---+-",
  "    -==-:--*%*=--==+=.",
  "   -*+=+++*****+***+*=",
  "    +**+**#+:=*******:",
  "    :****#=   =#****-",
  "     .+++-     -+++",
] satisfies readonly string[]);

type ButterflyInk = "brand" | "gofun" | "mizuasagi" | "quiet";
type ButterflyWingInk = Exclude<ButterflyInk, "brand">;

interface ButterflyRun {
  readonly color: string;
  readonly content: string;
}

export type JixuCreationMarkVariant = "compact" | "small";

const BUTTERFLY_MARKS: Readonly<
  Record<JixuCreationMarkVariant, readonly string[]>
> = Object.freeze({
  compact: COMPACT_BUTTERFLY_MARK,
  small: SMALL_BUTTERFLY_MARK,
});

function markDimensions(rows: readonly string[], columns: number) {
  if (rows.some((row) => row.length > columns)) {
    throw new RangeError("Jixu butterfly row exceeds its fixed canvas width");
  }

  return Object.freeze({
    columns,
    rows: rows.length,
  });
}

export const JIXU_CREATION_MARK_DIMENSIONS = Object.freeze({
  compact: markDimensions(COMPACT_BUTTERFLY_MARK, 40),
  small: markDimensions(SMALL_BUTTERFLY_MARK, 25),
});

export const BUTTERFLY_MOTION_CADENCE_MS = 140;
const BUTTERFLY_MOTION_FRAME_COUNT = 56;
const BUTTERFLY_DIFFUSION_PHASE_SPAN = Math.PI * 1.45;
const COMPACT_UPPER_RIGHT_BRAND_ACCENT = "#%#";
const COMPACT_UPPER_RIGHT_BRAND_ROW = 1;
const COMPACT_UPPER_RIGHT_BRAND_COLUMN =
  COMPACT_BUTTERFLY_MARK[COMPACT_UPPER_RIGHT_BRAND_ROW]?.lastIndexOf(
    COMPACT_UPPER_RIGHT_BRAND_ACCENT,
  ) ?? -1;

function mixHexColor(
  foreground: string,
  background: string,
  amount: number,
): string {
  const foregroundValue = Number.parseInt(foreground.slice(1), 16);
  const backgroundValue = Number.parseInt(background.slice(1), 16);
  const channel = (shift: number) => {
    const foregroundChannel = (foregroundValue >> shift) & 0xff;
    const backgroundChannel = (backgroundValue >> shift) & 0xff;
    return Math.round(
      backgroundChannel + (foregroundChannel - backgroundChannel) * amount,
    );
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function butterflyInkColor(ink: ButterflyInk): string {
  if (ink === "brand") return jixuTheme.brand;
  if (ink === "gofun") return jixuNipponColors.gofun;
  if (ink === "mizuasagi") return jixuNipponColors.mizuasagi;
  return jixuTheme.secondary;
}

function isUpperRightBrandAccent(
  column: number,
  row: number,
  dimensions: { readonly columns: number; readonly rows: number },
): boolean {
  return (
    dimensions.columns === JIXU_CREATION_MARK_DIMENSIONS.compact.columns &&
    dimensions.rows === JIXU_CREATION_MARK_DIMENSIONS.compact.rows &&
    row === COMPACT_UPPER_RIGHT_BRAND_ROW &&
    column >= COMPACT_UPPER_RIGHT_BRAND_COLUMN &&
    column <
      COMPACT_UPPER_RIGHT_BRAND_COLUMN +
        COMPACT_UPPER_RIGHT_BRAND_ACCENT.length
  );
}

function butterflyWingInk(
  character: string,
  column: number,
  dimensions: { readonly columns: number; readonly rows: number },
): ButterflyWingInk {
  if (character === " ") return "quiet";

  const center = (dimensions.columns - 1) / 2;
  const distanceFromCenter = Math.abs(column - center);
  if (
    /[*#%@]/u.test(character) &&
    distanceFromCenter <= dimensions.columns * 0.31
  ) {
    return "mizuasagi";
  }
  if (/[#%@]/u.test(character)) return "gofun";
  return "quiet";
}

function butterflyInk(
  character: string,
  column: number,
  row: number,
  dimensions: { readonly columns: number; readonly rows: number },
): ButterflyInk {
  if (character === " ") return "quiet";

  const center = (dimensions.columns - 1) / 2;
  const distanceFromCenter = Math.abs(column - center);
  const bodyRadius = Math.max(1, Math.round(dimensions.columns * 0.055));
  const bodyStart = Math.floor(dimensions.rows * 0.3);
  const bodyEnd = Math.ceil(dimensions.rows * 0.72);

  if (isUpperRightBrandAccent(column, row, dimensions)) {
    return "brand";
  }

  if (
    row >= bodyStart &&
    row <= bodyEnd &&
    distanceFromCenter <= bodyRadius
  ) {
    return "brand";
  }

  return butterflyWingInk(character, column, dimensions);
}

function packButterflyRow(
  row: string,
  rowIndex: number,
  dimensions: { readonly columns: number; readonly rows: number },
  frameIndex: number | null,
): readonly ButterflyRun[] {
  const runs: ButterflyRun[] = [];
  const paddedRow = row.padEnd(dimensions.columns);

  for (let column = 0; column < dimensions.columns; column += 1) {
    const character = paddedRow[column] ?? " ";
    const ink = butterflyInk(character, column, rowIndex, dimensions);
    const color = butterflyColor(
      character,
      ink,
      column,
      rowIndex,
      dimensions,
      frameIndex,
    );
    const previous = runs.at(-1);
    if (previous?.color === color) {
      runs[runs.length - 1] = {
        content: `${previous.content}${character}`,
        color,
      };
    } else {
      runs.push({ color, content: character });
    }
  }

  return Object.freeze(runs);
}

function butterflyColor(
  character: string,
  ink: ButterflyInk,
  column: number,
  row: number,
  dimensions: { readonly columns: number; readonly rows: number },
  frameIndex: number | null,
): string {
  if (character === " ") return jixuTheme.secondary;
  const baseColor = butterflyInkColor(ink);
  if (frameIndex === null) {
    return baseColor;
  }
  if (isUpperRightBrandAccent(column, row, dimensions)) {
    return jixuTheme.brand;
  }

  const cycle =
    (frameIndex / BUTTERFLY_MOTION_FRAME_COUNT) * Math.PI * 2;
  const center = (dimensions.columns - 1) / 2;
  const bodyCenter = (dimensions.rows - 1) / 2;
  const horizontalDistance = Math.abs(column - center) / Math.max(1, center);
  const verticalDistance =
    Math.abs(row - bodyCenter) / Math.max(1, bodyCenter);
  const diffusionDistance = Math.min(
    1,
    Math.hypot(horizontalDistance, verticalDistance * 0.28),
  );
  // One broad phase advances from the body through both mirrored wings. It
  // reads as diffusion rather than a narrow scan or an alternating sweep.
  const phase =
    cycle + Math.PI * 0.25 -
    diffusionDistance * BUTTERFLY_DIFFUSION_PHASE_SPAN;
  const iridescence = (1 - Math.cos(phase)) / 2;
  const easedIridescence = smoothstep(iridescence);

  const wingInk = butterflyWingInk(character, column, dimensions);
  let animatedColor = butterflyInkColor(wingInk);
  if (wingInk === "gofun") {
    animatedColor = mixHexColor(
      jixuNipponColors.gofun,
      jixuNipponColors.mizuasagi,
      1 - easedIridescence * 0.44,
    );
  } else if (wingInk === "mizuasagi") {
    animatedColor = mixHexColor(
      jixuNipponColors.mizuasagi,
      jixuNipponColors.gofun,
      1 - easedIridescence * 0.64,
    );
  }

  const bodyRadius = Math.max(1, Math.round(dimensions.columns * 0.055));
  const bodyStart = Math.floor(dimensions.rows * 0.3);
  const bodyEnd = Math.ceil(dimensions.rows * 0.72);
  const brandCenterColumn = center + Math.sin(cycle) * 0.68;
  const brandCenterRow =
    (bodyStart + bodyEnd) / 2 + Math.cos(cycle) * 0.32;
  const horizontalWeight = smoothstep(
    bodyRadius + 0.82 - Math.abs(column - brandCenterColumn),
  );
  const verticalWeight = smoothstep(
    (bodyEnd - bodyStart) / 2 + 0.55 -
      Math.abs(row - brandCenterRow),
  );
  const brandWeight = horizontalWeight * verticalWeight;
  if (brandWeight === 0) return animatedColor;

  const blush = smoothstep((1 - Math.cos(cycle - row * 0.08)) / 2);
  const brandColor = mixHexColor(
    jixuTheme.brand,
    jixuNipponColors.gofun,
    1 - blush * 0.16,
  );
  return mixHexColor(brandColor, animatedColor, brandWeight);
}

export function JixuCreationMark({
  motion,
  variant,
}: {
  readonly motion: boolean;
  readonly variant: JixuCreationMarkVariant;
}) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!motion) return;
    const timer = setInterval(() => {
      setFrameIndex((index) =>
        (index + 1) % BUTTERFLY_MOTION_FRAME_COUNT,
      );
    }, BUTTERFLY_MOTION_CADENCE_MS);
    return () => clearInterval(timer);
  }, [motion]);

  const rows = BUTTERFLY_MARKS[variant];
  const dimensions = JIXU_CREATION_MARK_DIMENSIONS[variant];
  const packedRows = rows.map((row, rowIndex) =>
    packButterflyRow(
      row,
      rowIndex,
      dimensions,
      motion ? frameIndex : null,
    ),
  );
  return (
    <box
      id="jixu-creation-mark"
      style={{
        alignItems: "center",
        flexDirection: "column",
        height: dimensions.rows,
        marginBottom: 1,
        width: dimensions.columns,
      }}
    >
      {packedRows.map((runs, rowIndex) => (
        <text
          id={`jixu-creation-mark-row-${rowIndex}`}
          key={`${variant}-creation-row-${rowIndex}`}
          selectable={false}
          style={{ height: 1, width: dimensions.columns }}
          wrapMode="none"
        >
          {runs.map((run, runIndex) => (
            <span
              fg={run.color}
              key={`${variant}-creation-run-${rowIndex}-${runIndex}`}
            >
              {run.content}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
