import { RGBA, SyntaxStyle } from "@opentui/core";

import { jixuTheme } from "./theme.ts";

const color = (value: string): RGBA => RGBA.fromHex(value);
const requiredStyleId = (style: SyntaxStyle, name: string): number => {
  const styleId = style.getStyleId(name);
  if (styleId === null) {
    throw new Error(`Syntax style ${name} is unavailable.`);
  }
  return styleId;
};

export const jixuComposerSyntaxStyle = SyntaxStyle.fromStyles({
  attachment: {
    bg: color(jixuTheme.attachmentBackground),
    bold: true,
    fg: color(jixuTheme.attachmentText),
  },
});

export const composerPastedImageStyleId = requiredStyleId(
  jixuComposerSyntaxStyle,
  "attachment",
);

export const jixuMarkdownSyntaxStyle = SyntaxStyle.fromStyles({
  attribute: { fg: color(jixuTheme.brand) },
  boolean: { fg: color(jixuTheme.warning) },
  character: { fg: color(jixuTheme.success) },
  comment: { fg: color(jixuTheme.secondary), italic: true },
  constant: { fg: color(jixuTheme.warning) },
  constructor: { fg: color(jixuTheme.warning) },
  default: { fg: color(jixuTheme.text) },
  embedded: { fg: color(jixuTheme.text) },
  function: { fg: color(jixuTheme.info) },
  import: { fg: color(jixuTheme.brand) },
  keyword: { bold: true, fg: color(jixuTheme.brand) },
  label: { fg: color(jixuTheme.secondary) },
  conceal: { fg: color(jixuTheme.divider) },
  "markup.heading": { bold: true, fg: color(jixuTheme.brand) },
  "markup.heading.1": { bold: true, fg: color(jixuTheme.brand) },
  "markup.heading.2": { bold: true, fg: color(jixuTheme.info) },
  "markup.heading.3": { bold: true, fg: color(jixuTheme.text) },
  "markup.italic": { fg: color(jixuTheme.text), italic: true },
  "markup.link": { fg: color(jixuTheme.info), underline: true },
  "markup.list": { fg: color(jixuTheme.brand) },
  "markup.list.checked": { bold: true, fg: color(jixuTheme.success) },
  "markup.list.unchecked": { fg: color(jixuTheme.secondary) },
  "markup.quote": { fg: color(jixuTheme.secondary), italic: true },
  "markup.raw": {
    bg: color(jixuTheme.elevated),
    fg: color(jixuTheme.info),
  },
  "markup.raw.block": {
    bg: color(jixuTheme.elevated),
    fg: color(jixuTheme.text),
  },
  "markup.strong": { bold: true, fg: color(jixuTheme.text) },
  module: { fg: color(jixuTheme.info) },
  number: { fg: color(jixuTheme.warning) },
  operator: { fg: color(jixuTheme.brand) },
  property: { fg: color(jixuTheme.info) },
  punctuation: { fg: color(jixuTheme.secondary) },
  string: { fg: color(jixuTheme.success) },
  type: { fg: color(jixuTheme.warning) },
  variable: { fg: color(jixuTheme.text) },
});
