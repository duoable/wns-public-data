#!/usr/bin/env node
/**
 * Fetches every feed in the catalog and reports the ones that no longer work.
 *
 * Run before adding entries, and weekly in CI. It is deliberately **not** part
 * of `validate.mjs`: a publisher having a bad afternoon must not block an
 * unrelated pull request, and a pull request must not depend on the open
 * internet being reachable.
 *
 * Politeness, which is not optional here — these are other people's servers:
 *   - one request per host at a time, with a gap between them;
 *   - conditional GET, so a repeat run costs the publisher almost nothing;
 *   - an honest User-Agent naming the project and linking to it;
 *   - the response body is read only far enough to tell it is a feed.
 *
 * Usage:
 *   node scripts/link-check.mjs                 check everything
 *   node scripts/link-check.mjs --shard europe  check one shard
 *   node scripts/link-check.mjs --json          machine-readable report
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { absolute, readJson, shardPaths } from './lib/catalog.mjs';

const USER_AGENT =
  'WorldNewsSimulatorCatalogBot/1.0 (+https://github.com/duoable/wns-public-data)';
const REQUEST_TIMEOUT_MS = 20_000;
const PER_HOST_GAP_MS = 1_100;
const MAX_HOSTS_IN_PARALLEL = 12;
const CACHE_PATH = '.link-check-cache.json';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const shardFilter = args.includes('--shard') ? args[args.indexOf('--shard') + 1] : null;

/** Reads validators from the last run so a repeat check can be conditional. */
function loadCache() {
  try {
    return JSON.parse(readFileSync(absolute(CACHE_PATH), 'utf8'));
  } catch {
    return {};
  }
}

/** Decides whether a payload is actually a feed, not an HTML error page. */
function looksLikeFeed(text, contentType) {
  const head = text.slice(0, 4000).toLowerCase();

  if (/<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head)) {
    return { ok: true, format: head.includes('<feed') ? 'atom' : 'rss' };
  }

  if (contentType.includes('json') || head.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.version?.startsWith?.('https://jsonfeed.org/')) {
        return { ok: true, format: 'jsonfeed' };
      }
    } catch {
      // Falls through to the failure below.
    }
  }

  if (/<!doctype html|<html[\s>]/.test(head)) {
    return { ok: false, reason: 'served an HTML page, not a feed' };
  }

  return { ok: false, reason: `unrecognised payload (content-type: ${contentType || 'none'})` };
}

async function check(entry, cached) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.8, */*;q=0.5' };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(entry.url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    const validators = {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };

    if (response.status === 304) {
      return { id: entry.id, status: 'ok', code: 304, note: 'unchanged since last check', validators };
    }

    if (!response.ok) {
      return { id: entry.id, status: 'failed', code: response.status, reason: `HTTP ${response.status}` };
    }

    const text = await response.text();
    const verdict = looksLikeFeed(text, response.headers.get('content-type') ?? '');

    if (!verdict.ok) {
      return { id: entry.id, status: 'failed', code: response.status, reason: verdict.reason };
    }

    const result = {
      id: entry.id,
      status: 'ok',
      code: response.status,
      format: verdict.format,
      bytes: text.length,
      validators,
    };

    if (response.url !== entry.url) {
      result.redirectedTo = response.url;
    }

    return result;
  } catch (error) {
    const reason = error.name === 'AbortError' ? `no response in ${REQUEST_TIMEOUT_MS / 1000}s` : error.message;
    return { id: entry.id, status: 'failed', reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the queues for one host in order, pausing between requests. */
async function drainHost(entries, cache, onResult) {
  const results = [];
  for (const [index, entry] of entries.entries()) {
    if (index > 0) {
      await new Promise((done) => setTimeout(done, PER_HOST_GAP_MS));
    }
    const result = await check(entry, cache[entry.id]);
    results.push(result);
    onResult(result, entry);
  }
  return results;
}

// ------------------------------------------------------------------- run

const entries = [];
for (const path of shardPaths()) {
  const id = basename(path, '.json');
  if (shardFilter && id !== shardFilter) continue;
  for (const entry of readJson(path).sources) {
    entries.push({ ...entry, shard: id });
  }
}

if (entries.length === 0) {
  console.error(shardFilter ? `No shard named "${shardFilter}".` : 'No sources to check.');
  process.exit(1);
}

const byHost = new Map();
for (const entry of entries) {
  const host = new URL(entry.url).host;
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(entry);
}

const cache = loadCache();
const results = [];
let done = 0;

function report(result, entry) {
  done += 1;
  if (asJson) return;
  const mark = result.status === 'ok' ? 'ok  ' : 'FAIL';
  const detail =
    result.status === 'ok'
      ? `${result.code} ${result.format ?? ''}${result.redirectedTo ? ` → ${result.redirectedTo}` : ''}`
      : result.reason;
  console.log(`[${String(done).padStart(3)}/${entries.length}] ${mark} ${entry.id.padEnd(28)} ${detail}`);
}

const hostQueues = [...byHost.entries()];
const workers = Array.from({ length: Math.min(MAX_HOSTS_IN_PARALLEL, hostQueues.length) }, async () => {
  for (;;) {
    const next = hostQueues.shift();
    if (!next) return;
    results.push(...(await drainHost(next[1], cache, report)));
  }
});

await Promise.all(workers);

const failures = results.filter((result) => result.status === 'failed');
const nextCache = { ...cache };
for (const result of results) {
  if (result.status === 'ok' && result.validators) {
    nextCache[result.id] = result.validators;
  }
}
writeFileSync(absolute(CACHE_PATH), `${JSON.stringify(nextCache, null, 2)}\n`, 'utf8');

if (asJson) {
  console.log(JSON.stringify({ checked: results.length, failures }, null, 2));
} else {
  const redirects = results.filter((result) => result.redirectedTo);
  if (redirects.length > 0) {
    console.log(`\n${redirects.length} feed(s) redirected — consider updating the catalog URL:`);
    for (const result of redirects) {
      console.log(`  ${result.id}\n    → ${result.redirectedTo}`);
    }
  }

  console.log(`\nChecked ${results.length} feeds across ${byHost.size} hosts. ${failures.length} failed.`);
  for (const failure of failures) {
    console.log(`  ${failure.id}: ${failure.reason}`);
  }
}

// Exit 0 even with failures: this script reports, it does not gate. CI turns a
// non-empty failure list into an issue.
