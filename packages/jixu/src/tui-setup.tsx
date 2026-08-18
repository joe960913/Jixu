import type { InputRenderable, SubmitEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

import { normalizeJixuBaseUrl } from "./config.ts";
import type { JixuApiFormat, JixuConnectionConfig } from "./config.ts";
import { jixuTheme } from "./theme.ts";

export interface JixuInitialConfiguration {
  readonly apiFormat?: JixuApiFormat;
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

export function Setup({ initial, initialError, onConnect, workspace }: SetupProps) {
  const [apiFormat, setApiFormat] = useState<JixuApiFormat>(
    initial?.apiFormat ?? "responses",
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

  useEffect(() => {
    if (focus !== 1) baseUrlInput.current?.blur();
    if (focus !== 2) apiKeyInput.current?.blur();
    if (focus !== 3) modelInput.current?.blur();
  }, [focus]);

  const selectApiFormat = (next: JixuApiFormat) => {
    setApiFormat(next);
    setError(null);
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
        apiFormat,
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
        selectApiFormat(
          apiFormat === "responses" ? "chat-completions" : "responses",
        );
        return;
      }
      if (key.sequence === "1" || key.sequence === "2") {
        key.preventDefault();
        selectApiFormat(
          key.sequence === "1" ? "responses" : "chat-completions",
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
        backgroundColor: jixuTheme.background,
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        padding: 1,
        width: "100%",
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={jixuTheme.brand}>
          <strong>JIXU</strong>
        </text>
        <text fg={jixuTheme.text}>  Agents that continue.</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.secondary}>Setup · saved in ~/.jixu</text>
      </box>

      <box
        border
        borderColor={jixuTheme.secondary}
        title=" Connect a model "
        titleColor={jixuTheme.text}
        style={{
          flexDirection: "column",
          gap: 0,
          padding: 1,
          width: width >= 76 ? 72 : "100%",
        }}
      >
        <text fg={jixuTheme.secondary}>1  API format</text>
        <box style={{ flexDirection: "row", gap: 1, height: 3, width: "100%" }}>
          <box
            border
            borderColor={
              apiFormat === "responses"
                ? focus === 0
                  ? jixuTheme.brand
                  : jixuTheme.info
                : jixuTheme.secondary
            }
            style={{ flexGrow: 1, paddingLeft: 1 }}
          >
            <text
              fg={
                apiFormat === "responses"
                  ? jixuTheme.text
                  : jixuTheme.secondary
              }
            >
              <strong>
                {apiFormat === "responses" ? "●" : "○"} 1 Responses
              </strong>
            </text>
          </box>
          <box
            border
            borderColor={
              apiFormat === "chat-completions"
                ? focus === 0
                  ? jixuTheme.brand
                  : jixuTheme.info
                : jixuTheme.secondary
            }
            style={{ flexGrow: 1, paddingLeft: 1 }}
          >
            <text
              fg={
                apiFormat === "chat-completions"
                  ? jixuTheme.text
                  : jixuTheme.secondary
              }
            >
              <strong>
                {apiFormat === "chat-completions" ? "●" : "○"} 2 Chat
                Completions
              </strong>
            </text>
          </box>
        </box>
        <text fg={focus === 0 ? jixuTheme.brand : jixuTheme.secondary}>
          ←/→ or 1/2 select · Enter continue
        </text>

        <text fg={jixuTheme.secondary}>2  Base URL</text>
        <box
          border
          borderColor={focus === 1 ? jixuTheme.brand : jixuTheme.secondary}
          style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <input
            ref={baseUrlInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 1}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            onInput={setBaseUrl}
            onSubmit={() => {
              baseUrlInput.current?.blur();
              setFocus(2);
            }}
            placeholder="https://api.example.com/v1"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={baseUrl}
          />
        </box>

        <text fg={jixuTheme.secondary}>3  API Key</text>
        <box
          border
          borderColor={focus === 2 ? jixuTheme.brand : jixuTheme.secondary}
          style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <input
            ref={apiKeyInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 2}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            maxLength={8192}
            onInput={setApiKey}
            onSubmit={() => {
              apiKeyInput.current?.blur();
              setFocus(3);
            }}
            placeholder="Paste or type the endpoint API key"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={apiKey}
          />
        </box>

        <text fg={jixuTheme.secondary}>4  Model ID</text>
        <box
          border
          borderColor={focus === 3 ? jixuTheme.brand : jixuTheme.secondary}
          style={{ height: 3, paddingLeft: 1, paddingRight: 1, width: "100%" }}
        >
          <input
            ref={modelInput}
            backgroundColor={jixuTheme.background}
            cursorColor={jixuTheme.brand}
            focused={focus === 3}
            focusedBackgroundColor={jixuTheme.background}
            focusedTextColor={jixuTheme.text}
            onInput={setModel}
            onSubmit={submitModel}
            placeholder="e.g. vendor/model-name"
            placeholderColor={jixuTheme.secondary}
            textColor={jixuTheme.text}
            value={model}
          />
        </box>

        <box style={{ flexDirection: "row", width: "100%" }}>
          <text fg={error === null ? jixuTheme.secondary : jixuTheme.danger}>
            {error ??
              (connecting
                ? "Connecting…"
                : "Tab move · Enter continue / connect")}
          </text>
          <box style={{ flexGrow: 1 }} />
          <text fg={jixuTheme.brand}>
            <strong>{connecting ? "CONNECTING" : "ENTER TO CONNECT"}</strong>
          </text>
        </box>
      </box>

      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={jixuTheme.secondary}>Compatible endpoint</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={jixuTheme.secondary}>Ctrl+C quit · {workspace}</text>
      </box>
    </box>
  );
}

export function Booting({ workspace }: { readonly workspace: string }) {
  return (
    <box
      style={{
        alignItems: "center",
        backgroundColor: jixuTheme.background,
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <text fg={jixuTheme.brand}>
        <strong>JIXU</strong>
      </text>
      <text fg={jixuTheme.text}>Loading saved endpoint configuration…</text>
      <text fg={jixuTheme.secondary}>{workspace}</text>
    </box>
  );
}
