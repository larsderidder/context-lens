import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [archive] = JSON.parse(readFileSync(0, "utf8"));
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(archive.version, manifest.version);
const files = new Set(archive.files.map((file) => file.path));
for (const filename of [
  "dist/cli.js",
  "dist/version.generated.js",
  "ui/dist/index.html",
  "mitm_addon.py",
  "schema/lhar.schema.json",
  "extensions/mitm-preflight.js",
  ...manifest.pi.extensions.map((filename) => filename.replace(/^\.\//, "")),
]) {
  assert.ok(files.has(filename), `${filename} missing from npm tarball`);
}
console.log(`Verified context-lens@${archive.version} package contents`);
