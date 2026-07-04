import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const copies = [
  {
    destination: join(
      repositoryRoot,
      "packages",
      "jixu",
      "dist",
      "tree-sitter-assets",
    ),
    source: join(
      repositoryRoot,
      "packages",
      "jixu",
      "src",
      "tree-sitter-assets",
    ),
  },
];

for (const { destination, source } of copies) {
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}
