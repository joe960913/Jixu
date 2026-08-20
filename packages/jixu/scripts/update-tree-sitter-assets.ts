import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { updateAssets } from "@opentui/core/tree-sitter/update-assets";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

await updateAssets({
  assetsDir: join(packageRoot, "src", "tree-sitter-assets"),
  configPath: join(packageRoot, "tree-sitter.parsers.json"),
  outputPath: join(packageRoot, "src", "tui-parsers.generated.ts"),
});
