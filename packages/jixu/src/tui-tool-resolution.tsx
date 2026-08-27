import { MouseButton, type MouseEvent as OpenTUIMouseEvent } from "@opentui/core";

import type { ToolOutcomeResolutionDecision } from "jixu-core";

import type { ThreadController } from "./thread-controller.ts";
import { jixuTheme } from "./theme.ts";
import type { ThreadControllerSnapshot } from "./tui-model.ts";

function onPrimaryMouseDown(action: () => void | Promise<void>) {
  return async (event: OpenTUIMouseEvent) => {
    if (event.button === MouseButton.LEFT) await action();
  };
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function resolutionAction(
  controller: ThreadController | null,
  resolution: ToolOutcomeResolutionDecision,
): () => Promise<void> {
  return () => controller?.resolveToolOutcome(resolution) ?? Promise.resolve();
}

export function ToolOutcomeResolutionPrompt({
  controller,
  snapshot,
  width,
}: {
  readonly controller: ThreadController | null;
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  const pending = snapshot.toolOutcomeResolution;
  if (pending === null) return null;
  const detail = `${pending.name} · ${pending.toolCallId} · unknown · ${pending.position}/${pending.total} · ${pending.errorCode}`;

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border={["left", "right", "top", "bottom"]}
      borderColor={jixuTheme.warning}
      id="tool-outcome-resolution"
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 3,
        paddingLeft: 1,
        paddingRight: 1,
        width,
      }}
    >
      <text fg={jixuTheme.warning} selectable={false}>
        <strong>OUTCOME</strong>
      </text>
      <text fg={jixuTheme.text} selectable={false}>
        {`  ${truncate(detail, Math.max(16, width - 66))}`}
      </text>
      <box style={{ flexGrow: 1 }} />
      <box
        id="tool-outcome-occurred"
        onMouseDown={onPrimaryMouseDown(
          resolutionAction(controller, "occurred"),
        )}
      >
        <text fg={jixuTheme.success} selectable={false}>
          <strong>OCCURRED</strong>
        </text>
      </box>
      <text fg={jixuTheme.secondary} selectable={false}>  </text>
      <box
        id="tool-outcome-not-occurred"
        onMouseDown={onPrimaryMouseDown(
          resolutionAction(controller, "not_occurred"),
        )}
      >
        <text fg={jixuTheme.brand} selectable={false}>
          <strong>NOT OCCURRED</strong>
        </text>
      </box>
      <text fg={jixuTheme.secondary} selectable={false}>  </text>
      <box
        id="tool-outcome-abandon"
        onMouseDown={onPrimaryMouseDown(
          resolutionAction(controller, "abandoned_unknown"),
        )}
      >
        <text fg={jixuTheme.warning} selectable={false}>
          <strong>ABANDON UNKNOWN</strong>
        </text>
      </box>
    </box>
  );
}
