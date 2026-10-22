// The real Rust engine for the `dom` lane (`*.dom.test.js`). rust-engine.js
// finds the wasm and the fixture fonts from its own `import.meta.url`, which
// jsdom does not give as a file URL; here they are found from the project's
// root, where vitest runs. Same wasm, same faces, same failure when the wasm
// has not been built.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRustTextEngine } from '../lib/text-engine/rust.js';

const root = process.cwd();
const wasmPath = resolve(root, 'text-engine/js/generated/mt_text.wasm');
const FACES = [
  ['Comic Neue', 'regular', 'ComicNeue-Regular.ttf'],
  ['Bangers', 'regular', 'Bangers-Regular.ttf'],
  ['DejaVu Sans', 'regular', 'DejaVuSans.ttf'],
  ['DejaVu Sans', 'italic', 'DejaVuSans-Oblique.ttf'],
];

export async function domRustEngine() {
  if (!existsSync(wasmPath)) throw new Error(`${wasmPath} is missing: run npm run build:engine`);
  let engine;
  try {
    engine = await createRustTextEngine(readFileSync(wasmPath));
  } catch (error) {
    if (/ABI/.test(error.message)) throw new Error(`${error.message}: the wasm is stale, run npm run build:engine`);
    throw error;
  }
  for (const [family, slot, file] of FACES) engine.addFace(family, slot, readFileSync(resolve(root, 'src/test/fonts', file)));
  return engine;
}
