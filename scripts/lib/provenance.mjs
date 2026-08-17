/**
 * Holds every published file to a recorded origin and licence.
 *
 * The repository is public and permanent, so committing to it is republishing.
 * That makes an undeclared file the one failure worth failing the build over:
 * everything else here can be corrected in the next commit, and a licence
 * somebody else's work was published in breach of cannot be.
 *
 * So `provenance.json` declares what covers what, and this refuses a file that
 * nothing covers. There is no catch-all entry by design — the check
 * only works because the answer to "what may this be published under" has to be
 * written before the data can be merged.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { absolute, readJson, REPO_ROOT } from './catalog.mjs';

/** Repository-relative path to the declaration. */
export const PROVENANCE_PATH = 'provenance.json';

/** What each origin must record beyond the fields every dataset carries. */
const REQUIRED_BY_ORIGIN = {
  ours: ['licence'],
  contributed: ['termsRecordedIn'],
  thirdParty: ['licence', 'source', 'sourceLicence', 'attribution', 'redistribution'],
};

/** Fields naming another file in this repository, which therefore must exist. */
const PATH_FIELDS = ['licenceFile', 'termsRecordedIn'];

/**
 * Every file this repository would publish, repository-relative.
 *
 * Git rather than a directory walk, so `.gitignore` does not have to be
 * reimplemented here — a local link-check cache is not published and must not be
 * reported as undeclared.
 *
 * Tracked **and** untracked-but-not-ignored, which is the part worth reading. A
 * file that has only been written is not published yet, so checking the index
 * alone would be defensible — and would move every one of these failures from
 * the author's terminal to CI, after the commit that is the thing this exists to
 * prevent. The moment a file appears is the moment its terms are cheapest to
 * settle.
 */
export function publishableFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  // `--cached --others` can name one path twice once a new file is staged.
  return [...new Set(output.split('\0').filter((path) => path !== ''))];
}

/**
 * How specifically `dataset` claims `file`, or `null` when it does not.
 *
 * The length of the matching pattern, so an exact file beats the directory it
 * sits in and a deeper directory beats a shallower one — which is what lets the
 * English reference catalogue carry different terms from the translations
 * around it. Two entries matching equally specifically is not resolved here; it
 * is reported, because at that point nobody can say which terms apply.
 */
function specificity(dataset, file) {
  let best = null;

  for (const pattern of dataset.paths) {
    const matched = pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern;
    if (matched && (best === null || pattern.length > best)) {
      best = pattern.length;
    }
  }

  return best;
}

/**
 * Checks the declaration and the files it claims to cover.
 *
 * `fail` is called with one sentence per problem, in the caller's own style.
 * Returns how many files were covered, for the summary line.
 */
export function checkProvenance(fail, checkAgainstSchema) {
  const document = readJson(PROVENANCE_PATH);
  checkAgainstSchema(PROVENANCE_PATH, document, readJson('schema/provenance.schema.json'));

  const datasets = document.datasets ?? [];
  const seenIds = new Set();

  for (const dataset of datasets) {
    const where = `${PROVENANCE_PATH} [${dataset.id}]`;

    if (seenIds.has(dataset.id)) {
      fail(`${where}: two datasets share this id`);
    }
    seenIds.add(dataset.id);

    for (const field of REQUIRED_BY_ORIGIN[dataset.origin] ?? []) {
      if (dataset[field] === undefined) {
        fail(
          `${where}: is "${dataset.origin}" and must therefore record "${field}". ` +
            `See the field's description in schema/provenance.schema.json for what it is asking for.`,
        );
      }
    }

    for (const field of PATH_FIELDS) {
      const named = dataset[field];
      if (named !== undefined && !existsSync(absolute(named))) {
        fail(`${where}: names ${field} "${named}", which does not exist`);
      }
    }

    // A stale path is as bad as a missing one: it makes the declaration look
    // like it covers more than it does, and the next person reads the coverage
    // rather than the repository.
    for (const pattern of dataset.paths) {
      if (!existsSync(absolute(pattern.replace(/\/$/, '')))) {
        fail(`${where}: claims "${pattern}", which does not exist. Remove it or restore the file.`);
      }
    }
  }

  let files;
  try {
    files = publishableFiles();
  } catch {
    fail(
      `${PROVENANCE_PATH}: cannot list the repository's files, so nothing could be checked against it. ` +
        `This check needs a git checkout and the "git" command on PATH.`,
    );
    return 0;
  }

  let covered = 0;

  for (const file of files) {
    const claims = datasets
      .map((dataset) => ({ dataset, depth: specificity(dataset, file) }))
      .filter(({ depth }) => depth !== null);

    if (claims.length === 0) {
      fail(
        `${file} is published by this repository and no entry in ${PROVENANCE_PATH} covers it. ` +
          `Add one saying where it came from and what it may be redistributed under — ` +
          `and if it is not ours, answer "redistribution" before committing it.`,
      );
      continue;
    }

    const deepest = Math.max(...claims.map(({ depth }) => depth));
    const winners = claims.filter(({ depth }) => depth === deepest);

    if (winners.length > 1) {
      const ids = winners.map(({ dataset }) => `"${dataset.id}"`).join(' and ');
      fail(
        `${file} is claimed equally by ${ids} in ${PROVENANCE_PATH}, so its terms are ambiguous. ` +
          `Make one of them more specific.`,
      );
      continue;
    }

    covered += 1;
  }

  return covered;
}
