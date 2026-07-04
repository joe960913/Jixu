import type { PlanStepStatus } from "@jixu/core";

import { jixuTheme } from "./theme.ts";
import type {
  AttentionLine,
  AttentionModel,
  AttentionPlanStep,
} from "./tui-attention.ts";
import { JixuIcon, type JixuIconName } from "./tui-icons.tsx";
import type { JixuTone } from "./tui-model.ts";

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return maximum <= 1 ? "…" : `${value.slice(0, maximum - 1)}…`;
}

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

function stepPresentation(status: PlanStepStatus): {
  readonly color: string;
  readonly symbol: string;
} {
  switch (status) {
    case "completed":
      return { color: jixuTheme.success, symbol: "✓" };
    case "in_progress":
      return { color: jixuTheme.warning, symbol: "◉" };
    case "blocked":
      return { color: jixuTheme.danger, symbol: "×" };
    case "skipped":
      return { color: jixuTheme.secondary, symbol: "—" };
    case "pending":
      return { color: jixuTheme.secondary, symbol: "○" };
  }
}

function SectionTitle({
  icon,
  label,
  tone,
}: {
  readonly icon: JixuIconName;
  readonly label: string;
  readonly tone: JixuTone;
}) {
  return (
    <box
      style={{ alignItems: "center", flexDirection: "row", flexShrink: 0, height: 1 }}
    >
      <JixuIcon
        id={`attention-glyph-${label.toLowerCase().replace(/\s+/gu, "-")}`}
        name={icon}
      />
      <text fg={toneColor(tone)}>
        <strong>{label}</strong>
      </text>
    </box>
  );
}

function AttentionContent({ line, width }: { readonly line: AttentionLine; readonly width: number }) {
  const contentWidth = Math.max(8, width - 4);
  return (
    <box
      style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 2, width: "100%" }}
    >
      <text fg={toneColor(line.tone)} wrapMode="word">
        {truncate(line.label, contentWidth)}
      </text>
      {line.detail === undefined ? null : (
        <text fg={jixuTheme.secondary} wrapMode="word">
          {truncate(line.detail, contentWidth * 2)}
        </text>
      )}
    </box>
  );
}

function PlanStep({ step, width }: { readonly step: AttentionPlanStep; readonly width: number }) {
  const presentation = stepPresentation(step.status);
  return (
    <box style={{ flexDirection: "row", paddingLeft: 2, width: "100%" }}>
      <text fg={presentation.color}>{presentation.symbol} </text>
      <text fg={step.status === "in_progress" ? jixuTheme.warning : jixuTheme.secondary}>
        {truncate(step.description, Math.max(8, width - 6))}
      </text>
    </box>
  );
}

export function AttentionRail({
  height,
  model,
  width,
}: {
  readonly height: number;
  readonly model: AttentionModel;
  readonly width: number;
}) {
  const compactHeight = height < 40;
  const visibleSteps = model.plan.steps.slice(0, compactHeight ? 2 : 4);
  const hiddenSteps = model.plan.steps.length - visibleSteps.length;
  const verified = model.verified.slice(0, compactHeight ? 1 : 2);
  const nowHeight = 5;
  const planHeight = compactHeight ? 7 : 13;
  const verifiedHeight = compactHeight ? 4 : 8;
  return (
    <box
      border={["left"]}
      borderColor={jixuTheme.divider}
      id="attention-rail"
      style={{
        flexDirection: "column",
        height,
        overflow: "hidden",
        paddingLeft: 2,
        width,
      }}
    >
      <box
        border={["bottom"]}
        borderColor={jixuTheme.divider}
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height: nowHeight,
          overflow: "hidden",
        }}
      >
        <SectionTitle icon={model.now.icon} label="NOW" tone="brand" />
        <AttentionContent line={model.now} width={width} />
      </box>

      <box
        border={["bottom"]}
        borderColor={jixuTheme.divider}
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height: planHeight,
          overflow: "hidden",
        }}
      >
        <SectionTitle icon={model.plan.icon} label="PLAN" tone="warning" />
        <box style={{ flexDirection: "column", paddingLeft: 2, width: "100%" }}>
          <text fg={jixuTheme.text} wrapMode="word">
            {truncate(model.plan.label, Math.max(8, width - 4))}
          </text>
          <text fg={jixuTheme.secondary} wrapMode="word">
            {truncate(model.plan.detail, Math.max(8, (width - 4) * 2))}
          </text>
        </box>
        {visibleSteps.map((step) => (
          <PlanStep key={step.id} step={step} width={width} />
        ))}
        {hiddenSteps > 0 ? (
          <text fg={jixuTheme.secondary}>  +{hiddenSteps} more</text>
        ) : null}
      </box>

      <box
        border={["bottom"]}
        borderColor={jixuTheme.divider}
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height: verifiedHeight,
          overflow: "hidden",
        }}
      >
        <SectionTitle icon="verified" label="VERIFIED" tone="success" />
        {verified.map((line, index) => (
          <AttentionContent key={`${line.label}:${index}`} line={line} width={width} />
        ))}
      </box>

      <box
        style={{ flexDirection: "column", flexGrow: 1, minHeight: 3, overflow: "hidden" }}
      >
        <SectionTitle
          icon={model.needsYou.icon}
          label="NEEDS YOU"
          tone={model.needsYou.tone === "danger" ? "danger" : "warning"}
        />
        <AttentionContent line={model.needsYou} width={width} />
      </box>
      <text fg={jixuTheme.secondary} style={{ flexShrink: 0, height: 1 }}>
        /events · durable history
      </text>
    </box>
  );
}

export function AttentionStrip({
  model,
  width,
}: {
  readonly model: AttentionModel;
  readonly width: number;
}) {
  const half = Math.max(12, Math.floor(width / 2) - 2);
  const verified = model.verified[0];
  return (
    <box
      border={["top"]}
      borderColor={jixuTheme.divider}
      id="attention-strip"
      style={{ flexDirection: "column", flexShrink: 0, height: 3, width }}
    >
      <box style={{ flexDirection: "row", height: 1, overflow: "hidden", width }}>
        <text fg={jixuTheme.brand}> NOW </text>
        <text fg={toneColor(model.now.tone)}>{truncate(model.now.label, half - 5)}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.warning}> PLAN </text>
        <text fg={jixuTheme.secondary}>{truncate(model.plan.label, half - 7)}</text>
      </box>
      <box style={{ flexDirection: "row", height: 1, overflow: "hidden", width }}>
        <text fg={jixuTheme.success}> VERIFIED </text>
        <text fg={jixuTheme.secondary}>{truncate(verified?.label ?? "Nothing yet", half - 10)}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.warning}> NEEDS YOU </text>
        <text fg={toneColor(model.needsYou.tone)}>
          {truncate(model.needsYou.label, half - 12)}
        </text>
      </box>
    </box>
  );
}
