import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const coreRoot = fileURLToPath(new URL("../packages/core/src/", import.meta.url));
const failures = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(path)));
    } else if (extname(entry.name) === ".ts") {
      files.push(path);
    }
  }

  return files;
}

for (const path of await collect(coreRoot)) {
  const source = await readFile(path, "utf8");
  const label = relative(root, path);

  if (/\b(?:TODO|FIXME)\b/.test(source)) {
    failures.push(`${label}: unresolved TODO/FIXME`);
  }

  if (/\bany\b/.test(source)) {
    failures.push(`${label}: use unknown or a concrete type instead of any`);
  }

  if (/@ts-(?:ignore|nocheck)/.test(source)) {
    failures.push(`${label}: TypeScript suppression is not allowed in core`);
  }

  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;

    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      failures.push(`${label}: core import must be local, found ${specifier}`);
    }

    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts")
    ) {
      failures.push(`${label}: relative imports must use an explicit .ts extension`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("core architecture lint passed");
}
