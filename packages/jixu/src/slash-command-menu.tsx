import type { SelectRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ThreadMode } from "jixu-core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { matchingSlashCommands } from "./commands.ts";
import type {
  JixuSlashCommand,
  JixuSlashCommandChoice,
} from "./commands.ts";
import { jixuTheme } from "./theme.ts";
import type { ThreadSummary } from "./tui-model.ts";

interface SlashCommandMenuProps {
  readonly draft: string;
  readonly input: RefObject<TextareaRenderable | null>;
  readonly mode: ThreadMode;
  readonly onInsert: (value: string) => void;
  readonly onInvoke: (command: string) => Promise<void> | void;
  readonly onModePreview: (mode: ThreadMode | null) => void;
}

function commandLabel(command: JixuSlashCommand): string {
  const invocation = command.choices === undefined
    ? command.usage
    : command.name;
  return `${invocation.padEnd(28)}${command.description}`;
}

function choiceLabel(
  choice: JixuSlashCommandChoice,
  mode: ThreadMode,
): string {
  const current = choice.value === mode ? "  CURRENT" : "";
  return `${choice.label.padEnd(12)}${choice.description}${current}`;
}

function choiceMode(
  choice: JixuSlashCommandChoice | undefined,
): ThreadMode | null {
  return choice?.value === "standard" || choice?.value === "ultra"
    ? choice.value
    : null;
}

export function SlashCommandMenu({
  draft,
  input,
  mode,
  onInsert,
  onInvoke,
  onModePreview,
}: SlashCommandMenuProps) {
  const menu = useRef<SelectRenderable>(null);
  const modeApplyPending = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [menuFocused, setMenuFocused] = useState(false);
  const [choiceCommand, setChoiceCommand] = useState<JixuSlashCommand | null>(
    null,
  );
  const commands = matchingSlashCommands(draft);
  const choices = choiceCommand?.choices ?? [];
  const open =
    !dismissed && (choiceCommand !== null || commands.length > 0);

  useEffect(() => {
    setDismissed(false);
    setMenuFocused(false);
    setChoiceCommand(null);
    menu.current?.setSelectedIndex(0);
    if (!modeApplyPending.current) onModePreview(null);
    input.current?.focus();
  }, [draft, input, onModePreview]);

  const close = useCallback((resetModePreview = true) => {
    setDismissed(true);
    setMenuFocused(false);
    setChoiceCommand(null);
    if (resetModePreview) onModePreview(null);
    input.current?.focus();
  }, [input, onModePreview]);

  const back = useCallback(() => {
    setChoiceCommand(null);
    setMenuFocused(true);
    menu.current?.setSelectedIndex(0);
    onModePreview(null);
    menu.current?.focus();
  }, [onModePreview]);

  useEffect(() => {
    if (choiceCommand === null) return;
    const currentIndex = choices.findIndex((choice) => choice.value === mode);
    input.current?.blur();
    menu.current?.setSelectedIndex(Math.max(0, currentIndex));
    menu.current?.focus();
    setMenuFocused(true);
  }, [choiceCommand, choices, input, mode]);

  const accept = useCallback(
    (index: number) => {
      if (choiceCommand !== null) {
        const choice = choices[index];
        if (choice === undefined) return;
        modeApplyPending.current = true;
        onModePreview(choiceMode(choice));
        const result = onInvoke(`${choiceCommand.name} ${choice.value}`);
        close(false);
        void Promise.resolve(result).finally(() => {
          modeApplyPending.current = false;
          onModePreview(null);
        });
        return;
      }
      const command = commands[index];
      if (command === undefined) return;

      if (command.choices !== undefined) {
        setChoiceCommand(command);
      } else if (command.requiresArguments) {
        onInsert(`${command.name} `);
      } else {
        onInvoke(command.name);
      }
      if (command.choices === undefined) close();
    },
    [
      choiceCommand,
      choices,
      close,
      commands,
      onInsert,
      onInvoke,
      onModePreview,
    ],
  );

  useKeyboard((key) => {
    if (!open) return;

    if (key.name === "escape") {
      key.preventDefault();
      if (choiceCommand === null) close();
      else back();
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
      bottomTitle={choiceCommand === null
        ? " ↑/↓ select · Enter use · Esc close "
        : " ↑/↓ select · Enter apply · Esc back "}
      bottomTitleAlignment="right"
      height={(choiceCommand === null ? commands.length : choices.length) + 2}
      title={choiceCommand === null ? " Commands " : " Mode "}
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
        height={choiceCommand === null ? commands.length : choices.length}
        id="slash-command-select"
        onChange={(index) => {
          if (choiceCommand === null) return;
          onModePreview(choiceMode(choices[index]));
        }}
        onKeyDown={(key) => {
          if (key.name !== "escape") return;
          key.preventDefault();
          if (choiceCommand === null) close();
          else back();
        }}
        onSelect={(index) => accept(index)}
        options={(choiceCommand === null
          ? commands.map((command) => ({
              description: command.description,
              name: commandLabel(command),
              value: command.name,
            }))
          : choices.map((choice) => ({
              description: choice.description,
              name: choiceLabel(choice, mode),
              value: choice.value,
            })))}
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
