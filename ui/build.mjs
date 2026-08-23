#!/usr/bin/env node
/**
 * Concatenates ui/src/*.mjs into the single IIFE Kandev loads as ui/bundle.js.
 *
 * WHY A BUILD STEP AT ALL. Kandev serves one file from `/api/plugins/<id>/bundle`, so
 * relative imports have nothing to resolve against at runtime. The sources are nonetheless
 * real ES modules, because that is what makes the pure halves — format.mjs and ledger.mjs —
 * importable by `node --test` with no browser, no React and no Rill.
 *
 * WHY NOT ESBUILD. This repo has no npm dependencies and no node_modules, and the whole
 * graph is seven files with no cycles, no default exports and no external packages. A
 * bundler would be the largest thing in the project. The trade is that this script has to
 * earn its safety, which it does by refusing to emit anything it cannot verify:
 *
 *   * a duplicate top-level name across files (silent shadowing in one shared scope)
 *   * an imported name nothing exports (a typo that would otherwise be a runtime crash)
 *   * an import form it cannot strip (multi-line, default, or namespace)
 *
 * Any of those exits non-zero with the offending file named. A build that half-works is the
 * failure mode worth engineering against — the same reason extract.sh refuses to promote a
 * partial extract.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

var HERE = dirname(fileURLToPath(import.meta.url));

// Concatenation order IS dependency order. This is a real sequence, so it is written out
// rather than derived: config has no dependencies, plugin.mjs must be last because it calls
// window.registerKandevPlugin at load.
var ORDER = [
  "config.mjs",
  "format.mjs",
  "clipboard.mjs",
  "icon.mjs",
  "rill.mjs",
  "ledger.mjs",
  "panel.mjs",
  "step-analysis.mjs",
  "page.mjs",
  "plugin.mjs",
];

var HEADER = `/**
 * UI bundle for kandev-plugin-ops-intel.
 *
 * GENERATED — DO NOT EDIT. Sources live in ui/src/, built by ui/build.mjs (\`make bundle\`).
 * Editing this file directly means the next build silently discards your change.
 *
 * The sources are ES modules so their pure halves can be unit-tested with \`make test\`;
 * they are concatenated here into one IIFE because Kandev serves exactly one file and a
 * relative import would have nothing to resolve against.
 *
 * NO IMPORTS AND NO BUNDLED REACT, by rule. Everything comes from the injected \`host\` —
 * a second React instance would break the host's contexts and portals.
 */
(function () {
  "use strict";
`;

var FOOTER = "})();\n";

// `export function foo(` / `export var foo =` — the only two forms the sources use.
var EXPORT_DECL = /^export\s+(function|var|const|let)\s+([A-Za-z_$][\w$]*)/;
var IMPORT_LINE = /^import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?\s*$/;
var TOP_DECL = /^(?:export\s+)?(?:function|var|const|let)\s+([A-Za-z_$][\w$]*)/;

var fail = [];
var declared = new Map(); // name -> file
var imported = [];        // { name, file }
var chunks = [];

for (var f of ORDER) {
  var path = join(HERE, "src", f);
  var src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    fail.push(`${f}: listed in ORDER but not found in ui/src/`);
    continue;
  }

  // Reject import/export forms this script cannot faithfully strip, rather than emitting a
  // bundle that looks fine and is not.
  if (/^export\s+default/m.test(src)) fail.push(`${f}: 'export default' is not supported`);
  if (/^export\s*\{/m.test(src)) fail.push(`${f}: 'export { ... }' is not supported — use 'export var/function'`);
  if (/^import\s+[^{]/m.test(src) && !/^import\s*\{/m.test(src)) {
    fail.push(`${f}: only named 'import { a, b } from "..."' is supported`);
  }

  var out = [];
  for (var line of src.split("\n")) {
    var imp = line.match(IMPORT_LINE);
    if (imp) {
      imp[1].split(",").forEach(function (raw) {
        var name = raw.trim();
        if (name) imported.push({ name: name, file: f });
      });
      continue; // dropped: one shared scope needs no imports
    }
    // A bare `import ... from` that did not match the single-line named form would silently
    // survive into the bundle and throw at load. Catch it here instead.
    if (/^\s*import\b/.test(line)) {
      fail.push(`${f}: unsupported import — keep it to one line: ${line.trim()}`);
      continue;
    }

    var decl = line.match(EXPORT_DECL);
    if (decl) line = line.replace(/^export\s+/, "");

    var top = line.match(TOP_DECL);
    if (top && !/^\s/.test(line)) {
      var name = top[1];
      if (declared.has(name)) {
        fail.push(`duplicate top-level name '${name}' in ${f} — already declared in ${declared.get(name)}`);
      }
      declared.set(name, f);
    }
    out.push(line);
  }

  chunks.push(
    `// ${"=".repeat(84)}\n// ui/src/${f}\n// ${"=".repeat(84)}\n` +
      out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  );
}

for (var ref of imported) {
  if (!declared.has(ref.name)) {
    fail.push(`${ref.file} imports '${ref.name}', which nothing in ui/src/ exports`);
  }
}

if (fail.length) {
  console.error("build failed:");
  for (var msg of fail) console.error("  - " + msg);
  process.exit(1);
}

// Two-space indent, matching the IIFE the sources are wrapped in.
var body = chunks
  .join("\n\n\n")
  .split("\n")
  .map(function (l) { return l.length ? "  " + l : l; })
  .join("\n");

var bundle = HEADER + "\n" + body + "\n\n" + FOOTER;
writeFileSync(join(HERE, "bundle.js"), bundle);
console.log(
  `ui/bundle.js: ${ORDER.length} modules, ${declared.size} top-level names, ` +
    `${bundle.split("\n").length} lines`
);
