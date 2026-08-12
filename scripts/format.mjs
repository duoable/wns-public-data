#!/usr/bin/env node
/**
 * Rewrites the catalog JSON in one deterministic style.
 *
 * The manifest records a sha256 over the exact bytes of each file, so
 * formatting is not cosmetic here: two contributors with different editors
 * would otherwise produce different hashes for identical data. Running this
 * before committing removes that whole class of argument.
 *
 * Short arrays of primitives stay on one line. A data file people edit by hand
 * should not be four hundred lines longer than it needs to be.
 *
 * Usage:
 *   node scripts/format.mjs           rewrite in place
 *   node scripts/format.mjs --check   fail if anything is unformatted
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

import { absolute, INDEX_PATH, readJson, shardPaths, TAXONOMY_PATH } from './lib/catalog.mjs';

const INLINE_ARRAY_LIMIT = 72;

/** Serialises `value` with short primitive arrays kept on one line. */
export function format(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }

    const allPrimitive = value.every((item) => item === null || typeof item !== 'object');
    if (allPrimitive) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (pad.length + inline.length <= INLINE_ARRAY_LIMIT) {
        return inline;
      }
    }

    const items = value.map((item) => `${padInner}${format(item, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '{}';
  }

  const lines = entries.map(
    ([key, item]) => `${padInner}${JSON.stringify(key)}: ${format(item, indent + 1)}`,
  );
  return `{\n${lines.join(',\n')}\n${pad}}`;
}

function main() {
  const checkOnly = argv.includes('--check');
  const paths = [TAXONOMY_PATH, ...shardPaths(), INDEX_PATH];
  const unformatted = [];

  for (const path of paths) {
    let current;
    try {
      current = readFileSync(absolute(path), 'utf8');
    } catch {
      continue; // The manifest may not exist yet on a first run.
    }

    const wanted = `${format(readJson(path))}\n`;
    if (current === wanted) {
      continue;
    }

    unformatted.push(path);
    if (!checkOnly) {
      writeFileSync(absolute(path), wanted, 'utf8');
    }
  }

  if (unformatted.length === 0) {
    console.log(`All ${paths.length} catalog files are formatted.`);
    return 0;
  }

  if (checkOnly) {
    console.error('These files need formatting. Run "node scripts/format.mjs":');
    for (const path of unformatted) console.error(`  ${path}`);
    return 1;
  }

  console.log(`Formatted ${unformatted.length} file(s):`);
  for (const path of unformatted) console.log(`  ${path}`);
  console.log('\nHashes have changed — run "node scripts/build-index.mjs" next.');
  return 0;
}

// Only run the command line when invoked directly. `format` is imported by
// other scripts, and a module that reformats the repository as a side effect of
// being imported is a trap. `argv[1]` is absent under `node --eval`, which is
// also not a direct invocation.
if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  exit(main());
}
