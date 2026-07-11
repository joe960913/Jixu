/**
 * Portable one-cell semantic glyphs for the reference TUI.
 *
 * OpenTUI status and Tool rows are text rows. A glyph occupies one terminal
 * cell inside a two-column gutter; the adjacent label remains the semantic
 * authority. No image, custom drawing surface, font probing, or graphics
 * protocol participates in layout.
 */

import type { ReactNode } from "react";

import { jixuTheme } from "./theme.ts";
import type { JixuTone } from "./tui-model.ts";

export type JixuIconName =
  | "attention"
  | "autonomy"
  | "direct"
  | "edit"
  | "paused"
  | "plan"
  | "read"
  | "responding"
  | "search"
  | "terminal"
  | "thinking"
  | "tool"
  | "verified"
  | "web";

const glyphs: Readonly<Record<JixuIconName, string>> = Object.freeze({
  attention: "!",
  autonomy: "○",
  direct: "•",
  edit: "←",
  paused: "‖",
  plan: "≡",
  read: "→",
  responding: "•",
  search: "✱",
  terminal: "$",
  thinking: "…",
  tool: "⚙",
  verified: "✓",
  web: "◈",
});

const defaultTones: Readonly<Record<JixuIconName, JixuTone>> = Object.freeze({
  attention: "warning",
  autonomy: "success",
  direct: "info",
  edit: "info",
  paused: "warning",
  plan: "warning",
  read: "info",
  responding: "info",
  search: "info",
  terminal: "info",
  thinking: "warning",
  tool: "warning",
  verified: "success",
  web: "info",
});

export function JixuIcon({
  id,
  name,
  tone = defaultTones[name],
}: {
  readonly id?: string;
  readonly name: JixuIconName;
  readonly tone?: JixuTone;
}): ReactNode {
  return (
    <text
      {...(id === undefined ? {} : { id })}
      fg={jixuTheme[tone]}
      style={{ flexShrink: 0, height: 1, width: 2 }}
    >
      {glyphs[name]}
    </text>
  );
}

export function iconForTool(name: string): JixuIconName {
  const normalized = name.toLowerCase();
  if (/read|view|inspect|list|cat|search|web|network/u.test(normalized)) return "read";
  if (/edit|write|patch|create|update/u.test(normalized)) return "edit";
  if (/search|find|grep|rg/u.test(normalized)) return "search";
  if (/web|browser|fetch|http|url/u.test(normalized)) return "web";
  if (/shell|terminal|exec|command|test|build|lint/u.test(normalized)) {
    return "terminal";
  }
  return "tool";
}
