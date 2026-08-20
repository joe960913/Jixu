import {
  MouseButton,
  type InputRenderable,
  type MouseEvent as OpenTUIMouseEvent,
  type SubmitEvent,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import type { ExecutableTool } from "@jixu/core";

import {
  DEFAULT_JIXU_TOOL_SETTINGS,
  normalizeJixuBaseUrl,
} from "./config.ts";
import type {
  JixuApi,
  JixuConnectionConfig,
  JixuToolSettings,
} from "./config.ts";
import { jixuTheme } from "./theme.ts";
import { ToolCenter } from "./tui-tool-center.tsx";

export interface JixuInitialConfiguration {
  readonly api?: JixuApi;
  readonly apiKey?: string;
  readonly autoConnect?: boolean;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly tools?: JixuToolSettings;
}

interface SetupProps {
  readonly initial: JixuInitialConfiguration | undefined;
  readonly initialError: string | null;
  readonly onBack: () => void;
  readonly onConnect: (config: JixuConnectionConfig) => Promise<void>;
  readonly toolCatalogue: readonly ExecutableTool[];
  readonly workspace: string;
}

type SetupFocus = 0 | 1 | 2 | 3 | 4;
type SetupStep = 0 | 1 | 2 | 3;

interface EndpointPreset {
  readonly baseUrl: string | null;
  readonly label: string;
}

const ENDPOINT_PRESETS = {
  "anthropic-messages": [
    { baseUrl: "https://api.anthropic.com", label: "Anthropic" },
    { baseUrl: "https://openrouter.ai/api", label: "OpenRouter" },
    {
      baseUrl: "https://api.deepseek.com/anthropic",
      label: "DeepSeek",
    },
    { baseUrl: null, label: "Custom" },
  ],
  "openai-chat-completions": [
    { baseUrl: "https://api.openai.com/v1", label: "OpenAI" },
    { baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter" },
    { baseUrl: "https://api.deepseek.com", label: "DeepSeek" },
    { baseUrl: "https://api.groq.com/openai/v1", label: "Groq" },
    { baseUrl: null, label: "Custom" },
  ],
} satisfies Record<JixuApi, readonly EndpointPreset[]>;

function comparableBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function selectedEndpointPresetIndex(api: JixuApi, baseUrl: string): number {
  const presets = ENDPOINT_PRESETS[api];
  const comparable = comparableBaseUrl(baseUrl);
  const matched = presets.findIndex(
    (preset) =>
      preset.baseUrl !== null && comparableBaseUrl(preset.baseUrl) === comparable,
  );
  return matched === -1 ? presets.length - 1 : matched;
}

function onPrimaryMouseDown(action: () => void) {
  return (event: OpenTUIMouseEvent) => {
    if (event.button === MouseButton.LEFT) action();
  };
}

function truncatePathStart(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(-(maxLength - 1))}`;
}

function LabeledValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <box style={{ flexDirection: "row" }}>
      <text fg={jixuTheme.secondary} selectable={false}>
        <strong>{label}</strong>
      </text>
      <text fg={jixuTheme.text} selectable={false}>{` ${value}`}</text>
    </box>
  );
}

function KeyAction({
  action,
  keyName,
}: {
  readonly action: string;
  readonly keyName: string;
}) {
  return (
    <box style={{ flexDirection: "row" }}>
      <text fg={jixuTheme.info} selectable={false}>
        <strong>{keyName}</strong>
      </text>
      <text fg={jixuTheme.secondary} selectable={false}>{` ${action}`}</text>
    </box>
  );
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
  readonly number: SetupStep;
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
  readonly beforeInput?: ReactNode;
  readonly hint: string;
  readonly inputRef: RefObject<InputRenderable | null>;
  readonly labelActive?: boolean;
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
  beforeInput,
  hint,
  inputRef,
  labelActive,
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
      <FieldLabel
        active={labelActive ?? active}
        hint={hint}
        label={label}
        number={number}
      />
      {beforeInput}
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

function EndpointPresetRow({
  api,
  baseUrl,
  cursor,
  focused,
  onSelect,
}: {
  readonly api: JixuApi;
  readonly baseUrl: string;
  readonly cursor: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
}) {
  const presets = ENDPOINT_PRESETS[api];
  const selected = selectedEndpointPresetIndex(api, baseUrl);

  return (
    <box style={{ flexDirection: "row", gap: 1, height: 1, width: "100%" }}>
      {presets.map((preset, index) => {
        const cursorAtPreset = focused && cursor === index;
        const applied = selected === index;
        return (
          <box
            id={`endpoint-preset-${index + 1}`}
            key={`${api}-${preset.label}`}
            backgroundColor={cursorAtPreset ? jixuTheme.elevated : jixuTheme.surface}
            onMouseDown={onPrimaryMouseDown(() => onSelect(index))}
            style={{ paddingLeft: 1, paddingRight: 1 }}
          >
            <text
              fg={
                cursorAtPreset
                  ? jixuTheme.brand
                  : applied
                    ? jixuTheme.info
                    : jixuTheme.secondary
              }
              selectable={false}
            >
              <strong>{cursorAtPreset ? "›" : applied ? "●" : " "}</strong>
              {` ${index + 1} ${preset.label}`}
            </text>
          </box>
        );
      })}
    </box>
  );
}

export function Setup({
  initial,
  initialError,
  onBack,
  onConnect,
  toolCatalogue,
  workspace,
}: SetupProps) {
  const [api, setApi] = useState<JixuApi>(
    initial?.api ?? "openai-chat-completions",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [tools, setTools] = useState(
    initial?.tools ?? DEFAULT_JIXU_TOOL_SETTINGS,
  );
  const [panel, setPanel] = useState<"connection" | "tools">("connection");
  const [focus, setFocus] = useState<SetupFocus>(0);
  const [presetCursor, setPresetCursor] = useState(() =>
    selectedEndpointPresetIndex(
      initial?.api ?? "openai-chat-completions",
      initial?.baseUrl ?? "",
    ),
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const baseUrlInput = useRef<InputRenderable>(null);
  const apiKeyInput = useRef<InputRenderable>(null);
  const modelInput = useRef<InputRenderable>(null);
  const { height, width } = useTerminalDimensions();
  const compact = width < 80;
  const compactHeight = height < 28;
  const wideChrome = width >= 110;
  const workspaceLabel = truncatePathStart(
    workspace,
    Math.max(12, width - 77),
  );

  useEffect(() => {
    if (focus !== 2) baseUrlInput.current?.blur();
    if (focus !== 3) apiKeyInput.current?.blur();
    if (focus !== 4) modelInput.current?.blur();
  }, [focus]);

  const selectApi = (next: JixuApi) => {
    setApi(next);
    setPresetCursor(selectedEndpointPresetIndex(next, baseUrl));
    setError(null);
  };

  const selectApiByPointer = (next: JixuApi) => {
    setFocus(0);
    selectApi(next);
  };

  const selectEndpointPreset = (index: number) => {
    const preset = ENDPOINT_PRESETS[api][index];
    if (preset === undefined) return;
    setPresetCursor(index);
    if (preset.baseUrl !== null) setBaseUrl(preset.baseUrl);
    setError(null);
    setFocus(2);
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
      setFocus(2);
      return;
    }

    if (cleanKey.length === 0) {
      setError("API Key is required.");
      setFocus(3);
      return;
    }
    if (cleanModel.length === 0) {
      setError("Model ID is required.");
      setFocus(4);
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
        tools,
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
    if (panel === "tools") return;
    if (key.name === "escape") {
      key.preventDefault();
      if (!connecting) onBack();
      return;
    }

    if (key.name === "tab") {
      key.preventDefault();
      setFocus((current) => {
        if (key.shift) return current === 0 ? 4 : ((current - 1) as SetupFocus);
        return current === 4 ? 0 : ((current + 1) as SetupFocus);
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

    if (focus === 1) {
      const presets = ENDPOINT_PRESETS[api];
      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down"
      ) {
        key.preventDefault();
        const direction = key.name === "left" || key.name === "up" ? -1 : 1;
        setPresetCursor(
          (current) => (current + direction + presets.length) % presets.length,
        );
        return;
      }

      const numbered = Number(key.sequence);
      if (
        Number.isInteger(numbered) &&
        numbered >= 1 &&
        numbered <= presets.length
      ) {
        key.preventDefault();
        selectEndpointPreset(numbered - 1);
        return;
      }

      if (key.name === "return") {
        key.preventDefault();
        selectEndpointPreset(presetCursor);
      }
      return;
    }

    if (focus === 4 && key.name === "return") {
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
          <text fg={jixuTheme.secondary} selectable={false}>  </text>
          <box
            id="config-connection-tab"
            onMouseDown={onPrimaryMouseDown(() => setPanel("connection"))}
          >
            <text
              fg={panel === "connection" ? jixuTheme.brand : jixuTheme.secondary}
              selectable={false}
            >
              <strong>CONNECTION</strong>
            </text>
          </box>
          <text fg={jixuTheme.secondary} selectable={false}>  </text>
          <box
            id="config-tools-tab"
            onMouseDown={onPrimaryMouseDown(() => setPanel("tools"))}
          >
            <text
              fg={panel === "tools" ? jixuTheme.brand : jixuTheme.secondary}
              selectable={false}
            >
              <strong>TOOLS</strong>
            </text>
          </box>
          <box style={{ flexGrow: 1 }} />
          {wideChrome && (
            <box style={{ flexDirection: "row", gap: 2 }}>
              <LabeledValue
                label="SETTINGS"
                value={wideChrome ? "~/.jixu/settings.json" : "settings.json"}
              />
            </box>
          )}
          {wideChrome && <text selectable={false}>  </text>}
          <box
            id="config-back"
            onMouseDown={onPrimaryMouseDown(() => {
              if (!connecting) onBack();
            })}
          >
            <text
              fg={connecting ? jixuTheme.secondary : jixuTheme.info}
              selectable={false}
            >
              <strong>{wideChrome ? "← BACK TO CHAT" : "← BACK"}</strong>
            </text>
          </box>
        </box>
        <text fg={jixuTheme.divider} selectable={false}>
          {"─".repeat(Math.max(1, width - 2))}
        </text>
      </box>

      {panel === "tools" ? (
        <ToolCenter
          busy={connecting}
          error={error}
          onApply={() => void connect()}
          onBack={() => setPanel("connection")}
          onChange={setTools}
          tools={toolCatalogue}
          value={tools}
        />
      ) : (
        <box
          backgroundColor={jixuTheme.surface}
          borderStyle="single"
          borderColor={jixuTheme.divider}
          title=" Model connection "
          titleColor={jixuTheme.brand}
          style={{
            flexDirection: "column",
            padding: compactHeight ? 0 : 1,
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
        {!compactHeight && (
          <text fg={focus === 0 ? jixuTheme.brand : jixuTheme.secondary} selectable={false}>
            Arrows choose    1/2 select    Enter next    Click select
          </text>
        )}

        <SetupField
          active={focus === 2}
          beforeInput={
            <EndpointPresetRow
              api={api}
              baseUrl={baseUrl}
              cursor={presetCursor}
              focused={focus === 1}
              onSelect={selectEndpointPreset}
            />
          }
          hint={
            focus === 1
              ? `ARROWS CHOOSE  1–${ENDPOINT_PRESETS[api].length} APPLY  ENTER EDIT`
              : api === "openai-chat-completions"
                ? "OPENAI-COMPATIBLE"
                : "ANTHROPIC"
          }
          inputRef={baseUrlInput}
          labelActive={focus === 1 || focus === 2}
          label="BASE URL"
          number={1}
          onFocus={() => setFocus(2)}
          onInput={(value) => {
            setBaseUrl(value);
            setPresetCursor(selectedEndpointPresetIndex(api, value));
          }}
          onSubmit={() => {
            baseUrlInput.current?.blur();
            setFocus(3);
          }}
          placeholder="https://api.example.com/v1"
          value={baseUrl}
        />

        <SetupField
          active={focus === 3}
          hint="SAVED IN SETTINGS.JSON"
          inputRef={apiKeyInput}
          label="API KEY"
          maxLength={8192}
          number={2}
          onFocus={() => setFocus(3)}
          onInput={setApiKey}
          onSubmit={() => {
            apiKeyInput.current?.blur();
            setFocus(4);
          }}
          placeholder="Paste or type the endpoint API key"
          value={apiKey}
        />

        <SetupField
          active={focus === 4}
          hint="VENDOR / MODEL"
          inputRef={modelInput}
          label="MODEL ID"
          number={3}
          onFocus={() => setFocus(4)}
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
            {error ??
              (connecting
                ? "Verifying endpoint…"
                : "Tab Next    Shift+Tab Previous    Enter Select")}
          </text>
          <box onMouseDown={onPrimaryMouseDown(() => void connect())}>
            <text fg={connecting ? jixuTheme.warning : jixuTheme.brand} selectable={false}>
              <strong>{connecting ? "CONNECTING…" : "CONNECT  ↵"}</strong>
            </text>
          </box>
        </box>
        </box>
      )}

      <box style={{ flexDirection: "column", height: 2, width: "100%" }}>
        <text fg={jixuTheme.divider} selectable={false}>
          {"─".repeat(Math.max(1, width - 2))}
        </text>
        <box style={{ flexDirection: "row", height: 1, width: "100%" }}>
          <box style={{ flexDirection: "row", gap: 2 }}>
            <KeyAction action="Back" keyName="Esc" />
            {!compact && <KeyAction action="Next" keyName="Tab" />}
            {wideChrome && (
              <KeyAction action="Previous" keyName="Shift+Tab" />
            )}
            {!compact && <KeyAction action="Select" keyName="Enter" />}
          </box>
          <box style={{ flexGrow: 1 }} />
          {wideChrome && (
            <box style={{ flexDirection: "row", gap: 2 }}>
              <LabeledValue label="Workspace" value={workspaceLabel} />
              <KeyAction action="Quit" keyName="Ctrl+C" />
            </box>
          )}
          {!wideChrome && <KeyAction action="Quit" keyName="Ctrl+C" />}
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
