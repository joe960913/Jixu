import { useEffect, useState } from "react";

import { jixuTheme } from "./theme.ts";
import type { JixuTone, WorkPhase } from "./tui-model.ts";

const LETTERS = Object.freeze(["J", "I", "X", "U"] as const);
const SWEEP = Object.freeze([0, 1, 2, 3, 2, 1] as const);
const PHASE_CADENCE: Readonly<Record<WorkPhase, number>> = Object.freeze({
  planning: 210,
  responding: 1_000,
  thinking: 180,
  tool: 140,
});

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

export function JixuWordmark({
  enabled,
  phase,
  tone,
}: {
  readonly enabled: boolean;
  readonly phase: WorkPhase;
  readonly tone: JixuTone;
}) {
  const animated = enabled && phase !== "responding";
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!animated) return;
    const timer = setTimeout(() => {
      setFrameIndex((index) => (index + 1) % SWEEP.length);
    }, PHASE_CADENCE[phase]);
    return () => clearTimeout(timer);
  }, [animated, frameIndex, phase]);

  if (!animated) {
    return (
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1, width: 6 }}>
        <text fg={jixuTheme.brand} selectable={false}>
          <strong>JIXU</strong>
        </text>
        <text>  </text>
      </box>
    );
  }

  const activeIndex = SWEEP[frameIndex] ?? 0;
  const echoIndex = frameIndex === 0 ? null : SWEEP[frameIndex - 1] ?? null;
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1, width: 6 }}>
      {LETTERS.map((letter, index) => (
        <text
          fg={
            index === activeIndex
              ? toneColor(tone)
              : index === echoIndex
                ? jixuTheme.brand
                : jixuTheme.secondary
          }
          key={letter}
          selectable={false}
        >
          {index === activeIndex ? <strong>{letter}</strong> : letter}
        </text>
      ))}
      <text>  </text>
    </box>
  );
}
