import type { SelectRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { matchingSlashCommands } from "./commands.ts";
import type { JixuSlashCommand } from "./commands.ts";
import { jixuTheme } from "./theme.ts";
import type { ThreadSummary } from "./tui-model.ts";

interface SlashCommandMenuProps {
  readonly draft: string;
  readonly input: RefObject<TextareaRenderable | null>;
  readonly onInsert: (value: string) => void;
  readonly onInvoke: (command: string) => void;
}

function commandLabel(command: JixuSlashCommand): string {
  return `${command.usage.padEnd(28)}${command.description}`;
}

export function SlashCommandMenu({
  draft,
  input,
  onInsert,
  onInvoke,
}: SlashCommandMenuProps) {
  const menu = useRef<SelectRenderable>(null);
  const [dismissed, setDismissed] = useState(false);
  const [menuFocused, setMenuFocused] = useState(false);
  const commands = matchingSlashCommands(draft);
  const open = !dismissed && commands.length > 0;

  useEffect(() => {
    setDismissed(false);
    setMenuFocused(false);
    menu.current?.setSelectedIndex(0);
    input.current?.focus();
  }, [draft, input]);

  const close = useCallback(() => {
    setDismissed(true);
    setMenuFocused(false);
    input.current?.focus();
  }, [input]);

  const accept = useCallback(
    (index: number) => {
      const command = commands[index];
      if (command === undefined) return;

      if (command.requiresArguments) {
        onInsert(`${command.name} `);
      } else {
        onInvoke(command.name);
      }
      close();
    },
    [close, commands, onInsert, onInvoke],
  );

  useKeyboard((key) => {
    if (!open) return;

    if (key.name === "escape") {
      key.preventDefault();
      close();
      return;
    }

    if (menuFocused) return;

    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      input.current?.blur();
      menu.current?.focus();
      if (key.name === "up") menu.current?.moveUp();
      else menu.current?.moveDown();
      setMenuFocused(true);
      return;
    }

    if (key.name === "return") {
      key.preventDefault();
      menu.current?.selectCurrent();
    }
  });

  if (!open) return null;

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border
      borderColor={menuFocused ? jixuTheme.brand : jixuTheme.secondary}
      bottomTitle=" ↑/↓ select · Enter use · Esc close "
      bottomTitleAlignment="right"
      height={commands.length + 2}
      title=" Commands "
      titleColor={jixuTheme.text}
      style={{ flexShrink: 0, width: "100%" }}
    >
      <select
        ref={menu}
        backgroundColor={jixuTheme.surface}
        descriptionColor={jixuTheme.secondary}
        focused={menuFocused}
        focusedBackgroundColor={jixuTheme.surface}
        focusedTextColor={jixuTheme.text}
        height={commands.length}
        id="slash-command-select"
        onKeyDown={(key) => {
          if (key.name !== "escape") return;
          key.preventDefault();
          close();
        }}
        onSelect={(index) => accept(index)}
        options={commands.map((command) => ({
          description: command.description,
          name: commandLabel(command),
          value: command.name,
        }))}
        selectedBackgroundColor={jixuTheme.surface}
        selectedDescriptionColor={jixuTheme.brand}
        selectedTextColor={jixuTheme.brand}
        showDescription={false}
        showScrollIndicator={false}
        showSelectionIndicator
        textColor={jixuTheme.secondary}
        width="100%"
        wrapSelection
      />
    </box>
  );
}

interface ThreadPickerProps {
  readonly input: RefObject<TextareaRenderable | null>;
  readonly onClose: () => void;
  readonly onSelect: (threadId: string) => void;
  readonly open: boolean;
  readonly threads: readonly ThreadSummary[];
}

const THREAD_PICKER_MIN_ROWS = 3;
const THREAD_PICKER_MAX_ROWS = 6;

export function ThreadPicker({
  input,
  onClose,
  onSelect,
  open,
  threads,
}: ThreadPickerProps) {
  const picker = useRef<SelectRenderable>(null);
  const visibleRows = Math.max(
    THREAD_PICKER_MIN_ROWS,
    Math.min(THREAD_PICKER_MAX_ROWS, threads.length),
  );

  useEffect(() => {
    if (!open) return;
    input.current?.blur();
    picker.current?.setSelectedIndex(
      Math.max(0, threads.findIndex((thread) => thread.current)),
    );
    picker.current?.focus();
  }, [input, open, threads]);

  const close = useCallback(() => {
    onClose();
    input.current?.focus();
  }, [input, onClose]);

  if (!open) return null;

  return (
    <box
      backgroundColor={jixuTheme.surface}
      border
      borderColor={jixuTheme.brand}
      bottomTitle=" ↑/↓ select · Enter open · Esc close "
      bottomTitleAlignment="right"
      height={visibleRows + 2}
      title=" Threads "
      titleColor={jixuTheme.text}
      style={{ flexShrink: 0, width: "100%" }}
    >
      <select
        ref={picker}
        backgroundColor={jixuTheme.surface}
        focused
        focusedBackgroundColor={jixuTheme.surface}
        focusedTextColor={jixuTheme.text}
        height={visibleRows}
        id="thread-select"
        onKeyDown={(key) => {
          if (key.name !== "escape") return;
          key.preventDefault();
          close();
        }}
        onSelect={(index) => {
          const thread = threads[index];
          if (thread === undefined) return;
          onSelect(thread.id);
          close();
        }}
        options={threads.map((thread) => ({
          description: thread.status,
          name: `${thread.current ? "●" : "○"} ${thread.title}`,
          value: thread.id,
        }))}
        selectedBackgroundColor={jixuTheme.surface}
        selectedDescriptionColor={jixuTheme.brand}
        selectedTextColor={jixuTheme.brand}
        showDescription
        showScrollIndicator={threads.length > THREAD_PICKER_MAX_ROWS}
        showSelectionIndicator
        textColor={jixuTheme.secondary}
        width="100%"
        wrapSelection
      />
    </box>
  );
}
