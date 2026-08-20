export interface JixuSlashCommand {
  readonly description: string;
  readonly name: `/${string}`;
  readonly requiresArguments: boolean;
  readonly usage: string;
}

export const JIXU_SLASH_COMMANDS: readonly JixuSlashCommand[] = Object.freeze([
  {
    description: "Show these commands",
    name: "/help",
    requiresArguments: false,
    usage: "/help",
  },
  {
    description: "Create and select an empty Thread",
    name: "/new",
    requiresArguments: false,
    usage: "/new",
  },
  {
    description: "Clear the selected Thread context",
    name: "/clear",
    requiresArguments: false,
    usage: "/clear",
  },
  {
    description: "Select a previous Thread",
    name: "/resume",
    requiresArguments: false,
    usage: "/resume",
  },
  {
    description: "Continue a paused Thread",
    name: "/continue",
    requiresArguments: false,
    usage: "/continue",
  },
  {
    description: "Allow the waiting Tool call once",
    name: "/approve",
    requiresArguments: false,
    usage: "/approve",
  },
  {
    description: "Deny the waiting Tool call",
    name: "/deny",
    requiresArguments: false,
    usage: "/deny",
  },
  {
    description: "Inspect durable Events for the current Thread",
    name: "/events",
    requiresArguments: false,
    usage: "/events",
  },
  {
    description: "Inspect the authoritative current state",
    name: "/state",
    requiresArguments: false,
    usage: "/state",
  },
  {
    description: "Pause after the current dispatch boundary",
    name: "/pause",
    requiresArguments: false,
    usage: "/pause",
  },
  {
    description: "Rebuild state from durable Events only",
    name: "/replay",
    requiresArguments: false,
    usage: "/replay",
  },
  {
    description: "Continue from an earlier Event as a child Thread",
    name: "/fork",
    requiresArguments: true,
    usage: "/fork <event-id> <input>",
  },
  {
    description: "Change API format, Base URL, Key, or model ID",
    name: "/config",
    requiresArguments: false,
    usage: "/config",
  },
  {
    description: "Exit Jixu",
    name: "/quit",
    requiresArguments: false,
    usage: "/quit",
  },
]);

export function formatSlashCommandHelp(): string {
  return JIXU_SLASH_COMMANDS.map(
    (command) => `${command.usage.padEnd(30)}${command.description}`,
  ).join("\n");
}

export function matchingSlashCommands(
  draft: string,
): readonly JixuSlashCommand[] {
  if (!draft.startsWith("/") || /\s/.test(draft)) return [];
  const prefix = draft.toLowerCase();
  return JIXU_SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(prefix),
  );
}
