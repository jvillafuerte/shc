"use strict";

/*
 * Bundles src/shc.ts -> js/shc.js, unminified, for opening index.html
 * directly in a browser during local development (browsers can't run
 * .ts files, so this replaces the old "no build step" workflow with a
 * single one-off command). Pass --watch to keep rebuilding on save.
 */

const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

async function main() {
  const watch = process.argv.includes("--watch");

  const options = {
    entryPoints: [path.join(ROOT, "src", "shc.ts")],
    outfile: path.join(ROOT, "js", "shc.js"),
    bundle: true,
    format: "iife",
    sourcemap: "inline"
  };

  if (watch) {
    const context = await esbuild.context(options);

    await context.watch();
    console.log("Watching src/ for changes (js/shc.js)... Ctrl+C to stop.");
  } else {
    await esbuild.build(options);
    console.log("Built js/shc.js from src/shc.ts");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
