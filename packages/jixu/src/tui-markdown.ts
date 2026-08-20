import {
  type BaseRenderable,
  BoxRenderable,
  CodeRenderable,
  createTextAttributes,
  infoStringToFiletype,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  type CliRenderer,
  type MarkdownOptions,
  type RenderNodeContext,
  type TextChunk,
} from "@opentui/core";

import { jixuTheme } from "./theme.ts";

export const CODE_BLOCK_MAX_CONTENT_HEIGHT = 12;

const HTML_FENCE_LANGUAGES = new Set(["htm", "html"]);
const JSON_FENCE_LANGUAGES = new Set(["json", "jsonc"]);

interface ListItemToken {
  readonly checked?: boolean;
  readonly task?: boolean;
  readonly tokens: readonly ListChildToken[];
}

interface ListChildToken {
  readonly items?: readonly ListItemToken[];
  readonly type: string;
}

interface ListToken {
  readonly items: readonly ListItemToken[];
  readonly type: "list";
}

function normalizedFenceLanguage(infoString: string): string {
  return (
    infoString
      .trim()
      .split(/\s+/u, 1)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9+#._-]/gu, "") ?? ""
  );
}

function containsTaskItem(token: ListToken): boolean {
  return token.items.some(
    (item) =>
      item.task === true ||
      item.tokens.some(
        (child) =>
          child.type === "list" &&
          child.items !== undefined &&
          containsTaskItem(child as ListToken),
      ),
  );
}

function codeLineCount(content: string): number {
  return Math.max(1, content.split("\n").length);
}

export function jixuCodeFiletype(infoString: string): string | undefined {
  const language = normalizedFenceLanguage(infoString);
  if (HTML_FENCE_LANGUAGES.has(language)) return "typescriptreact";
  if (JSON_FENCE_LANGUAGES.has(language)) return "javascript";
  return language === "" ? undefined : infoStringToFiletype(language);
}

export function jixuCodeLabel(infoString: string): string {
  const language = normalizedFenceLanguage(infoString).toUpperCase();
  return language === "" ? "CODE" : language.slice(0, 24);
}

function markerChunk(
  text: string,
  group: "markup.list.checked" | "markup.list.unchecked",
  context: RenderNodeContext,
): TextChunk {
  const style =
    context.syntaxStyle.getStyle(group) ??
    context.syntaxStyle.getStyle("markup.list") ??
    context.syntaxStyle.getStyle("default");
  return {
    __isChunk: true,
    text,
    ...(style?.fg === undefined ? {} : { fg: style.fg }),
    ...(style?.bg === undefined ? {} : { bg: style.bg }),
    attributes: createTextAttributes({
      bold: style?.bold ?? false,
      dim: style?.dim ?? false,
      italic: style?.italic ?? false,
      underline: style?.underline ?? false,
    }),
  };
}

function patchTaskMarkers(
  renderable: BaseRenderable,
  token: ListToken,
  context: RenderNodeContext,
): void {
  const rows = renderable.getChildren();
  token.items.forEach((item, itemIndex) => {
    const row = rows[itemIndex];
    if (!(row instanceof BoxRenderable)) return;

    const rowChildren = row.getChildren();
    const marker = rowChildren[0];
    if (item.task === true && marker instanceof TextRenderable) {
      const checked = item.checked === true;
      const originalMarker = marker.plainText.trim();
      const orderedPrefix = /^\d+\.$/u.test(originalMarker)
        ? `${originalMarker} `
        : "";
      const markerText = `${orderedPrefix}${checked ? "✓" : "○"} `;
      marker.content = new StyledText([
        markerChunk(
          markerText,
          checked ? "markup.list.checked" : "markup.list.unchecked",
          context,
        ),
      ]);
      marker.width = markerText.length;
    }

    const content = rowChildren[1];
    if (!(content instanceof BoxRenderable)) return;
    const contentChildren = content.getChildren();
    let childIndex = 0;
    for (const childToken of item.tokens) {
      if (childToken.type === "checkbox" || childToken.type === "space") {
        continue;
      }
      const childRenderable = contentChildren[childIndex];
      if (
        childToken.type === "list" &&
        childRenderable !== undefined &&
        childToken.items !== undefined
      ) {
        patchTaskMarkers(
          childRenderable,
          childToken as ListToken,
          context,
        );
      }
      childIndex += 1;
    }
  });
}

function createCodeRenderable(
  renderer: CliRenderer,
  content: string,
  filetype: string | undefined,
  context: RenderNodeContext,
  streaming: boolean,
): CodeRenderable {
  return new CodeRenderable(renderer, {
    bg: jixuTheme.elevated,
    conceal: context.concealCode,
    content,
    drawUnstyledText: true,
    flexShrink: 0,
    height: codeLineCount(content),
    streaming,
    syntaxStyle: context.syntaxStyle,
    width: "100%",
    wrapMode: "none",
    ...(filetype === undefined ? {} : { filetype }),
    ...(context.treeSitterClient === undefined
      ? {}
      : { treeSitterClient: context.treeSitterClient }),
  });
}

function createShortCodeFrame(
  renderer: CliRenderer,
  code: CodeRenderable,
  contentHeight: number,
  label: string,
): BoxRenderable {
  const frame = new BoxRenderable(renderer, {
    backgroundColor: jixuTheme.elevated,
    border: true,
    borderColor: jixuTheme.divider,
    borderStyle: "rounded",
    flexDirection: "column",
    flexShrink: 0,
    height: contentHeight + 2,
    marginBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    title: label,
    titleColor: jixuTheme.info,
    width: "100%",
  });
  frame.add(code);
  return frame;
}

function createScrollableCodeFrame(
  renderer: CliRenderer,
  code: CodeRenderable,
  label: string,
): ScrollBoxRenderable {
  const frame = new ScrollBoxRenderable(renderer, {
    flexShrink: 0,
    height: CODE_BLOCK_MAX_CONTENT_HEIGHT + 2,
    marginBottom: 1,
    rootOptions: {
      backgroundColor: jixuTheme.elevated,
      border: true,
      borderColor: jixuTheme.divider,
      borderStyle: "rounded",
      title: label,
      titleColor: jixuTheme.info,
    },
    scrollY: true,
    scrollbarOptions: {
      showArrows: false,
      trackOptions: {
        backgroundColor: jixuTheme.elevated,
        foregroundColor: jixuTheme.secondary,
      },
    },
    viewportOptions: { backgroundColor: jixuTheme.elevated },
    contentOptions: {
      backgroundColor: jixuTheme.elevated,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    },
    width: "100%",
  });
  frame.add(code);
  return frame;
}

export function createJixuMarkdownNodeRenderer(
  renderer: CliRenderer,
  streaming: boolean,
): NonNullable<MarkdownOptions["renderNode"]> {
  return (token, context) => {
    if (token.type === "list" && containsTaskItem(token as ListToken)) {
      const renderable = context.defaultRender();
      if (renderable !== null) {
        patchTaskMarkers(renderable, token as ListToken, context);
      }
      return renderable;
    }

    if (token.type !== "code") return undefined;

    const contentHeight = codeLineCount(token.text);
    const label = jixuCodeLabel(token.lang ?? "");
    const code = createCodeRenderable(
      renderer,
      token.text,
      jixuCodeFiletype(token.lang ?? ""),
      context,
      streaming,
    );
    return contentHeight > CODE_BLOCK_MAX_CONTENT_HEIGHT
      ? createScrollableCodeFrame(renderer, code, label)
      : createShortCodeFrame(renderer, code, contentHeight, label);
  };
}
