import { MouseButton, type MouseEvent as OpenTUIMouseEvent } from "@opentui/core";

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

export function ToolApprovalPrompt({
  controller,
  snapshot,
  width,
}: {
  readonly controller: ThreadController | null;
  readonly snapshot: ThreadControllerSnapshot;
  readonly width: number;
}) {
  const approval = snapshot.toolApproval;
  if (approval === null) return null;
  const resources = approval.resources.join(", ");
  const detail = `${approval.name} requests ${approval.action} on ${resources}`;

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border={["left", "right", "top", "bottom"]}
      borderColor={jixuTheme.warning}
      id="tool-approval"
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
        <strong>APPROVAL</strong>
      </text>
      <text fg={jixuTheme.text} selectable={false}>
        {`  ${truncate(detail, Math.max(16, width - 45))}`}
      </text>
      <box style={{ flexGrow: 1 }} />
      <box
        id="tool-approval-allow"
        onMouseDown={onPrimaryMouseDown(
          () => controller?.decideToolApproval("allow_once") ?? Promise.resolve(),
        )}
      >
        <text fg={jixuTheme.success} selectable={false}>
          <strong>ALLOW ONCE</strong>
        </text>
      </box>
      <text fg={jixuTheme.secondary} selectable={false}>  </text>
      <box
        id="tool-approval-deny"
        onMouseDown={onPrimaryMouseDown(
          () => controller?.decideToolApproval("deny") ?? Promise.resolve(),
        )}
      >
        <text fg={jixuTheme.danger} selectable={false}>
          <strong>DENY</strong>
        </text>
      </box>
    </box>
  );
}
