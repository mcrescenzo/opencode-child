import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const usage = readFileSync(path.join(root, "docs/usage.md"), "utf8");
const releasing = readFileSync(path.join(root, "RELEASING.md"), "utf8");

function markdownFilesUnder(relativeDir) {
  const base = path.join(root, relativeDir);
  return readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return markdownFilesUnder(relativePath);
    return entry.isFile() && entry.name.endsWith(".md") ? [relativePath] : [];
  });
}

test("scripts/ is a maintainer-only dev tool and must not ship in the tarball", () => {
  assert.ok(!pkg.files.includes("scripts"), "files[] must not include 'scripts'");
  assert.ok(existsSync(path.join(root, "scripts/smoke.js")), "scripts/smoke.js must exist in the repo even though it is not packaged");
});

test("public Markdown contains no machine-absolute home paths", () => {
  const markdownFiles = [
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name),
    ...markdownFilesUnder("docs"),
    ...markdownFilesUnder("skills"),
  ];
  const offenders = markdownFiles.flatMap((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    return /\/home\/[^\s`"')]+/.test(text) ? [file] : [];
  });
  assert.deepEqual(offenders, [], `public Markdown must not hardcode /home/... paths: ${offenders.join(", ")}`);
});

test("README install example references the package name", () => {
  assert.ok(readme.includes("@mcrescenzo/opencode-child"), "install example must use the package name");
});

test("scoped package is configured for public publish", () => {
  assert.equal(pkg.publishConfig?.access, "public");
  assert.ok(pkg.engines?.node, "must declare an engines.node floor");
});

test("npm metadata includes public support and discoverability fields", () => {
  assert.equal(pkg.author, "Michael Crescenzo");
  assert.equal(pkg.bugs?.url, "https://github.com/mcrescenzo/opencode-child/issues");
  assert.equal(pkg.homepage, "https://github.com/mcrescenzo/opencode-child#readme");
  assert.ok(pkg.homepage.startsWith(pkg.repository.url));
});

test("README prerequisites document the package Node.js floor", () => {
  assert.ok(readme.includes(`Node.js \`${pkg.engines.node}\``), "README prerequisites must include engines.node");
});

test("safe-mode docs describe loopback default and non-loopback plaintext refusal", () => {
  assert.ok(!readme.includes("loopback-only"), "README must not overstate safe mode as loopback-only");
  assert.ok(!usage.includes("loopback-only"), "usage docs must not overstate safe mode as loopback-only");
  for (const text of [readme, usage]) {
    assert.ok(text.includes("loopback by default"), "safe-mode docs must describe the loopback default");
    assert.ok(text.includes("allowNonLoopback: true"), "safe-mode docs must mention the non-loopback approval flag");
    assert.ok(text.includes("plaintext HTTP"), "safe-mode docs must mention non-loopback plaintext refusal");
    assert.ok(text.includes("TLS"), "safe-mode docs must mention the missing TLS-backed path");
  }
});

test("community files exist and ship in the tarball", () => {
  for (const file of ["CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"]) {
    assert.ok(existsSync(path.join(root, file)), `${file} must exist`);
    assert.ok(pkg.files.includes(file), `files[] must include ${file}`);
  }
});

test("dependency on @opencode-ai/plugin uses a caret range", () => {
  assert.equal(pkg.dependencies["@opencode-ai/plugin"], "^1.17.7");
});

test("package.json has no packageManager field", () => {
  assert.equal(pkg.packageManager, undefined);
});

test("README documents the shipped hooks and skills", () => {
  assert.ok(readme.includes("## Hooks"), "README must document the plugin's hooks");
  assert.ok(readme.includes("## Skills"), "README must document the shipped skills");
  assert.ok(readme.includes("OPENCODE_CHILD_MAX_LIVE"), "README must document the concurrency cap env knob");
  assert.ok(readme.includes("OPENCODE_PLUGIN_DIAGNOSTICS_DIR"), "README must document the diagnostics dir env knob");
  assert.ok(readme.includes("OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED"), "README must document the diagnostics disable env knob");
});

test("release procedure documents required publish gates", () => {
  assert.ok(!pkg.files.includes("RELEASING.md"), "RELEASING.md is a maintainer-only doc and must not ship in the tarball");
  assert.ok(existsSync(path.join(root, "RELEASING.md")), "RELEASING.md must exist in the repo even though it is not packaged");
  const text = releasing.toLowerCase();
  for (const term of [
    "version",
    "changelog",
    "tag",
    "npm test",
    "npm run smoke",
    "npm pack --dry-run --json",
    "npm publish --dry-run",
    "npm publish --access public",
    "rollback",
    "unpublish",
  ]) {
    assert.ok(text.includes(term), `RELEASING.md must mention ${term}`);
  }
});
