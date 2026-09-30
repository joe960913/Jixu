import { MouseButton, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";

import type { JixuSkillSettings } from "./config-skills.ts";
import { jixuTheme } from "./theme.ts";

export function SkillEditor({ initial, onBack, onDone }: {
  readonly initial: JixuSkillSettings;
  readonly onBack: () => void;
  readonly onDone: (skill: JixuSkillSettings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<TextareaRenderable>(null);
  const done = () => {
    try {
      onDone({ ...draft, instructions: body.current?.plainText ?? draft.instructions });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid Skill.");
    }
  };
  useKeyboard(key => {
    if (key.name === "escape") {
      key.preventDefault();
      onBack();
    } else if (key.ctrl && key.name === "s") {
      key.preventDefault();
      done();
    } else if (key.name === "tab") {
      key.preventDefault();
      setFocus(current => (current + (key.shift ? 4 : 1)) % 5);
    } else if (key.name === "return" && focus === 4) {
      key.preventDefault();
      done();
    }
  });
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, width: "100%", minHeight: 0 }}>
      <text style={{ flexShrink: 0 }} fg={jixuTheme.text} selectable={false}><strong>Edit Skill</strong></text>
      <text style={{ flexShrink: 0 }} fg={jixuTheme.secondary} selectable={false}>
        Trusted instructions only. Do not include secrets.
      </text>
      {(["name", "description", "version"] as const).map((field, index) => (
        <box key={field} style={{ flexDirection: "row", height: 2, flexShrink: 0 }}>
          <text style={{ flexShrink: 0 }} fg={focus === index ? jixuTheme.brand : jixuTheme.secondary} width={13} selectable={false}>
            {field.toUpperCase()}
          </text>
          <input
            id={`skill-${field}`}
            focused={focus === index}
            value={draft[field]}
            onMouseDown={event => { if (event.button === MouseButton.LEFT) setFocus(index); }}
            onInput={value => { setError(null); setDraft(current => ({ ...current, [field]: value })); }}
            onSubmit={() => setFocus(index + 1)}
            placeholder={field === "name" ? "e.g. code-review" : field === "version" ? "1" : "When should the Agent use this Skill?"}
            backgroundColor={jixuTheme.elevated}
            focusedBackgroundColor={jixuTheme.elevated}
            textColor={jixuTheme.text}
            focusedTextColor={jixuTheme.text}
            cursorColor={jixuTheme.brand}
            style={{ flexGrow: 1 }}
          />
        </box>
      ))}
      <text style={{ flexShrink: 0 }} fg={focus === 3 ? jixuTheme.brand : jixuTheme.secondary} selectable={false}>
        {`INSTRUCTIONS  ${new TextEncoder().encode(draft.instructions).byteLength} / 16384 bytes`}
      </text>
      <textarea
        ref={body}
        id="skill-instructions"
        focused={focus === 3}
        initialValue={initial.instructions}
        onMouseDown={event => { if (event.button === MouseButton.LEFT) setFocus(3); }}
        onContentChange={() => { setError(null); setDraft(current => ({ ...current, instructions: body.current?.plainText ?? "" })); }}
        backgroundColor={jixuTheme.elevated}
        focusedBackgroundColor={jixuTheme.elevated}
        textColor={jixuTheme.text}
        focusedTextColor={jixuTheme.text}
        cursorColor={jixuTheme.brand}
        placeholder="Write or paste the full Skill instructions. Enter inserts a new line."
        style={{ flexGrow: 1, flexBasis: 0, minHeight: 3, width: "100%" }}
      />
      <text style={{ flexShrink: 0 }} fg={error === null ? jixuTheme.secondary : jixuTheme.danger} selectable={false}>
        {error ?? "Tab Next   Enter New line in body   Ctrl+S Done   Esc Cancel edit"}
      </text>
      <box style={{ flexDirection: "row", gap: 3, flexShrink: 0, height: 1 }}>
        <box id="skill-editor-back" onMouseDown={event => { if (event.button === MouseButton.LEFT) onBack(); }}>
          <text style={{ flexShrink: 0 }} fg={jixuTheme.info} selectable={false}>CANCEL</text>
        </box>
        <box id="skill-editor-done" onMouseDown={event => { if (event.button === MouseButton.LEFT) done(); }}>
          <text style={{ flexShrink: 0 }} fg={focus === 4 ? jixuTheme.text : jixuTheme.brand} selectable={false}><strong>DONE  Ctrl+S</strong></text>
        </box>
        <text style={{ flexShrink: 0 }} fg={jixuTheme.secondary} selectable={false}>Apply the list to save.</text>
      </box>
    </box>
  );
}
