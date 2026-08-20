import type {
  CliRenderer,
  KeyEvent,
  Selection,
} from "@opentui/core";

interface SelectionClipboardService {
  readonly dispose: () => Promise<void>;
  readonly writeText: (
    text: string,
    options: { readonly destination: "best-available" },
  ) => Promise<unknown>;
}

export interface JixuSelectionClipboardBinding {
  readonly dispose: () => Promise<void>;
  readonly settled: () => Promise<void>;
}

const writeOptions = Object.freeze({
  destination: "best-available" as const,
});

export function installJixuSelectionClipboard(
  renderer: CliRenderer,
  clipboard: SelectionClipboardService,
): JixuSelectionClipboardBinding {
  let accepting = true;
  let writes = Promise.resolve();
  let disposePromise: Promise<void> | undefined;

  const enqueue = (text: string) => {
    if (!accepting || text.length === 0) return;
    writes = writes.then(async () => {
      try {
        await clipboard.writeText(text, writeOptions);
      } catch {
        // Clipboard failures are presentation-local and must not stop later copies.
      }
    });
  };

  const copySelection = (selection: Selection) => {
    enqueue(selection.getSelectedText());
  };

  const copyWithShortcut = (key: KeyEvent) => {
    if (key.name !== "c" || key.super !== true || key.repeated === true) return;

    key.preventDefault();
    key.stopPropagation();
    const editorText = renderer.currentFocusedEditor?.getSelectedText() ?? "";
    const rendererText = renderer.getSelection()?.getSelectedText() ?? "";
    enqueue(editorText.length > 0 ? editorText : rendererText);
  };

  renderer.on("selection", copySelection);
  renderer.keyInput.on("keypress", copyWithShortcut);

  return {
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;

      accepting = false;
      renderer.off("selection", copySelection);
      renderer.keyInput.off("keypress", copyWithShortcut);
      disposePromise = writes.then(async () => {
        try {
          await clipboard.dispose();
        } catch {
          // Teardown must remain reliable even if a clipboard backend fails.
        }
      });
      return disposePromise;
    },
    settled: () => writes,
  };
}
