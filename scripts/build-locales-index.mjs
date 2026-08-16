#!/usr/bin/env node
/**
 * Regenerates `locales/index.json` from whatever is in `locales/`.
 *
 * Run it after editing or adding a translation, and commit the result. Pass
 * `--check` to fail instead of writing, which is what CI does so a pull request
 * cannot land a manifest that disagrees with the files it describes.
 *
 * `revision` and `generatedAt` only move when the content actually changes.
 * Stamping them on every run would produce a diff for every pull request and
 * make the app redownload a catalogue identical to the one it already has.
 *
 * # Where the endonym and the licence come from
 *
 * Neither can be derived from the catalogue, and neither should be invented
 * here, so both are read from `locales/meta.json` — the one file in this
 * directory that is about the translations rather than one of them. A language
 * with a catalogue and no entry there fails, rather than being published as
 * "fi" with no licence recorded against it.
 */

import { writeFileSync } from 'node:fs';

import { absolute, digest, readJson } from './lib/catalog.mjs';
import {
  LOCALES_INDEX_PATH,
  LOCALES_META_PATH,
  localePath,
  messageKeys,
  readLocale,
  REFERENCE_TAG,
  translationTags,
} from './lib/locales.mjs';

const checkOnly = process.argv.includes('--check');

function artefactFor(tag) {
  const path = localePath(tag);
  return { path, ...digest(path), keyCount: messageKeys(readLocale(tag)).length };
}

function buildIndex() {
  const meta = readJson(LOCALES_META_PATH);
  const reference = artefactFor(REFERENCE_TAG);

  const languages = translationTags().map((tag) => {
    const entry = meta.languages?.[tag];
    if (!entry) {
      throw new Error(
        `${LOCALES_META_PATH}: no entry for "${tag}". Every translation needs an endonym and a licence recorded before it can be published.`,
      );
    }

    return {
      tag,
      endonym: entry.endonym,
      ...artefactFor(tag),
      licence: entry.licence,
      ...(entry.credit ? { credit: entry.credit } : {}),
    };
  });

  return { schemaVersion: 1, reference, languages };
}

function unchanged(previous, next) {
  if (!previous) {
    return false;
  }

  const shape = (index) => ({
    schemaVersion: index.schemaVersion,
    reference: index.reference,
    languages: index.languages,
  });

  return JSON.stringify(shape(previous)) === JSON.stringify(shape(next));
}

let previous = null;
try {
  previous = readJson(LOCALES_INDEX_PATH);
} catch {
  // No manifest yet, or an unreadable one. Either way we are about to write it.
}

const built = buildIndex();

if (unchanged(previous, built)) {
  console.log(`${LOCALES_INDEX_PATH} is up to date (revision ${previous.revision}).`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `${LOCALES_INDEX_PATH} is stale. Run "node scripts/build-locales-index.mjs" and commit the result.`,
  );
  process.exit(1);
}

const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const index = {
  schemaVersion: built.schemaVersion,
  revision: now,
  generatedAt: now,
  reference: built.reference,
  languages: built.languages,
};

writeFileSync(absolute(LOCALES_INDEX_PATH), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(
  `Wrote ${LOCALES_INDEX_PATH}: revision ${now}, ${index.languages.length} translations of ${index.reference.keyCount} messages.`,
);
