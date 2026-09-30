import { MouseButton, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import { parseJixuSkills, type JixuSkillSettings } from "./config-skills.ts";
import { jixuTheme } from "./theme.ts";
import { SkillEditor } from "./tui-skill-editor.tsx";

export function SkillCenter({ busy, error, onApply, onBack, onChange, value }: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onApply: () => void;
  readonly onBack: () => void;
  readonly onChange: (skills: readonly JixuSkillSettings[]) => void;
  readonly value: readonly JixuSkillSettings[];
}) {
  const [selected, setSelected] = useState(0);
  const [editor, setEditor] = useState<{ index: number; initial: JixuSkillSettings } | null>(null);
  const list = useRef<ScrollBoxRenderable>(null);
  const current = value[selected];
  useEffect(() => { list.current?.scrollChildIntoView(`skill-row-${selected}`); }, [selected]);
  const add = () => {
    if (busy || value.length >= 16) return;
    setEditor({ index: value.length, initial: { name: "", description: "", version: "1", instructions: "", enabled: true } });
  };
  const edit = () => {
    if (!busy && current !== undefined) setEditor({ index: selected, initial: current });
  };
  const toggle = () => {
    if (!busy) onChange(value.map((item, index) => index === selected ? { ...item, enabled: !item.enabled } : item));
  };
  const remove = () => {
    if (busy) return;
    onChange(value.filter((_, index) => index !== selected));
    setSelected(Math.max(0, selected - 1));
  };
  useKeyboard(key => {
    if (editor !== null || busy) return;
    if (key.name === "escape") { key.preventDefault(); onBack(); }
    else if (key.ctrl && key.name === "s") { key.preventDefault(); onApply(); }
    else if (key.ctrl && key.name === "n") { key.preventDefault(); add(); }
    else if (key.name === "return") { key.preventDefault(); edit(); }
    else if (key.name === "space") { key.preventDefault(); toggle(); }
    else if (key.ctrl && key.name === "d") { key.preventDefault(); remove(); }
    else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelected(index => Math.max(0, Math.min(value.length - 1, index + (key.name === "up" ? -1 : 1))));
    }
  });

  const actions = [
    { id: "new", label: "NEW Ctrl+N", action: add },
    { id: "edit", label: "EDIT Enter", action: edit },
    { id: "toggle", label: "ON/OFF Space", action: toggle },
    { id: "remove", label: "REMOVE Ctrl+D", action: remove },
  ];
  return (
    <box border borderColor={jixuTheme.divider} title=" Skills " titleColor={jixuTheme.brand}
      backgroundColor={jixuTheme.surface}
      style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minHeight: 0, width: "100%", maxWidth: 96, paddingLeft: 1, paddingRight: 1 }}>
      {editor !== null ? (
        <SkillEditor initial={editor.initial} onBack={() => setEditor(null)} onDone={skill => {
          const next = [...value];
          next[editor.index] = skill;
          onChange(parseJixuSkills(next));
          setSelected(editor.index);
          setEditor(null);
        }} />
      ) : (
        <>
          <text style={{ flexShrink: 0 }} fg={jixuTheme.secondary} selectable={false}>
            {`LOCAL SETTINGS  ${value.length}/16 Skills   ${value.filter(item => item.enabled).length} enabled`}
          </text>
          <text style={{ flexShrink: 0 }} fg={jixuTheme.secondary} selectable={false}>
            ON makes a Skill available. The Agent loads its body when needed.
          </text>
          <scrollbox ref={list} id="skill-list" scrollX={false} scrollY
            style={{ flexGrow: 1, flexBasis: 0, minHeight: 2, width: "100%" }}>
            {value.length === 0 && <text style={{ flexShrink: 0 }} fg={jixuTheme.secondary} selectable={false}>No Skills yet. Choose NEW to add one.</text>}
            {value.map((skill, index) => (
              <box key={skill.name} id={`skill-row-${index}`}
                backgroundColor={selected === index ? jixuTheme.elevated : jixuTheme.surface}
                onMouseDown={event => { if (event.button === MouseButton.LEFT && !busy) setSelected(index); }}
                style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
                <text style={{ flexShrink: 0 }} fg={skill.enabled ? jixuTheme.success : jixuTheme.secondary} selectable={false}>
                  {`${selected === index ? "›" : " "} ${skill.enabled ? "ON " : "OFF"}  ${skill.name}  v${skill.version}`}
                </text>
              </box>
            ))}
          </scrollbox>
          <text style={{ flexShrink: 0, maxHeight: 3 }} fg={jixuTheme.text} selectable={false}>{current?.description ?? ""}</text>
          <box style={{ flexDirection: "row", gap: 2, flexShrink: 0, height: 1 }}>
            {actions.map(action => (
              <box id={`skill-${action.id}`} key={action.id} onMouseDown={event => { if (event.button === MouseButton.LEFT) action.action(); }}>
                <text style={{ flexShrink: 0 }} fg={busy ? jixuTheme.secondary : jixuTheme.info} selectable={false}>{action.label}</text>
              </box>
            ))}
          </box>
          <text style={{ flexShrink: 0 }} fg={jixuTheme.warning} selectable={false}>
            Apply starts a fresh workspace. Old Threads require their original Skills.
          </text>
          <text style={{ flexShrink: 0 }} fg={error === null ? jixuTheme.secondary : jixuTheme.danger} selectable={false}>
            {error ?? "Changes are drafts until Apply. Back to chat discards all drafts."}
          </text>
          <box style={{ flexDirection: "row", justifyContent: "space-between", flexShrink: 0, height: 1 }}>
            <box id="skill-back" onMouseDown={event => { if (event.button === MouseButton.LEFT && !busy) onBack(); }}>
              <text style={{ flexShrink: 0 }} fg={jixuTheme.info} selectable={false}>CONNECTION Esc</text>
            </box>
            <box id="skill-apply" onMouseDown={event => { if (event.button === MouseButton.LEFT && !busy) onApply(); }}>
              <text style={{ flexShrink: 0 }} fg={jixuTheme.brand} selectable={false}><strong>{busy ? "APPLYING…" : "APPLY Ctrl+S"}</strong></text>
            </box>
          </box>
        </>
      )}
    </box>
  );
}
