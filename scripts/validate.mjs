#!/usr/bin/env node
/**
 * Validates the whole catalog. CI runs this on every pull request.
 *
 * Schema validation covers one file at a time; most of what can actually go
 * wrong here is between files — an id reused in another shard, a city that no
 * longer exists in the taxonomy, a manifest describing bytes that have since
 * changed. Those checks are the reason this script exists.
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

console.log(
  `Catalog is valid: ${totalSources} sources, ${shards.length} shards, ${countries.size} countries, ${languages.size} languages.` +
    (warnings.length > 0 ? ` ${warnings.length} warning(s).` : ''),
);
