import { useEffect, useState } from "react";

import { jixuTheme } from "./theme.ts";
import type { JixuTone } from "./tui-model.ts";

const THINKING_LABEL = "Thinking ...";
const THINKING_CADENCE = 120;
const THINKING_CHARACTERS = Object.freeze([...THINKING_LABEL]);
const THINKING_MOTION_INDICES = Object.freeze(
  THINKING_CHARACTERS.flatMap((character, index) =>
    character === " " ? [] : [index],
  ),
);
const THINKING_DOT_START = THINKING_CHARACTERS.length - 3;

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

export function ThinkingMotionText({
  enabled,
  id,
  tone,
}: {
  readonly enabled: boolean;
  readonly id?: string;
  readonly tone: JixuTone;
}) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % THINKING_MOTION_INDICES.length);
    }, THINKING_CADENCE);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) {
    return (
      <box
        {...(id === undefined ? {} : { id })}
        style={{
          flexDirection: "row",
          flexShrink: 0,
          height: 1,
          width: THINKING_CHARACTERS.length,
        }}
      >
        <text fg={toneColor(tone)} selectable={false}>
          <strong>{THINKING_LABEL}</strong>
        </text>
      </box>
    );
  }

  const activeIndex = THINKING_MOTION_INDICES[frameIndex] ?? 0;
  const previousFrame =
    (frameIndex - 1 + THINKING_MOTION_INDICES.length) %
    THINKING_MOTION_INDICES.length;
  const echoIndex = THINKING_MOTION_INDICES[previousFrame] ?? null;
  return (
    <box
      {...(id === undefined ? {} : { id })}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        width: THINKING_CHARACTERS.length,
      }}
    >
      {THINKING_CHARACTERS.map((character, index) => {
        const active = index === activeIndex;
        const raisedDot = active && index >= THINKING_DOT_START;
        return (
          <text
            fg={
              active
                ? toneColor(tone)
                : index === echoIndex
                  ? jixuTheme.brand
                  : jixuTheme.secondary
            }
            key={`${index}:${character}`}
            selectable={false}
          >
            {active ? (
              <strong>{raisedDot ? "•" : character}</strong>
            ) : (
              character
            )}
          </text>
        );
      })}
    </box>
  );
}

export function JixuWordmark() {
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, height: 1, width: 6 }}>
      <text
        fg={jixuTheme.brand}
        id="ephemeral-jixu-wordmark"
        selectable={false}
      >
        <strong>JIXU</strong>
      </text>
      <text>  </text>
    </box>
  );
}
