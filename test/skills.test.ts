import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));

test("package manifest exposes the build-review-fix skill to Pi", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert(manifest.files.includes("skills"), "published package must include skills");
  assert.deepEqual(manifest.pi.extensions, ["./dist/extension.js"]);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  const result = loadSkills({
    cwd: root,
    skillPaths: manifest.pi.skills.map((path: string) => resolve(root, path)),
    includeDefaults: false,
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  const skill = result.skills[0];
  assert.equal(skill.name, "build-review-fix");
  assert.equal(skill.filePath, resolve(root, "skills/build-review-fix/SKILL.md"));
  assert.equal(skill.disableModelInvocation, false);
  assert.match(skill.description, /review_changes/);
});
