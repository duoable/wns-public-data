/** Shared helpers for reading and hashing the catalog. */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repository-relative path to the manifest. */
export const INDEX_PATH = 'catalog/index.json';

/** Repository-relative path to the taxonomy. */
export const TAXONOMY_PATH = 'catalog/taxonomy.json';

/** Directory holding the source shards. */
export const SOURCES_DIR = 'catalog/sources';

/** Resolves a repository-relative path against the repository root. */
export function absolute(relativePath) {
  return join(REPO_ROOT, relativePath);
}

/**
 * Reads a file as raw bytes and returns its size and digest.
 *
 * The manifest's hashes are over the exact committed bytes, which is why this
 * never decodes to a string — `.gitattributes` pins these files to LF so a
 * Windows checkout produces the same digest as a Linux one.
 */
export function digest(relativePath) {
  const bytes = readFileSync(absolute(relativePath));
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

/** Reads and parses a JSON file, reporting the path when it will not parse. */
export function readJson(relativePath) {
  const text = readFileSync(absolute(relativePath), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

/** Repository-relative paths of every shard, in a stable order. */
export function shardPaths() {
  return readdirSync(absolute(SOURCES_DIR))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => posix.join(SOURCES_DIR, name));
}

/**
 * Flattens the taxonomy into lookup tables.
 *
 * Node ids are derived rather than written down: `europe`, `europe/FI`,
 * `europe/FI/helsinki`, `europe/FI/FI-01`. Deriving them means the taxonomy
 * file cannot disagree with itself about what a node is called.
 */
export function indexTaxonomy(taxonomy) {
  /** @type {Map<string, {code: string, region: string, node: string, label: string}>} */
  const countries = new Map();
  /** @type {Set<string>} */
  const cities = new Set();
  /** @type {Set<string>} */
  const subdivisions = new Set();
  /** @type {Map<string, string>} */
  const nodeLabels = new Map();

  for (const region of taxonomy.regions) {
    nodeLabels.set(region.id, region.label);

    for (const country of region.countries ?? []) {
      const node = `${region.id}/${country.code}`;
      countries.set(country.code, {
        code: country.code,
        region: region.id,
        node,
        label: country.label,
      });
      nodeLabels.set(node, country.label);

      for (const city of country.cities ?? []) {
        cities.add(`${country.code}/${city.id}`);
        nodeLabels.set(`${node}/${city.id}`, city.label);
      }
      for (const subdivision of country.subdivisions ?? []) {
        subdivisions.add(`${country.code}/${subdivision.code}`);
        nodeLabels.set(`${node}/${subdivision.code}`, subdivision.label);
      }
    }
  }

  return { countries, cities, subdivisions, nodeLabels };
}

/** The taxonomy node a source entry sits under. */
export function nodeFor(entry, taxonomyIndex) {
  if (entry.scope === 'global') {
    return 'global';
  }

  const country = taxonomyIndex.countries.get(entry.country);
  if (!country) {
    return null;
  }
  if (entry.city) {
    return `${country.node}/${entry.city}`;
  }
  if (entry.region) {
    return `${country.node}/${entry.region}`;
  }
  return country.node;
}
