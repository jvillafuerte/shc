"use strict";

/*
 * Builds dist/: copies index.html and the static SEO files as-is, and
 * minifies every file under css/ and js/ into the matching dist/
 * subfolder. Used by `npm run build` and, before publishing,
 * `npm run deploy`.
 */

const fs = require("fs");
const path = require("path");
const CleanCSS = require("clean-css");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function minifyDirectory(srcDir, destDir, minify) {
  fs.mkdirSync(destDir, { recursive: true });

  for (const name of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    const source = fs.readFileSync(srcPath, "utf8");
    const minified = await minify(source);

    fs.writeFileSync(destPath, minified);

    console.log(
      `  ${path.relative(ROOT, srcPath)} -> ${path.relative(ROOT, destPath)} ` +
        `(${formatSize(Buffer.byteLength(source))} -> ${formatSize(Buffer.byteLength(minified))})`
    );
  }
}

function minifyCss(source) {
  const output = new CleanCSS().minify(source);

  if (output.errors.length > 0) {
    throw new Error(output.errors.join("\n"));
  }

  return output.styles;
}

/*
 * Bundling (via entryPoints, even though this file has no imports of its
 * own) lets esbuild treat top-level names as local to the IIFE it wraps
 * everything in, so it can mangle them too -- a plain transform() has to
 * leave top-level names alone, since it can't prove nothing else on the
 * page depends on them. esbuild strips TypeScript's types itself, so no
 * separate compile step is needed here -- just `npm run typecheck`.
 */
async function minifyTsDirectory(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

  for (const name of entries) {
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name.replace(/\.ts$/, ".js"));
    const source = fs.readFileSync(srcPath, "utf8");

    const result = await esbuild.build({
      entryPoints: [srcPath],
      bundle: true,
      minify: true,
      format: "iife",
      write: false
    });

    const minified = result.outputFiles[0].text;

    fs.writeFileSync(destPath, minified);

    console.log(
      `  ${path.relative(ROOT, srcPath)} -> ${path.relative(ROOT, destPath)} ` +
        `(${formatSize(Buffer.byteLength(source))} -> ${formatSize(Buffer.byteLength(minified))})`
    );
  }
}

async function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  for (const name of ["index.html", "robots.txt", "sitemap.xml"]) {
    fs.copyFileSync(path.join(ROOT, name), path.join(DIST, name));
  }

  console.log("Copied index.html, robots.txt, sitemap.xml");

  console.log("Minifying CSS...");
  await minifyDirectory(path.join(ROOT, "css"), path.join(DIST, "css"), minifyCss);

  console.log("Bundling + minifying TypeScript...");
  await minifyTsDirectory(path.join(ROOT, "src"), path.join(DIST, "js"));

  console.log(`\nBuild complete: ${path.relative(ROOT, DIST)}/`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
