import { addDefaultParsers } from "@opentui/core";

import { getParsers } from "./tui-parsers.generated.ts";

export type JixuParserRegistration =
  | { readonly status: "registered" }
  | { readonly message: string; readonly status: "unavailable" };

let registration: Promise<JixuParserRegistration> | undefined;

export function registerJixuCodeParsers(): Promise<JixuParserRegistration> {
  registration ??= (async () => {
    try {
      const parsers = await getParsers();
      addDefaultParsers(parsers);
      return { status: "registered" };
    } catch (error) {
      return {
        message:
          error instanceof Error
            ? error.message
            : "Could not resolve local parser assets.",
        status: "unavailable",
      };
    }
  })();
  return registration;
}
