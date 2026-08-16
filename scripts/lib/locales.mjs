/** Shared helpers for reading and hashing the interface translations. */

import { readdirSync } from 'node:fs';
import { posix } from 'node:path';

import { absolute, readJson } from './catalog.mjs';

/** Repository-relative path to the translations manifest. */
export const LOCALES_INDEX_PATH = 'locales/index.json';

/** Repository-relative path to the per-language metadata. */
export const LOCALES_META_PATH = 'locales/meta.json';

/** Directory holding the catalogues. */
export const LOCALES_DIR = 'locales';

/**
 * Files in `locales/` that are about the translations rather than one of them.
 *
 * Named rather than pattern-matched, so a language whose tag happened to
 * collide with one of these would be a loud failure instead of a catalogue
 * silently missing from the manifest.
 */
const NOT_A_CATALOGUE = new Set(['index.json', 'meta.json']);

/**
 * The language every other one is checked against, and the only one the app
 * does not download.
 *
 * English is compiled into the app: a missing key has to resolve to something,
 * and a fallback fetched over the network is a fallback that can fail. It is
 * published here anyway, as the reference the manifest names and every
 * translation is validated against — without it this repository could not tell
 * a complete translation from one missing half its keys.
 */
export const REFERENCE_TAG = 'en';

/** Repository-relative path of one language's catalogue. */
export function localePath(tag) {
  return posix.join(LOCALES_DIR, `${tag}.json`);
}

/**
 * Every language tag with a catalogue, in a stable order, reference first.
 *
 * Reference first because that is the order the manifest and every error
 * message read best in, and because a directory listing's order is not
 * something to let a published digest depend on.
 */
export function localeTags() {
  const tags = readdirSync(absolute(LOCALES_DIR))
    .filter((name) => name.endsWith('.json') && !NOT_A_CATALOGUE.has(name))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

  return [
    ...tags.filter((tag) => tag === REFERENCE_TAG),
    ...tags.filter((tag) => tag !== REFERENCE_TAG),
  ];
}

/** Tags of the languages the app can download, i.e. everything but the reference. */
export function translationTags() {
  return localeTags().filter((tag) => tag !== REFERENCE_TAG);
}

/** Reads one language's catalogue. */
export function readLocale(tag) {
  return readJson(localePath(tag));
}

/**
 * Every message key in a catalogue, as the dotted paths the app looks them up by.
 *
 * The recursion stops at anything that is not an object, which in a catalogue
 * means a string — so `{ menu: { sources: { label: "…" } } }` yields
 * `menu.sources.label` and nothing shorter. It mirrors `DottedKeys` in the
 * app's `message.ts`, which is what makes comparing two catalogues meaningful.
 */
export function messageKeys(catalogue, prefix = '') {
  const keys = [];

  for (const [key, value] of Object.entries(catalogue)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...messageKeys(value, path));
    } else {
      keys.push(path);
    }
  }

  return keys;
}

/**
 * The `{{placeholders}}` a line interpolates, as a sorted, de-duplicated list.
 *
 * A translation that drops one silently renders a sentence with a fact missing
 * from it, and one that invents a name the app never supplies renders the
 * braces themselves onto a television. Neither fails anything at runtime, which
 * is why they are compared here.
 */
export function placeholdersIn(line) {
  const found = [...line.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]);
  return [...new Set(found)].sort();
}

/**
 * The plural suffixes i18next appends to a key.
 *
 * A key is written `remembered` by the caller and stored as `remembered_one`
 * and `remembered_other`; which forms exist is the *language's* business, not
 * the reference's — Finnish has two and Polish has four — so a key differing
 * only by one of these is not a key the reference is missing.
 */
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** A key with any plural suffix removed, as a caller would write it. */
export function withoutPluralSuffix(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(`_${suffix}`)) {
      return key.slice(0, -(suffix.length + 1));
    }
  }
  return key;
}
