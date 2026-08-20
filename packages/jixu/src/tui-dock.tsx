import type { PlanStepStatus } from "jixu-core";

import { jixuTheme } from "./theme.ts";
import type { ThreadControllerSnapshot } from "./tui-model.ts";

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return maximum <= 1 ? "…" : `${value.slice(0, maximum - 1)}…`;
}

function stepPresentation(status: PlanStepStatus): {
  readonly color: string;
  readonly symbol: string;
} {
  switch (status) {
    case "completed":
      return { color: jixuTheme.success, symbol: "✓" };
    case "in_progress":
      return { color: jixuTheme.warning, symbol: "→" };
    case "blocked":
      return { color: jixuTheme.danger, symbol: "×" };
    case "skipped":
      return { color: jixuTheme.secondary, symbol: "–" };
    case "pending":
      return { color: jixuTheme.info, symbol: "·" };
  }
}

function PlanStrip({
  snapshot,
  width,
}: {
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  const plan = snapshot.activePlan;
  if (plan === null) return null;
  const maximumSteps = width < 72 ? 2 : width < 112 ? 3 : 4;
  const visibleSteps = plan.steps.slice(0, maximumSteps);
  const hiddenSteps = plan.steps.length - visibleSteps.length;
  const labelWidth = width < 72 ? 12 : 16;
  const stepWidth = Math.max(
    14,
    Math.floor((width - labelWidth) / Math.max(1, visibleSteps.length)),
  );
  return (
    <box
      border={["top", "bottom"]}
      borderColor={jixuTheme.warning}
      id="plan-strip"
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 4,
        width: "100%",
      }}
    >
      <box
        style={{
          flexDirection: "column",
          flexShrink: 0,
          paddingLeft: 1,
          width: labelWidth,
        }}
      >
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={jixuTheme.warning}>
            <strong>PLAN</strong>
          </text>
        </box>
        <text fg={jixuTheme.secondary}>{truncate(plan.objective, labelWidth - 2)}</text>
      </box>
      {visibleSteps.map((step) => {
        const presentation = stepPresentation(step.status);
        return (
          <box
            border={["left"]}
            borderColor={
              step.status === "in_progress" ? jixuTheme.warning : jixuTheme.divider
            }
            key={step.id}
            style={{
              flexDirection: "column",
              flexGrow: 1,
              minWidth: stepWidth,
              overflow: "hidden",
              paddingLeft: 1,
            }}
          >
            <text fg={presentation.color} wrapMode="none">
              {presentation.symbol} {truncate(step.description, stepWidth - 6)}
            </text>
            <text fg={jixuTheme.secondary} wrapMode="none">
              {step.status === "in_progress"
                ? "In progress"
                : step.status.charAt(0).toUpperCase() + step.status.slice(1)}
            </text>
          </box>
        );
      })}
      {hiddenSteps > 0 ? (
        <box
          border={["left"]}
          borderColor={jixuTheme.divider}
          style={{ flexDirection: "column", paddingLeft: 1, width: 12 }}
        >
          <text fg={jixuTheme.secondary}>+{hiddenSteps}</text>
          <text fg={jixuTheme.secondary}>more steps</text>
        </box>
      ) : null}
    </box>
  );
}

export function ExecutionDock({
  snapshot,
  width,
}: {
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  if (snapshot.activePlan === null) return null;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, width }}>
      <PlanStrip snapshot={snapshot} width={width} />
    </box>
  );
}
