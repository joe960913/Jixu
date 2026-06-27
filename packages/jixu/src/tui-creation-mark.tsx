import { jixuTheme } from "./theme.ts";

type Ink = "." | "L" | "R" | "S";

interface PackedRun {
  readonly content: string;
  readonly ink: Ink;
}

const MARK_WIDTH = 55;

// Original logical-pixel drawing: two hands approach without touching. The
// one warm pixel between them is the creation spark. Two logical rows pack into
// each terminal row through ordinary block-element text.
const CREATION_PIXELS = Object.freeze([
  ".......................................................",
  "..................................................RRRR.",
  ".............................................RRRRR...R.",
  "..........................................RRR........R.",
  ".............LLLLLL......................R...........R.",
  "............L......LL.................RRR............R.",
  "...........L.........L............RRRR............RRRR.",
  ".........LL...........LL.......RRR...........RRRRR.....",
  "........L...........LL..L....RRRRR..........R..........",
  ".......L...L.......L..LL...S.RR...R......R.R...........",
  "....LLL..LL.L.L..LL................R..R.R.RR...........",
  ".LLL....L...LL.LL.L.................RR.RR.RR...........",
  "L.....LL....LL.LL.LL................RR.RR.R.R..........",
  "L..LLL......LL.LL.LL...............RR..RR..RR..........",
  "LLL.........LL.LL.LL...............RR..RR..R...........",
  "L...........L..LL.L................R...RR..............",
  "...............L.......................R...............",
  ".......................................................",
] satisfies readonly string[]);

function cell(top: Ink, bottom: Ink): { readonly content: string; readonly ink: Ink } {
  if (top === "." && bottom === ".") return { content: " ", ink: "." };
  if (top !== "." && bottom !== "." && top !== bottom) {
    throw new TypeError("Jixu creation mark layers must not share a terminal cell");
  }
  if (top === bottom) return { content: "█", ink: top };
  if (top !== ".") return { content: "▀", ink: top };
  return { content: "▄", ink: bottom };
}

function packRows(): readonly (readonly PackedRun[])[] {
  return Array.from({ length: CREATION_PIXELS.length / 2 }, (_, rowIndex) => {
    const top = CREATION_PIXELS[rowIndex * 2] ?? "";
    const bottom = CREATION_PIXELS[rowIndex * 2 + 1] ?? "";
    const runs: PackedRun[] = [];
    for (let column = 0; column < MARK_WIDTH; column += 1) {
      const packed = cell(
        (top[column] ?? ".") as Ink,
        (bottom[column] ?? ".") as Ink,
      );
      const previous = runs.at(-1);
      if (previous?.ink === packed.ink) {
        runs[runs.length - 1] = {
          content: `${previous.content}${packed.content}`,
          ink: previous.ink,
        };
      } else {
        runs.push(packed);
      }
    }
    return Object.freeze(runs);
  });
}

const PACKED_ROWS = Object.freeze(packRows());

function inkColor(ink: Exclude<Ink, ".">): string {
  if (ink === "L") return jixuTheme.brand;
  if (ink === "R") return jixuTheme.info;
  return jixuTheme.warning;
}

export const JIXU_CREATION_MARK_ROWS = PACKED_ROWS.length;

export function JixuCreationMark() {
  return (
    <box
      id="jixu-creation-mark"
      style={{
        alignItems: "center",
        flexDirection: "column",
        height: JIXU_CREATION_MARK_ROWS,
        marginBottom: 1,
        width: MARK_WIDTH,
      }}
    >
      {PACKED_ROWS.map((runs, rowIndex) => (
        <text
          id={`jixu-creation-mark-row-${rowIndex}`}
          key={`creation-row-${rowIndex}`}
          selectable={false}
          style={{ height: 1, width: MARK_WIDTH }}
          wrapMode="none"
        >
          {runs.map((run, runIndex) =>
            run.ink === "." ? (
              run.content
            ) : (
              <span
                fg={inkColor(run.ink)}
                key={`creation-run-${rowIndex}-${runIndex}`}
              >
                {run.content}
              </span>
            ),
          )}
        </text>
      ))}
    </box>
  );
}
