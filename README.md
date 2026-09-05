# SHC — SNES Header Cleaner

A small browser tool that detects and strips the 512-byte copier header
some SNES ROM dumps carry, so `.smc` files behave like clean `.sfc` files.
Everything runs client-side — files are read and processed in the
browser and never leave your machine.

**Use it here: https://jvillafuerte.github.io/shc/**

## What it does

Drop one or more `.smc`/`.sfc` files onto the page (or click to choose
them). For each file, it:

1. Scans the internal SNES header locations (LoROM, HiROM, and ExHiROM,
   both with and without a copier header) and scores each candidate on
   map mode, ROM/RAM size, region, checksum-complement pair, reset
   vector, and title plausibility.
2. Reports whether a 512-byte header was found, whether the file is
   already clean, or whether the result was ambiguous — nothing is
   assumed unless the detection is high-confidence.
3. Lets you strip the header from every high-confidence match in one
   click, then download the cleaned files (renamed `.sfc`).

## Development

```
shc/
├── index.html       # page shell
├── css/             # index.css (page), shc.css (component, incl. dark mode)
├── src/shc.ts        # the <snes-header-cleaner> custom element, in TypeScript
├── src/shc.test.ts    # its test suite (Vitest + jsdom, 100% coverage enforced)
└── js/shc.js         # generated -- not committed, see below
```

Browsers can't run `.ts` directly, so `index.html` loads a plain, compiled
`js/shc.js`. Before opening `index.html` locally for the first time (or
after editing `src/shc.ts`), build it once:

```
npm install
npm run dev      # bundles src/shc.ts -> js/shc.js (unminified)
npm run watch    # same, but rebuilds automatically on save
```

### Type-checking & tests

```
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run coverage     # vitest run --coverage (fails below 100%)
```

esbuild strips TypeScript's types when bundling but doesn't check them, so
`npm run build` always runs `typecheck` first.

### Build & deploy

```
npm run build    # typecheck, then bundles + minifies src/ and css/ into dist/
npm run deploy   # builds, then publishes dist/ to the gh-pages branch
```
