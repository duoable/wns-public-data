#!/usr/bin/env node
/**
 * Validates the whole catalog. CI runs this on every pull request.
 *
 * Schema validation covers one file at a time; most of what can actually go
 * wrong here is between files — an id reused in another shard, a city that no
 * longer exists in the taxonomy, a manifest describing bytes that have since
 * changed. Those checks are the reason this script exists.
 *
 * One check asks a different question from the rest. This repository is public
 * and permanent, so committing to it is republishing, and `checkProvenance`
 * refuses a tracked file whose origin and licence nobody has written down. It
 * is last in the file and first in importance: everything else here can be
 * corrected in the next commit.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import {
  absolute,
  digest,
  INDEX_PATH,
  indexTaxonomy,
  nodeFor,
  readJson,
  shardPaths,
  TAXONOMY_PATH,
} from './lib/catalog.mjs';
import {
  LOCALES_INDEX_PATH,
  LOCALES_META_PATH,
  localePath,
  messageKeys,
  placeholdersIn,
  readLocale,
  REFERENCE_TAG,
  translationTags,
  withoutPluralSuffix,
} from './lib/locales.mjs';
import { checkProvenance, PROVENANCE_PATH } from './lib/provenance.mjs';
import { validate } from './lib/json-schema.mjs';

const errors = [];
const warnings = [];

const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

// ---------------------------------------------------------------- schemas

const schemas = {
  index: readJson('schema/index.schema.json'),
  taxonomy: readJson('schema/taxonomy.schema.json'),
  shard: readJson('schema/shard.schema.json'),
  localesIndex: readJson('schema/locales-index.schema.json'),
  locale: readJson('schema/locale.schema.json'),
};

function checkAgainstSchema(label, document, schema) {
  for (const problem of validate(document, schema)) {
    fail(`${label} ${problem}`);
  }
}

const taxonomy = readJson(TAXONOMY_PATH);
checkAgainstSchema(TAXONOMY_PATH, taxonomy, schemas.taxonomy);

const shards = shardPaths().map((path) => {
  const document = readJson(path);
  checkAgainstSchema(path, document, schemas.shard);
  return { path, id: basename(path, '.json'), document };
});

// ------------------------------------------------------------- taxonomy

const seenCountries = new Map();
const seenRegionIds = new Set();

for (const region of taxonomy.regions) {
  if (seenRegionIds.has(region.id)) {
    fail(`${TAXONOMY_PATH}: duplicate region id "${region.id}"`);
  }
  seenRegionIds.add(region.id);

  for (const country of region.countries ?? []) {
    const previous = seenCountries.get(country.code);
    if (previous) {
      fail(
        `${TAXONOMY_PATH}: country ${country.code} appears in both "${previous}" and "${region.id}" — a country belongs to exactly one region`,
      );
    }
    seenCountries.set(country.code, region.id);

    const cityIds = new Set();
    for (const city of country.cities ?? []) {
      if (cityIds.has(city.id)) {
        fail(`${TAXONOMY_PATH}: ${country.code} lists the city "${city.id}" twice`);
      }
      cityIds.add(city.id);
    }

    for (const subdivision of country.subdivisions ?? []) {
      if (!subdivision.code.startsWith(`${country.code}-`)) {
        fail(
          `${TAXONOMY_PATH}: subdivision "${subdivision.code}" is listed under ${country.code} but its ISO 3166-2 prefix says otherwise`,
        );
      }
    }
  }
}

const taxonomyIndex = indexTaxonomy(taxonomy);

// --------------------------------------------------------------- sources

const byId = new Map();
const byUrl = new Map();
const sourcesPerNode = new Map();

for (const { path, id: shardId, document } of shards) {
  if (document.shard !== shardId) {
    fail(`${path}: declares shard "${document.shard}" but is named "${shardId}.json"`);
  }

  for (const entry of document.sources) {
    const where = `${path} [${entry.id}]`;

    const duplicateId = byId.get(entry.id);
    if (duplicateId) {
      fail(`${where}: id already used in ${duplicateId}. Ids are permanent — pick another.`);
    }
    byId.set(entry.id, path);

    const duplicateUrl = byUrl.get(entry.url);
    if (duplicateUrl) {
      fail(`${where}: ${entry.url} is already polled by ${duplicateUrl}`);
    }
    byUrl.set(entry.url, `${path} [${entry.id}]`);

    try {
      new URL(entry.url);
    } catch {
      fail(`${where}: ${entry.url} is not a parseable URL`);
    }

    // Placement: a source's shard must belong to its country's region, so the
    // app can fetch one region without missing anything that lives in it.
    const expectedRegion = entry.scope === 'global' ? 'global' : seenCountries.get(entry.country);
    if (entry.scope !== 'global' && !expectedRegion) {
      fail(`${where}: country "${entry.country}" is not in ${TAXONOMY_PATH}`);
    } else if (shardId !== expectedRegion && !shardId.startsWith(`${expectedRegion}-`)) {
      fail(`${where}: belongs in the "${expectedRegion}" shard, not "${shardId}"`);
    }

    if (entry.city && !taxonomyIndex.cities.has(`${entry.country}/${entry.city}`)) {
      fail(`${where}: city "${entry.city}" is not listed under ${entry.country} in ${TAXONOMY_PATH}`);
    }

    if (entry.region && !taxonomyIndex.subdivisions.has(`${entry.country}/${entry.region}`)) {
      fail(
        `${where}: subdivision "${entry.region}" is not listed under ${entry.country} in ${TAXONOMY_PATH}`,
      );
    }

    if (entry.city && entry.region) {
      fail(`${where}: has both a city and a subdivision; pick the one that describes its remit`);
    }

    const node = nodeFor(entry, taxonomyIndex);
    if (node) {
      sourcesPerNode.set(node, (sourcesPerNode.get(node) ?? 0) + 1);
    }

    if (entry.logo) {
      if (!existsSync(absolute(entry.logo.path))) {
        fail(`${where}: logo ${entry.logo.path} does not exist`);
      } else if (digest(entry.logo.path).sha256 !== entry.logo.sha256) {
        fail(`${where}: logo ${entry.logo.path} does not match its recorded sha256`);
      }
    }
  }
}

// A node nobody publishes from renders as an empty branch in the picker.
// A warning, not an error: adding the country before its first source is a
// reasonable order to work in.
for (const [node, label] of taxonomyIndex.nodeLabels) {
  if (node === 'global') continue;
  const hasOwn = (sourcesPerNode.get(node) ?? 0) > 0;
  const hasDescendant = [...sourcesPerNode.keys()].some((other) => other.startsWith(`${node}/`));
  if (!hasOwn && !hasDescendant) {
    warn(`${TAXONOMY_PATH}: "${label}" (${node}) has no sources`);
  }
}

// --------------------------------------------------------------- manifest

if (!existsSync(absolute(INDEX_PATH))) {
  fail(`${INDEX_PATH} is missing. Run "node scripts/build-index.mjs".`);
} else {
  const index = readJson(INDEX_PATH);
  checkAgainstSchema(INDEX_PATH, index, schemas.index);

  const taxonomyDigest = digest(TAXONOMY_PATH);
  if (index.taxonomy.sha256 !== taxonomyDigest.sha256 || index.taxonomy.bytes !== taxonomyDigest.bytes) {
    fail(`${INDEX_PATH}: the taxonomy hash is stale. Run "node scripts/build-index.mjs".`);
  }

  const described = new Map(index.shards.map((shard) => [shard.id, shard]));

  for (const { path, id, document } of shards) {
    const shard = described.get(id);
    if (!shard) {
      fail(`${INDEX_PATH}: does not list the shard "${id}", but ${path} exists`);
      continue;
    }

    const actual = digest(path);
    if (shard.sha256 !== actual.sha256 || shard.bytes !== actual.bytes) {
      fail(`${INDEX_PATH}: the hash for "${id}" is stale. Run "node scripts/build-index.mjs".`);
    }
    if (shard.sourceCount !== document.sources.length) {
      fail(
        `${INDEX_PATH}: says "${id}" holds ${shard.sourceCount} sources, the file holds ${document.sources.length}`,
      );
    }
    if (shard.path !== path) {
      fail(`${INDEX_PATH}: says "${id}" lives at ${shard.path}, it lives at ${path}`);
    }
    described.delete(id);
  }

  for (const orphan of described.keys()) {
    fail(`${INDEX_PATH}: lists the shard "${orphan}", but no such file exists`);
  }

  const total = shards.reduce((sum, { document }) => sum + document.sources.length, 0);
  if (index.sourceCount !== total) {
    fail(`${INDEX_PATH}: says ${index.sourceCount} sources in total, the shards hold ${total}`);
  }
}

// ---------------------------------------------------------------- locales

/**
 * Holds every translation to the same messages as English.
 *
 * This is the check that cannot live in the app: the app compiles English in
 * and knows its keys at build time, but it has never seen a translation until
 * a viewer downloads one. A missing key is not an error at runtime — i18next
 * quietly falls back to English — so without this a half-finished translation
 * ships and looks finished to everyone who cannot read the missing rows.
 */
function validateLocales() {
  const reference = readLocale(REFERENCE_TAG);
  checkAgainstSchema(localePath(REFERENCE_TAG), reference, schemas.locale);

  const meta = readJson(LOCALES_META_PATH);
  const referenceKeys = new Set(messageKeys(reference).map(withoutPluralSuffix));

  /**
   * The placeholders each reference line declares, by its exact key.
   *
   * Exact, and not with the plural suffix stripped, because the forms of one
   * key legitimately differ: English writes `orphaned_one` as "One source you
   * chose…" and only `orphaned_other` interpolates `{{count}}`. Folding them
   * together compares the singular against the plural's placeholders and
   * reports every correctly written translation in the file.
   */
  const referenceLines = new Map();

  /** Every placeholder any form of a key uses, for a form English lacks. */
  const referenceByBase = new Map();

  const collect = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object') {
        collect(value, path);
      } else {
        const names = placeholdersIn(value);
        referenceLines.set(path, names);

        const base = withoutPluralSuffix(path);
        const union = referenceByBase.get(base) ?? new Set();
        for (const name of names) {
          union.add(name);
        }
        referenceByBase.set(base, union);
      }
    }
  };
  collect(reference, '');

  for (const tag of translationTags()) {
    const path = localePath(tag);
    const catalogue = readLocale(tag);
    checkAgainstSchema(path, catalogue, schemas.locale);

    if (!meta.languages?.[tag]) {
      fail(`${LOCALES_META_PATH}: no entry for "${tag}", so it has no endonym and no licence`);
    }

    const keys = messageKeys(catalogue);
    const seen = new Set(keys.map(withoutPluralSuffix));

    for (const key of referenceKeys) {
      if (!seen.has(key)) {
        fail(`${path}: does not translate "${key}"`);
      }
    }

    for (const key of seen) {
      if (!referenceKeys.has(key)) {
        fail(`${path}: translates "${key}", which English does not carry`);
      }
    }

    // A dropped placeholder renders a sentence with a fact missing from it; an
    // invented one puts the braces themselves on a television. Neither fails
    // anything at runtime, which is exactly why they are compared here.
    for (const key of keys) {
      const line = key.split('.').reduce((node, part) => node?.[part], catalogue);
      if (typeof line !== 'string') {
        continue;
      }

      const actual = placeholdersIn(line);
      const exact = referenceLines.get(key);

      if (exact) {
        const missing = exact.filter((name) => !actual.includes(name));
        if (missing.length > 0) {
          fail(`${path}: "${key}" leaves out ${missing.map((n) => `{{${n}}}`).join(', ')}`);
        }
      }

      // A plural form English does not have — Polish needs four where English
      // has two — is checked in one direction only. What it may safely leave
      // out is that language's grammar and not this repository's business;
      // what it may not do is name a value the app never supplies.
      const allowed = exact ?? [...(referenceByBase.get(withoutPluralSuffix(key)) ?? [])];
      const invented = actual.filter((name) => !allowed.includes(name));

      if (invented.length > 0) {
        fail(
          `${path}: "${key}" uses ${invented.map((n) => `{{${n}}}`).join(', ')}, which the app never supplies`,
        );
      }
    }
  }

  // The manifest against the files it describes.
  let index;
  try {
    index = readJson(LOCALES_INDEX_PATH);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  checkAgainstSchema(LOCALES_INDEX_PATH, index, schemas.localesIndex);

  const described = new Map(index.languages.map((language) => [language.tag, language]));

  for (const tag of translationTags()) {
    const language = described.get(tag);
    if (!language) {
      fail(`${LOCALES_INDEX_PATH}: does not list "${tag}", but ${localePath(tag)} exists`);
      continue;
    }

    const actual = digest(localePath(tag));
    if (language.sha256 !== actual.sha256 || language.bytes !== actual.bytes) {
      fail(
        `${LOCALES_INDEX_PATH}: the hash for "${tag}" is stale. Run "node scripts/build-locales-index.mjs".`,
      );
    }
    described.delete(tag);
  }

  for (const orphan of described.keys()) {
    fail(`${LOCALES_INDEX_PATH}: lists "${orphan}", but no such catalogue exists`);
  }

  const referenceDigest = digest(localePath(REFERENCE_TAG));
  if (index.reference.sha256 !== referenceDigest.sha256) {
    fail(
      `${LOCALES_INDEX_PATH}: the reference hash is stale. Run "node scripts/build-locales-index.mjs".`,
    );
  }
}

validateLocales();

// ------------------------------------------------------------- provenance

// Last, because it is the check that answers a different question from all the
// others. They ask whether the data is correct; this asks whether it is ours to
// publish. A repository that is public and permanent cannot un-publish a file,
// so an undeclared one fails the build rather than being reported as a warning.
const coveredFiles = checkProvenance(fail, checkAgainstSchema);

// ----------------------------------------------------------------- report

const totalSources = byId.size;
const countries = new Set();
const languages = new Set();
for (const { document } of shards) {
  for (const entry of document.sources) {
    if (entry.country) countries.add(entry.country);
    for (const language of entry.languages) languages.add(language.split('-')[0]);
  }
}

for (const message of warnings) {
  console.warn(`warning: ${message}`);
}

if (errors.length > 0) {
  for (const message of errors) {
    console.error(`error: ${message}`);
  }
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}

const translationCount = translationTags().length;

console.log(
  `Catalog is valid: ${totalSources} sources, ${shards.length} shards, ${countries.size} countries, ${languages.size} languages.` +
    ` Interface translations: ${translationCount}.` +
    ` ${coveredFiles} published file(s) covered by ${PROVENANCE_PATH}.` +
    (warnings.length > 0 ? ` ${warnings.length} warning(s).` : ''),
);
