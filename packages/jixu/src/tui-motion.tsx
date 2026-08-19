import { useEffect, useState } from "react";

import { jixuTheme } from "./theme.ts";
import type { JixuTone, WorkPhase } from "./tui-model.ts";

const PHASE_CADENCE: Readonly<Record<WorkPhase, number>> = Object.freeze({
  planning: 210,
  responding: 1_000,
  thinking: 180,
  tool: 140,
});

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

function sweepFor(length: number): readonly number[] {
  const forward = Array.from({ length }, (_, index) => index);
  const backward = Array.from(
    { length: Math.max(0, length - 2) },
    (_, index) => length - index - 2,
  );
  return Object.freeze([...forward, ...backward]);
}

export function JixuMotionText({
  enabled,
  id,
  label,
  phase,
  staticTone,
  tone,
}: {
  readonly enabled: boolean;
  readonly id?: string;
  readonly label: string;
  readonly phase: WorkPhase;
  readonly staticTone: JixuTone;
  readonly tone: JixuTone;
}) {
  const animated = enabled && phase !== "responding";
  const [frameIndex, setFrameIndex] = useState(0);
  const characters = [...label];
  const sweep = sweepFor(characters.length);

  useEffect(() => {
    if (!animated || sweep.length === 0) return;
    const timer = setTimeout(() => {
      setFrameIndex((index) => (index + 1) % sweep.length);
    }, PHASE_CADENCE[phase]);
    return () => clearTimeout(timer);
  }, [animated, frameIndex, phase, sweep.length]);

  if (!animated) {
    return (
      <box
        {...(id === undefined ? {} : { id })}
        style={{ flexDirection: "row", flexShrink: 0, height: 1, width: characters.length }}
      >
        <text fg={toneColor(staticTone)} selectable={false}>
          <strong>{label}</strong>
        </text>
      </box>
    );
  }

  const activeIndex = sweep[frameIndex] ?? 0;
  const echoIndex = frameIndex === 0 ? null : sweep[frameIndex - 1] ?? null;
  return (
    <box
      {...(id === undefined ? {} : { id })}
      style={{ flexDirection: "row", flexShrink: 0, height: 1, width: characters.length }}
    >
      {characters.map((letter, index) => (
        <text
          fg={
            index === activeIndex
              ? toneColor(tone)
              : index === echoIndex
                ? jixuTheme.brand
                : jixuTheme.secondary
          }
          key={`${index}:${letter}`}
          selectable={false}
        >
          {index === activeIndex ? <strong>{letter}</strong> : letter}
        </text>
      ))}
    </box>
  );
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
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1, width: 6 }}>
      <JixuMotionText
        enabled={enabled}
        label="JIXU"
        phase={phase}
        staticTone="brand"
        tone={tone}
      />
      <text>  </text>
    </box>
  );
}
