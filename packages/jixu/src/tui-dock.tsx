import type { PlanStepStatus } from "@jixu/core";

import { jixuTheme } from "./theme.ts";
import { JixuWordmark } from "./tui-motion.tsx";
import type {
  JixuTone,
  ThreadControllerSnapshot,
  ToolOperation,
  ToolOperationStatus,
  WorkStatus,
} from "./tui-model.ts";

const PLAN_MAX_HEIGHT = 8;

interface ToolOperationGroup {
  readonly count: number;
  readonly name: string;
  readonly status: ToolOperationStatus;
}

function toneColor(tone: JixuTone): string {
  return jixuTheme[tone];
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return maximum <= 1 ? "…" : `${value.slice(0, maximum - 1)}…`;
}

function groupToolOperations(
  operations: readonly ToolOperation[],
): readonly ToolOperationGroup[] {
  const groups: ToolOperationGroup[] = [];
  for (const operation of operations) {
    const existingIndex = groups.findIndex(
      (group) =>
        group.name === operation.name && group.status === operation.status,
    );
    const existing = groups[existingIndex];
    if (existing === undefined) {
      groups.push({ count: 1, name: operation.name, status: operation.status });
    } else {
      groups[existingIndex] = { ...existing, count: existing.count + 1 };
    }
  }
  return groups;
}

function operationPresentation(status: ToolOperationStatus): {
  readonly color: string;
  readonly symbol: string;
} {
  switch (status) {
    case "failed":
      return { color: jixuTheme.danger, symbol: "×" };
    case "running":
      return { color: jixuTheme.warning, symbol: "→" };
    case "succeeded":
      return { color: jixuTheme.success, symbol: "✓" };
  }
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

export function WorkStatusLine({
  motion,
  status,
}: {
  readonly motion: boolean;
  readonly status: WorkStatus | null;
}) {
  if (status === null) return null;
  return (
    <box
      id="work-status-line"
      style={{ flexDirection: "row", flexShrink: 1, overflow: "hidden" }}
    >
      <JixuWordmark
        enabled={motion}
        phase={status.phase}
        tone={status.tone}
      />
      <text fg={toneColor(status.tone)}>
        <strong>{status.label}</strong>
      </text>
      {status.detail === undefined ? null : (
        <text fg={jixuTheme.secondary}> · {status.detail}</text>
      )}
    </box>
  );
}

export function ToolOperationTrail({
  toolOperations,
  width,
}: {
  readonly toolOperations: readonly ToolOperation[];
  readonly width: number;
}) {
  const groups = groupToolOperations(toolOperations);
  if (groups.length === 0) return null;
  const maximumGroups = width < 64 ? 1 : width < 96 ? 2 : 3;
  const visibleGroups = groups.slice(-maximumGroups);
  const hiddenCount = groups
    .slice(0, -maximumGroups)
    .reduce((count, group) => count + group.count, 0);
  return (
    <box
      id="tool-operation-trail"
      style={{
        flexDirection: "row",
        flexShrink: 1,
        overflow: "hidden",
      }}
    >
      <text fg={jixuTheme.secondary}>
        <strong>TOOLS</strong>
      </text>
      <text>  </text>
      {hiddenCount === 0 ? null : (
        <text fg={jixuTheme.secondary}>+{hiddenCount} · </text>
      )}
      {visibleGroups.map((group, index) => {
        const presentation = operationPresentation(group.status);
        return (
          <text fg={presentation.color} key={`${group.status}:${group.name}`}>
            {index === 0 ? "" : " · "}
            {presentation.symbol} {group.name}
            {group.count === 1 ? "" : ` ×${group.count}`}
          </text>
        );
      })}
    </box>
  );
}

function PlanDock({
  snapshot,
  width,
}: {
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  const plan = snapshot.activePlan;
  if (plan === null) return null;
  const contentWidth = Math.max(12, width - 6);
  const compacted = plan.steps.length > PLAN_MAX_HEIGHT - 3;
  const visibleSteps = plan.steps.slice(
    0,
    compacted ? PLAN_MAX_HEIGHT - 4 : PLAN_MAX_HEIGHT - 3,
  );
  const hiddenSteps = plan.steps.length - visibleSteps.length;
  const height = 3 + visibleSteps.length + (compacted ? 1 : 0);
  return (
    <box
      backgroundColor={jixuTheme.surface}
      border={["left"]}
      borderColor={jixuTheme.warning}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand}>
        <strong>PLAN</strong>
        <span fg={jixuTheme.secondary}> · r{plan.revision}</span>
      </text>
      <text fg={jixuTheme.text}>{truncate(plan.objective, contentWidth)}</text>
      {visibleSteps.map((step) => {
        const presentation = stepPresentation(step.status);
        return (
          <box key={step.id} style={{ flexDirection: "row", width: "100%" }}>
            <text fg={presentation.color}>{presentation.symbol} </text>
            <text fg={jixuTheme.text}>
              {truncate(step.description, contentWidth - 2)}
            </text>
          </box>
        );
      })}
      {compacted ? (
        <text fg={jixuTheme.secondary}>  + {hiddenSteps} more steps</text>
      ) : null}
      <text fg={jixuTheme.secondary}>
        Next · <span fg={jixuTheme.info}>{truncate(plan.nextAction ?? "—", contentWidth - 7)}</span>
      </text>
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
      <PlanDock snapshot={snapshot} width={width} />
    </box>
  );
}
