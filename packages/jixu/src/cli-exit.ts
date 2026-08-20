import { jixuTheme } from "./theme.ts";

export type JixuExitReason = "interactive" | "interrupt" | "terminate";

const EXIT_WORDMARK_ROWS = Object.freeze([
  "     ██╗██╗██╗  ██╗██╗   ██╗",
  "     ██║██║╚██╗██╔╝██║   ██║",
  "     ██║██║ ╚███╔╝ ██║   ██║",
  "██   ██║██║ ██╔██╗ ██║   ██║",
  "╚█████╔╝██║██╔╝ ██╗╚██████╔╝",
  " ╚════╝ ╚═╝╚═╝  ╚═╝ ╚═════╝",
]);

function ansiForeground(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[38;2;${red};${green};${blue}m`;
}

export function createJixuExitOutput({
  color,
  reason,
  stdoutIsTTY,
}: {
  readonly color: boolean;
  readonly reason: JixuExitReason | null;
  readonly stdoutIsTTY: boolean;
}): string {
  if (
    !stdoutIsTTY ||
    (reason !== "interactive" && reason !== "interrupt")
  ) {
    return "";
  }

  const wordmark = EXIT_WORDMARK_ROWS.join("\n");
  if (!color) return `\n${wordmark}\n`;
  return `\n${ansiForeground(jixuTheme.brand)}${wordmark}\u001B[0m\n`;
}
