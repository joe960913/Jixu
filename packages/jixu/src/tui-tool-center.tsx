import { MouseButton, type MouseEvent as OpenTUIMouseEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";

import type { ExecutableTool, ToolPermissionEffect } from "jixu-core";

import {
  effectiveJixuToolPermission,
  type JixuToolName,
  type JixuToolPermissionProfile,
  type JixuToolSettings,
} from "./config.ts";
import { jixuTheme } from "./theme.ts";

interface ToolCenterProps {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onApply: () => void;
  readonly onBack: () => void;
  readonly onChange: (settings: JixuToolSettings) => void;
  readonly tools: readonly ExecutableTool[];
  readonly value: JixuToolSettings;
}

const PERMISSION_EFFECTS = ["allow", "ask", "deny"] as const;
const PROFILES = ["balanced", "review", "unrestricted"] as const;

function onPrimaryMouseDown(action: () => void) {
  return (event: OpenTUIMouseEvent) => {
    if (event.button === MouseButton.LEFT) action();
  };
}

function cycle<TValue>(
  values: readonly TValue[],
  value: TValue,
  direction = 1,
): TValue {
  const index = values.indexOf(value);
  return values[(index + direction + values.length) % values.length] ?? value;
}

function withPermission(
  settings: JixuToolSettings,
  action: JixuToolName,
  effect: ToolPermissionEffect,
): JixuToolSettings {
  const remaining = settings.permissions.rules.filter(
    (rule) => !(rule.action === action && rule.resource === "*"),
  );
  const base = {
    ...settings,
    permissions: { ...settings.permissions, rules: remaining },
  };
  const rules =
    effectiveJixuToolPermission(base, action) === effect
      ? remaining
      : [...remaining, { action, effect, resource: "*" }];
  return {
    ...settings,
    permissions: { ...settings.permissions, rules },
  };
}

function permissionTone(effect: ToolPermissionEffect): string {
  switch (effect) {
    case "allow":
      return jixuTheme.success;
    case "ask":
      return jixuTheme.warning;
    case "deny":
      return jixuTheme.danger;
  }
}

function ToolRow({
  focused,
  onCyclePermission,
  onToggle,
  settings,
  tool,
}: {
  readonly focused: boolean;
  readonly onCyclePermission: () => void;
  readonly onToggle: () => void;
  readonly settings: JixuToolSettings;
  readonly tool: ExecutableTool;
}) {
  const name = tool.descriptor.name as JixuToolName;
  const enabled = settings.enabled.includes(name);
  const effect = effectiveJixuToolPermission(settings, name);
  const boundary =
    name === "web_search"
      ? settings.webSearch.apiKey === undefined
        ? "Jina key missing"
        : "Jina configured"
      : name === "bash"
      ? "process access"
      : settings.fileScope === "workspace"
        ? "workspace only"
        : "process access";

  return (
    <box
      backgroundColor={focused ? jixuTheme.elevated : jixuTheme.surface}
      onMouseDown={onPrimaryMouseDown(onCyclePermission)}
      style={{ flexDirection: "row", height: 2, paddingLeft: 1, paddingRight: 1 }}
    >
      <box
        onMouseDown={onPrimaryMouseDown(onToggle)}
        style={{ width: 9 }}
      >
        <text fg={enabled ? jixuTheme.success : jixuTheme.secondary} selectable={false}>
          <strong>{enabled ? "[ ON ]" : "[OFF ]"}</strong>
        </text>
      </box>
      <text fg={focused ? jixuTheme.text : jixuTheme.info} selectable={false}>
        <strong>{name.padEnd(8)}</strong>
      </text>
      <text fg={jixuTheme.secondary} selectable={false}>
        {`${tool.metadata.origin.padEnd(10)} ${tool.metadata.risk.padEnd(8)} `}
      </text>
      <text fg={permissionTone(effect)} selectable={false}>
        <strong>{effect.toUpperCase().padEnd(6)}</strong>
      </text>
      <text fg={jixuTheme.secondary} selectable={false}>{` ${boundary}`}</text>
    </box>
  );
}

export function ToolCenter({
  busy,
  error,
  onApply,
  onBack,
  onChange,
  tools,
  value,
}: ToolCenterProps) {
  const [focus, setFocus] = useState(0);
  const { width } = useTerminalDimensions();
  const lastFocus = tools.length + 2;

  const setProfile = (profile: JixuToolPermissionProfile) => {
    onChange({
      ...value,
      permissions: { ...value.permissions, profile },
    });
  };

  const toggleTool = (name: JixuToolName) => {
    const enabled = value.enabled.includes(name)
      ? value.enabled.filter((candidate) => candidate !== name)
      : [...value.enabled, name];
    onChange({ ...value, enabled });
  };

  const cyclePermission = (name: JixuToolName, direction = 1) => {
    const current = effectiveJixuToolPermission(value, name);
    onChange(withPermission(value, name, cycle(PERMISSION_EFFECTS, current, direction)));
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      if (!busy) onBack();
      return;
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault();
      if (!busy) onApply();
      return;
    }
    if (key.name === "up" || key.name === "down" || key.name === "tab") {
      key.preventDefault();
      const direction = key.name === "up" || key.shift ? -1 : 1;
      setFocus((current) =>
        (current + direction + lastFocus + 1) % (lastFocus + 1),
      );
      return;
    }
    const direction = key.name === "left" ? -1 : key.name === "right" ? 1 : 0;
    if (direction !== 0) {
      key.preventDefault();
      if (focus === 0) {
        setProfile(cycle(PROFILES, value.permissions.profile, direction));
      } else if (focus === 1) {
        onChange({
          ...value,
          fileScope: value.fileScope === "workspace" ? "process" : "workspace",
        });
      } else if (focus < lastFocus) {
        const tool = tools[focus - 2];
        if (tool !== undefined) {
          cyclePermission(tool.descriptor.name as JixuToolName, direction);
        }
      }
      return;
    }
    if (key.name === "space" && focus >= 2 && focus < lastFocus) {
      key.preventDefault();
      const tool = tools[focus - 2];
      if (tool !== undefined) toggleTool(tool.descriptor.name as JixuToolName);
      return;
    }
    if (key.name !== "return") return;
    key.preventDefault();
    if (focus === 0) {
      setProfile(cycle(PROFILES, value.permissions.profile));
    } else if (focus === 1) {
      onChange({
        ...value,
        fileScope: value.fileScope === "workspace" ? "process" : "workspace",
      });
    } else if (focus === lastFocus) {
      if (!busy) onApply();
    } else {
      const tool = tools[focus - 2];
      if (tool !== undefined) cyclePermission(tool.descriptor.name as JixuToolName);
    }
  });

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border
      borderColor={jixuTheme.divider}
      title=" Tool Center "
      titleColor={jixuTheme.brand}
      style={{
        flexDirection: "column",
        padding: width < 90 ? 0 : 1,
        width: width >= 90 ? 86 : "100%",
      }}
    >
      <text fg={jixuTheme.secondary} selectable={false}>
        Enabled Tools are exposed to the model. Permission rules are checked before dispatch.
      </text>
      <box
        backgroundColor={focus === 0 ? jixuTheme.elevated : jixuTheme.surface}
        onMouseDown={onPrimaryMouseDown(() => {
          setFocus(0);
          setProfile(cycle(PROFILES, value.permissions.profile));
        })}
        style={{ flexDirection: "row", height: 2, paddingLeft: 1, paddingRight: 1 }}
      >
        <text fg={jixuTheme.text} selectable={false}><strong>PROFILE</strong></text>
        <text fg={jixuTheme.warning} selectable={false}>{`  ${value.permissions.profile.toUpperCase()}`}</text>
        <text fg={jixuTheme.secondary} selectable={false}>
          {"  defaults for Tools without a later rule"}
        </text>
      </box>
      <box
        backgroundColor={focus === 1 ? jixuTheme.elevated : jixuTheme.surface}
        onMouseDown={onPrimaryMouseDown(() => {
          setFocus(1);
          onChange({
            ...value,
            fileScope: value.fileScope === "workspace" ? "process" : "workspace",
          });
        })}
        style={{ flexDirection: "row", height: 2, paddingLeft: 1, paddingRight: 1 }}
      >
        <text fg={jixuTheme.text} selectable={false}><strong>FILE SCOPE</strong></text>
        <text fg={value.fileScope === "workspace" ? jixuTheme.success : jixuTheme.danger} selectable={false}>
          {`  ${value.fileScope.toUpperCase()}`}
        </text>
        <text fg={jixuTheme.secondary} selectable={false}>
          {value.fileScope === "workspace"
            ? "  read/write/edit stay inside the workspace"
            : "  file Tools inherit process filesystem access"}
        </text>
      </box>

      <box style={{ flexDirection: "row", height: 1, paddingLeft: 1 }}>
        <text fg={jixuTheme.secondary} selectable={false}>
          {"STATE    TOOL     ORIGIN     RISK     POLICY  BOUNDARY"}
        </text>
      </box>
      {tools.map((tool, index) => (
        <ToolRow
          key={tool.descriptor.name}
          focused={focus === index + 2}
          onCyclePermission={() => {
            setFocus(index + 2);
            cyclePermission(tool.descriptor.name as JixuToolName);
          }}
          onToggle={() => {
            setFocus(index + 2);
            toggleTool(tool.descriptor.name as JixuToolName);
          }}
          settings={value}
          tool={tool}
        />
      ))}

      <text fg={jixuTheme.warning} selectable={false}>
        bash is not OS-sandboxed. ALLOW/ASK/DENY controls dispatch, not process reach.
      </text>
      {value.webSearch.apiKey === undefined && (
        <text fg={jixuTheme.info} selectable={false}>
          Add tools.webSearch.apiKey to ~/.jixu/settings.json, restart, then create a Thread.
        </text>
      )}
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={error === null ? jixuTheme.secondary : jixuTheme.danger} selectable={false}>
          {error ?? "Arrows Move/Change    Space Enable    Enter Change    Esc Connection"}
        </text>
        <box
          backgroundColor={focus === lastFocus ? jixuTheme.elevated : jixuTheme.surface}
          onMouseDown={onPrimaryMouseDown(() => {
            setFocus(lastFocus);
            if (!busy) onApply();
          })}
        >
          <text fg={busy ? jixuTheme.warning : jixuTheme.brand} selectable={false}>
            <strong>{busy ? "APPLYING…" : "APPLY  Ctrl+S"}</strong>
          </text>
        </box>
      </box>
    </box>
  );
}
