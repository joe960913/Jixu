import {
  MouseButton,
  type InputRenderable,
  type MouseEvent as OpenTUIMouseEvent,
  type SubmitEvent,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { normalizeJixuBaseUrl } from "./config.ts";
import type { JixuApi, JixuConnectionConfig } from "./config.ts";
import { jixuTheme } from "./theme.ts";

export interface JixuInitialConfiguration {
  readonly api?: JixuApi;
  readonly apiKey?: string;
  readonly autoConnect?: boolean;
  readonly baseUrl?: string;
  readonly model?: string;
}

interface SetupProps {
  readonly initial: JixuInitialConfiguration | undefined;
  readonly initialError: string | null;
  readonly onConnect: (config: JixuConnectionConfig) => Promise<void>;
  readonly workspace: string;
}

type SetupFocus = 0 | 1 | 2 | 3;

function onPrimaryMouseDown(action: () => void) {
  return (event: OpenTUIMouseEvent) => {
    if (event.button === MouseButton.LEFT) action();
  };
}

function FieldLabel({
  active,
  hint,
  label,
  number,
}: {
  readonly active: boolean;
  readonly hint: string;
  readonly label: string;
  readonly number: SetupFocus;
}) {
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        width: "100%",
      }}
    >
      <text fg={active ? jixuTheme.text : jixuTheme.secondary} selectable={false}>
        <span fg={active ? jixuTheme.brand : jixuTheme.secondary}>
          <strong>0{number + 1}</strong>
        </span>
        {`  ${label}`}
      </text>
      <text fg={active ? jixuTheme.info : jixuTheme.secondary} selectable={false}>
        {hint}
      </text>
    </box>
  );
}

function FormatOption({
  focused,
  label,
  number,
  onSelect,
  selected,
}: {
  readonly focused: boolean;
  readonly label: string;
  readonly number: 1 | 2;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) {
  return (
    <box
      backgroundColor={selected ? jixuTheme.elevated : jixuTheme.background}
      border
      borderColor={
        selected
          ? focused
            ? jixuTheme.brand
            : jixuTheme.info
          : jixuTheme.secondary
      }
      onMouseDown={onPrimaryMouseDown(onSelect)}
      style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
    >
      <text fg={selected ? jixuTheme.text : jixuTheme.secondary} selectable={false}>
        <strong>{selected ? "●" : "○"}</strong>
        {`  ${number}  ${label}`}
      </text>
    </box>
  );
}

interface SetupFieldProps {
  readonly active: boolean;
  readonly hint: string;
  readonly inputRef: RefObject<InputRenderable | null>;
  readonly label: string;
  readonly maxLength?: number;
  readonly number: 1 | 2 | 3;
  readonly onFocus: () => void;
  readonly onInput: (value: string) => void;
  readonly onSubmit: (event: string | SubmitEvent) => void;
  readonly placeholder: string;
  readonly value: string;
}

function SetupField({
  active,
  hint,
  inputRef,
  label,
  maxLength,
  number,
  onFocus,
  onInput,
  onSubmit,
  placeholder,
  value,
}: SetupFieldProps) {
  return (
    <>
      <FieldLabel active={active} hint={hint} label={label} number={number} />
      <box
        backgroundColor={jixuTheme.surface}
        border
        borderColor={active ? jixuTheme.brand : jixuTheme.secondary}
        onMouseDown={onPrimaryMouseDown(onFocus)}
        style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
      >
        <input
          ref={inputRef}
          backgroundColor={jixuTheme.surface}
          cursorColor={jixuTheme.brand}
          focused={active}
          focusedBackgroundColor={jixuTheme.surface}
          focusedTextColor={jixuTheme.text}
          {...(maxLength === undefined ? {} : { maxLength })}
          onInput={onInput}
          onSubmit={onSubmit}
          placeholder={placeholder}
          placeholderColor={jixuTheme.secondary}
          textColor={jixuTheme.text}
          value={value}
        />
      </box>
    </>
  );
}

export function Setup({ initial, initialError, onConnect, workspace }: SetupProps) {
  const [api, setApi] = useState<JixuApi>(
    initial?.api ?? "openai-chat-completions",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [focus, setFocus] = useState<SetupFocus>(0);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const baseUrlInput = useRef<InputRenderable>(null);
  const apiKeyInput = useRef<InputRenderable>(null);
  const modelInput = useRef<InputRenderable>(null);
  const { width } = useTerminalDimensions();
  const compact = width < 72;

  useEffect(() => {
    if (focus !== 1) baseUrlInput.current?.blur();
    if (focus !== 2) apiKeyInput.current?.blur();
    if (focus !== 3) modelInput.current?.blur();
  }, [focus]);

  const selectApi = (next: JixuApi) => {
    setApi(next);
    setError(null);
  };

  const selectApiByPointer = (next: JixuApi) => {
    setFocus(0);
    selectApi(next);
  };

  const connect = async () => {
    const cleanKey = apiKey.trim();
    const cleanModel = model.trim();
    let cleanBaseUrl: string;

    try {
      cleanBaseUrl = normalizeJixuBaseUrl(baseUrl);
    } catch (urlError) {
      setError(
        urlError instanceof Error ? urlError.message : "Base URL is invalid.",
      );
      setFocus(1);
      return;
    }

    if (cleanKey.length === 0) {
      setError("API Key is required.");
      setFocus(2);
      return;
    }
    if (cleanModel.length === 0) {
      setError("Model ID is required.");
      setFocus(3);
      return;
    }
    if (connecting) return;

    setConnecting(true);
    setError(null);
    try {
      await onConnect({
        api,
        apiKey: cleanKey,
        baseUrl: cleanBaseUrl,
        model: cleanModel,
      });
    } catch (connectionError) {
      setConnecting(false);
      setError(
        connectionError instanceof Error
          ? connectionError.message
          : "Could not configure the endpoint.",
      );
    }
  };

  useKeyboard((key) => {
    if (key.name === "tab") {
      key.preventDefault();
      setFocus((current) => {
        if (key.shift) return current === 0 ? 3 : ((current - 1) as SetupFocus);
        return current === 3 ? 0 : ((current + 1) as SetupFocus);
      });
      return;
    }

    if (focus === 0) {
      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down"
      ) {
        key.preventDefault();
        selectApi(
          api === "openai-chat-completions"
            ? "anthropic-messages"
            : "openai-chat-completions",
        );
        return;
      }
      if (key.sequence === "1" || key.sequence === "2") {
        key.preventDefault();
        selectApi(
          key.sequence === "1"
            ? "openai-chat-completions"
            : "anthropic-messages",
        );
        return;
      }
      if (key.name === "return") {
        key.preventDefault();
        setFocus(1);
      }
      return;
    }

    if (focus === 3 && key.name === "return") {
      key.preventDefault();
      void connect();
    }
  });

  const submitModel = (_event: string | SubmitEvent) => void connect();

  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.canvas,
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "column", height: 2, width: "100%" }}>
        <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
          <text fg={jixuTheme.brand} selectable={false}>
            <strong>JIXU</strong>
          </text>
          <text fg={jixuTheme.text} selectable={false}>  Configuration</text>
          <box style={{ flexGrow: 1 }} />
          <text fg={jixuTheme.secondary} selectable={false}>
            {compact ? "~/.jixu" : "saved locally · ~/.jixu"}
          </text>
        </box>
        <text fg={jixuTheme.divider} selectable={false}>
          {"─".repeat(Math.max(1, width - 2))}
        </text>
      </box>

      <box
        backgroundColor={jixuTheme.surface}
        borderStyle="single"
        borderColor={jixuTheme.divider}
        title=" Model connection "
        titleColor={jixuTheme.brand}
        style={{
          flexDirection: "column",
          padding: 1,
          width: width >= 80 ? 76 : "100%",
        }}
      >
        <FieldLabel
          active={focus === 0}
          hint="COMPATIBILITY MODE"
          label="API PROTOCOL"
          number={0}
        />
        <box style={{ flexDirection: "row", gap: 1, height: 3, width: "100%" }}>
          <FormatOption
            focused={focus === 0}
            label="OpenAI Chat"
            number={1}
            onSelect={() => selectApiByPointer("openai-chat-completions")}
            selected={api === "openai-chat-completions"}
          />
          <FormatOption
            focused={focus === 0}
            label="Anthropic Messages"
            number={2}
            onSelect={() => selectApiByPointer("anthropic-messages")}
            selected={api === "anthropic-messages"}
          />
        </box>
        <text fg={focus === 0 ? jixuTheme.brand : jixuTheme.secondary} selectable={false}>
          ←/→ or 1/2 choose · click select · Enter next
        </text>

        <SetupField
          active={focus === 1}
          hint={api === "openai-chat-completions" ? "OPENAI-COMPATIBLE" : "ANTHROPIC"}
          inputRef={baseUrlInput}
          label="BASE URL"
          number={1}
          onFocus={() => setFocus(1)}
          onInput={setBaseUrl}
          onSubmit={() => {
            baseUrlInput.current?.blur();
            setFocus(2);
          }}
          placeholder="https://api.example.com/v1"
          value={baseUrl}
        />

        <SetupField
          active={focus === 2}
          hint="SAVED SEPARATELY"
          inputRef={apiKeyInput}
          label="API KEY"
          maxLength={8192}
          number={2}
          onFocus={() => setFocus(2)}
          onInput={setApiKey}
          onSubmit={() => {
            apiKeyInput.current?.blur();
            setFocus(3);
          }}
          placeholder="Paste or type the endpoint API key"
          value={apiKey}
        />

        <SetupField
          active={focus === 3}
          hint="VENDOR / MODEL"
          inputRef={modelInput}
          label="MODEL ID"
          number={3}
          onFocus={() => setFocus(3)}
          onInput={setModel}
          onSubmit={submitModel}
          placeholder="e.g. vendor/model-name"
          value={model}
        />

        <box
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <text fg={error === null ? jixuTheme.secondary : jixuTheme.danger} selectable={false}>
            {error ?? (connecting ? "Verifying endpoint…" : "Tab / Shift+Tab move · Enter advance")}
          </text>
          <box onMouseDown={onPrimaryMouseDown(() => void connect())}>
            <text fg={connecting ? jixuTheme.warning : jixuTheme.brand} selectable={false}>
              <strong>{connecting ? "CONNECTING…" : "CONNECT  ↵"}</strong>
            </text>
          </box>
        </box>
      </box>

      <box style={{ flexDirection: "column", height: 2, width: "100%" }}>
        <text fg={jixuTheme.divider} selectable={false}>
          {"─".repeat(Math.max(1, width - 2))}
        </text>
        <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
          <text fg={jixuTheme.info} selectable={false}>Chat Completions · Anthropic Messages</text>
          <box style={{ flexGrow: 1 }} />
          <text fg={jixuTheme.secondary} selectable={false}>
            {compact ? "Ctrl+C quit" : `Ctrl+C quit · ${workspace}`}
          </text>
        </box>
      </box>
    </box>
  );
}

export function Booting({ workspace }: { readonly workspace: string }) {
  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.canvas,
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand}><strong>JIXU</strong></text>
      <text fg={jixuTheme.text}>Loading saved endpoint configuration…</text>
      <text fg={jixuTheme.secondary}>{workspace}</text>
    </box>
  );
}
