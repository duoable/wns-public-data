#!/usr/bin/env node
/**
 * Regenerates `catalog/index.json` from whatever is in `catalog/`.
 *
 * Run it after editing a shard, and commit the result. Pass `--check` to fail
 * instead of writing, which is what CI does so a pull request cannot land a
 * manifest that disagrees with the files it describes.
 *
 * `revision` and `generatedAt` only move when the content actually changes.
 * Stamping them on every run would produce a diff for every pull request and
 * make the app redownload a catalog identical to the one it already has.
 */

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  absolute,
  digest,
  INDEX_PATH,
  readJson,
  shardPaths,
  TAXONOMY_PATH,
} from './lib/catalog.mjs';

const checkOnly = process.argv.includes('--check');

function buildIndex() {
  const taxonomy = { path: TAXONOMY_PATH, ...digest(TAXONOMY_PATH) };

  const shards = shardPaths().map((path) => {
    const document = readJson(path);
    const id = basename(path, '.json');

    if (document.shard !== id) {
      throw new Error(`${path}: declares shard "${document.shard}" but is named "${id}.json"`);
    }

    return { id, path, ...digest(path), sourceCount: document.sources.length };
  });

  const sourceCount = shards.reduce((total, shard) => total + shard.sourceCount, 0);

  return { schemaVersion: 1, taxonomy, shards, sourceCount };
}

function unchanged(previous, next) {
  if (!previous) {
    return false;
  }

  const shape = (index) => ({
    schemaVersion: index.schemaVersion,
    sourceCount: index.sourceCount,
    taxonomy: index.taxonomy,
    shards: index.shards,
  });

  return JSON.stringify(shape(previous)) === JSON.stringify(shape(next));
}

let previous = null;
try {
  previous = readJson(INDEX_PATH);
} catch {
  // No manifest yet, or an unreadable one. Either way we are about to write it.
}

const built = buildIndex();

if (unchanged(previous, built)) {
  console.log(`${INDEX_PATH} is up to date (revision ${previous.revision}).`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `${INDEX_PATH} is stale. Run "node scripts/build-index.mjs" and commit the result.`,
  );
  process.exit(1);
}

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const index = {
  schemaVersion: built.schemaVersion,
  revision: now,
  generatedAt: now,
  sourceCount: built.sourceCount,
  taxonomy: built.taxonomy,
  shards: built.shards,
};

writeFileSync(absolute(INDEX_PATH), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(
  `Wrote ${INDEX_PATH}: revision ${now}, ${index.sourceCount} sources across ${index.shards.length} shards.`,
);
