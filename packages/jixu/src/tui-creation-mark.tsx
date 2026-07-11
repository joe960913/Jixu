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

interface ButterflyRun {
  readonly content: string;
  readonly ink: ButterflyInk;
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

  if (
    row >= bodyStart &&
    row <= bodyEnd &&
    distanceFromCenter <= bodyRadius
  ) {
    return "brand";
  }

  if (
    /[*#%@]/u.test(character) &&
    distanceFromCenter <= dimensions.columns * 0.31
  ) {
    return "mizuasagi";
  }

  if (/[#%@]/u.test(character)) return "gofun";
  return "quiet";
}

function packButterflyRow(
  row: string,
  rowIndex: number,
  dimensions: { readonly columns: number; readonly rows: number },
): readonly ButterflyRun[] {
  const runs: ButterflyRun[] = [];
  const paddedRow = row.padEnd(dimensions.columns);

  for (let column = 0; column < dimensions.columns; column += 1) {
    const character = paddedRow[column] ?? " ";
    const ink = butterflyInk(character, column, rowIndex, dimensions);
    const previous = runs.at(-1);
    if (previous?.ink === ink) {
      runs[runs.length - 1] = {
        content: `${previous.content}${character}`,
        ink,
      };
    } else {
      runs.push({ content: character, ink });
    }
  }

  return Object.freeze(runs);
}

function butterflyColor(ink: ButterflyInk): string {
  if (ink === "brand") return jixuTheme.brand;
  if (ink === "gofun") return jixuNipponColors.gofun;
  if (ink === "mizuasagi") return jixuNipponColors.mizuasagi;
  return jixuTheme.secondary;
}

export function JixuCreationMark({
  variant,
}: {
  readonly variant: JixuCreationMarkVariant;
}) {
  const rows = BUTTERFLY_MARKS[variant];
  const dimensions = JIXU_CREATION_MARK_DIMENSIONS[variant];
  const packedRows = rows.map((row, rowIndex) =>
    packButterflyRow(row, rowIndex, dimensions),
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
              fg={butterflyColor(run.ink)}
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
