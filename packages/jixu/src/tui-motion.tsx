import { useEffect, useState } from "react";

import { jixuTheme } from "./theme.ts";
import type { JixuTone } from "./tui-model.ts";

const THINKING_CADENCE = 120;

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

export function ThinkingMotionText({
  enabled,
  id,
  label,
  tone,
}: {
  readonly enabled: boolean;
  readonly id?: string;
  readonly label: string;
  readonly tone: JixuTone;
}) {
  const [frameIndex, setFrameIndex] = useState(0);
  const text = `${label} ...`;
  const characters = [...text];
  const motionIndices = characters.flatMap((character, index) =>
    character === " " ? [] : [index],
  );
  const dotStart = characters.length - 3;

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % motionIndices.length);
    }, THINKING_CADENCE);
    return () => clearInterval(timer);
  }, [enabled, motionIndices.length]);

  if (!enabled) {
    return (
      <box
        {...(id === undefined ? {} : { id })}
        style={{
          flexDirection: "row",
          flexShrink: 0,
          height: 1,
          width: characters.length,
        }}
      >
        <text fg={toneColor(tone)} selectable={false}>
          <strong>{text}</strong>
        </text>
      </box>
    );
  }

  const activeIndex = motionIndices[frameIndex] ?? 0;
  const previousFrame =
    (frameIndex - 1 + motionIndices.length) % motionIndices.length;
  const echoIndex = motionIndices[previousFrame] ?? null;
  return (
    <box
      {...(id === undefined ? {} : { id })}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        width: characters.length,
      }}
    >
      {characters.map((character, index) => {
        const active = index === activeIndex;
        const raisedDot = active && index >= dotStart;
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
