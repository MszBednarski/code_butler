import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
export async function workerSource(directory) {
  const entries = (await readdir(directory))
    .filter(
      (name) =>
        [
          "Dockerfile",
          ".dockerignore",
          "package.json",
          "package-lock.json",
          "verdict.schema.json",
          "change.schema.json",
          "name.schema.json",
        ].includes(name) || /\.mjs$/.test(name),
    )
    .sort();
  const fingerprint = createHash("sha256");
  for (const entry of entries)
    fingerprint
      .update(entry)
      .update(await readFile(path.join(directory, entry)));
  return { entries, hash: fingerprint.digest("hex").slice(0, 24) };
}
