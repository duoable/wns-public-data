# World News Simulator — public data

Data for [World News
Simulator](https://github.com/duoable/World-News-Simulator), published so that
adding an outlet or a language is a pull request rather than an app release.

Two things live here:

- the **news source catalog**. The app ships with a snapshot baked in, so it works
  offline and on first run; **Update source list** fetches the latest revision and
  caches it locally.
- the **interface translations**. These are *not* baked in — the app compiles only
  English, and a viewer who wants another language downloads it from here on the
  Language screen and can remove it again.

There is no server involved. These are static files on a git host.

---

## Layout

```
catalog/
  index.json          Manifest: schema version, revision, and a sha256 per shard.
  taxonomy.json       Regions → countries → cities. Owns the hierarchy.
  sources/
    global.json       Wire services and international outlets.
    europe.json
    americas.json
    asia.json
    africa.json
    middle-east.json
    oceania.json
locales/
  index.json          Manifest: a sha256, a size and a licence per language.
  meta.json           Endonym and licence per language. Not derivable from a catalogue.
  en.json             The reference. Validated against, never downloaded.
  fi.json             A translation.
assets/
  logos/              Publisher logos, referenced by path + sha256.
schema/               JSON Schema (draft 2020-12) for each file above.
scripts/              Validation and link checking. Zero dependencies.
provenance.json       Where every path above came from, and what it may be
                      republished under. Nothing may be added without an entry.
```

Sources are sharded by continental region rather than by country. Two hundred
country files would mean a large manifest and two hundred requests on a cold start;
seven region files mean eight. When a region outgrows roughly five hundred entries,
split it into `europe-1.json` and `europe-2.json` — the manifest lists shards by
path, so that is a data change and the app needs no update.

## Branches

| Branch | Meaning |
| ------ | ------- |
| `main` | Where changes land. May be mid-review. |
| `v1`   | The release channel the app reads. CI fast-forwards it only after validation passes. |

Pinning the app to `v1` means it never sees a half-merged tree, and a bad catalog
can be frozen by simply not moving the branch.

---

## Adding a source

1. Find the right shard for the outlet's country — the country's region is in
   `catalog/taxonomy.json`. Wire services and outlets with no single home country
   go in `global.json`.
2. Add an entry. The fields are described in `schema/shard.schema.json`; a typical
   one looks like this:

   ```json
   {
     "id": "yle-uutiset",
     "name": "Yle Uutiset — Pääuutiset",
     "url": "https://feeds.yle.fi/uutiset/v1/majorHeadlines/YLE_UUTISET.rss",
     "kind": "feed",
     "scope": "national",
     "country": "FI",
     "languages": ["fi"],
     "topics": ["general", "politics"],
     "weight": 0.9,
     "pollIntervalSecs": 300,
     "publisher": "Yle",
     "publisherLink": "https://yle.fi/uutiset",
     "verifiedAt": "2026-08-12"
   }
   ```

3. If the outlet's country or city is not yet in `catalog/taxonomy.json`, add it
   there too.
4. Confirm the feed is actually readable, then regenerate the manifest and check
   your work:

   ```sh
   node scripts/link-check.mjs --shard europe   # fetch it for real
   node scripts/format.mjs                      # one deterministic style
   node scripts/build-index.mjs                 # refresh the hashes
   node scripts/validate.mjs                    # check everything
   ```

5. Open a pull request. CI runs the same formatting, manifest and validation
   checks. It does **not** run the link check — see below.

### Rules that are enforced

- `id` is lowercase, stable, and unique across every shard. It is what a user's
  saved selection refers to, so **renaming an id silently deselects that source for
  everyone.** Treat ids as permanent.
- `url` is `https://` and unique across every shard. Two entries polling one URL
  would double every story from it.
- `pollIntervalSecs` is at least 60. The app clamps it anyway, but a catalog should
  not ask for something impolite.
- `country` is an ISO 3166-1 alpha-2 code that exists in the taxonomy, and is
  required for everything except `"scope": "global"`.
- `city`, when present, exists under that country in the taxonomy.
- `topics` are drawn from the app's ten editorial topics: `world`, `politics`,
  `business`, `science`, `technology`, `health`, `sport`, `culture`, `environment`,
  `general`.
- `verifiedAt` is the date somebody last confirmed the feed was live. Please set it
  when you add or fix an entry.

### What makes a good entry

A feed that publishes headlines with dates and links, updates at least daily, and
is meant to be read by machines. Prefer a publisher's own syndication feed over an
aggregator. Prefer a stable section feed ("World", "Politics") over a firehose.

Do not add a feed that requires a key, sits behind a paywall it does not disclose,
or whose terms forbid syndication. The app displays attribution with a link back on
every story, but that is not a licence to republish.

### Why some obvious outlets are missing

Every entry here was fetched with the app's own User-Agent before it was
committed. A number of well-known publishers are absent because they refuse any
client that does not present itself as a browser — CBC, Nation Africa, IOL and
Kathimerini among them. Their feeds exist and work in a browser; they return
`403`, or never respond at all, to an honestly identified client.

**We do not spoof a browser User-Agent to get around this.** The app identifies
itself truthfully, so a feed that blocks it is a feed the app cannot read, and
listing it would only guarantee every user an error. If you find one of these has
opened up, a pull request restoring it is very welcome.

Reuters and the Associated Press are absent for a simpler reason: both
discontinued their public RSS feeds.

---

## Adding a translation

The app's interface is English in this repository and in the app; every other
language is a file here that a viewer downloads.

1. Copy `locales/en.json` to `locales/<tag>.json`, where `<tag>` is the BCP-47
   language tag — `de`, `pt-BR`. Translate the **values**. Leave every key exactly
   as it is: the keys are the app's and are matched against `en.json` by name.
2. Add a row to `locales/meta.json`:

   ```json
   "de": { "endonym": "Deutsch", "licence": "MIT", "credit": "Your Name" }
   ```

   `endonym` is the language's name **in that language** — Deutsch, not German.
   Somebody opening the language list may be a person who cannot read whatever is
   currently on their screen, which makes a list of English names useless to
   exactly the people who need it. `credit` is optional and is shown beside the
   language in the app.

3. Regenerate and check:

   ```sh
   node scripts/format.mjs                    # one deterministic style
   node scripts/build-locales-index.mjs       # refresh the hashes and sizes
   node scripts/validate.mjs                  # check everything
   ```

4. Open a pull request. CI runs the same three.

### Rules that are enforced

- **Every key in `en.json` is translated, and no key is invented.** A missing key
  is not an error at runtime — i18next silently falls back to English — so a
  half-finished translation looks finished to everybody except the people reading
  it. This is the check the app cannot perform and the main reason validation
  lives here.
- **`{{placeholders}}` match.** A line that drops one renders a sentence with a
  fact missing from it; one that invents a name the app never supplies puts the
  braces themselves on a television. Both are silent at runtime.
- **Plurals are the language's own business.** A key is written `remembered` by
  the app and stored as `remembered_one` and `remembered_other`; which categories
  exist is decided by `Intl.PluralRules`, so Polish having four forms where
  English has two is correct and is not reported. A form English does not have is
  checked for invented placeholders only — what it may leave out is that
  language's grammar, not this repository's business.
- **No empty strings.** A blank line looks like a bug to a viewer and like a
  finished translation to whoever wrote it.
- **A licence is recorded** before a language can be published. See below.

### What is deliberately not translated

Some strings in `en.json` are passed through rather than worded — a publisher's
name, a voice's name, an example JSON path like `data.articles`, key caps such as
`Esc`. They still appear as keys and still need an entry; translating the *format*
rather than the content is usually wrong. The app's `docs/i18n.md` has the list.

Sizes, dates, relative times and lists are **not** in these files at all: they go
through `Intl`, which already knows them for every language.

---

## Logos

`assets/logos/` holds publisher logos, and shard entries may reference one:

```json
"logo": { "path": "assets/logos/yle.svg", "sha256": "…", "license": "trademark" }
```

**The app does not currently display them** — it renders text attribution only. The
field exists so the schema does not have to change when that is built.

Logos are third-party trademarks. They are **not** covered by this repository's
licences, and they are included on the understanding that identifying a publisher by
its mark is nominative use. If you are a rights holder and want your logo removed,
open an issue and it will be.

---

## Licence

| Path | Licence |
| ---- | ------- |
| `catalog/`, and this README | [CC0 1.0](LICENSE-DATA) — public domain dedication |
| `locales/` | Per language, named in `locales/meta.json`. MIT unless a translator says otherwise. |
| `scripts/`, `schema/`, `.github/` | [MIT](LICENSE) |
| `assets/logos/` | Third-party trademarks. Neither licence applies. See above. |

### Nothing arrives here without its terms

This repository is **public and permanent**. Committing to it is republishing,
and a public repository cannot be un-published by deleting a file — so the table
above is not the source of truth. [`provenance.json`](provenance.json) is: it
records, for every path, what the files are, who wrote them, and what they may be
redistributed under. `scripts/validate.mjs` reads it and **fails on any file no
entry covers**, so CI refuses a pull request that adds data nobody has accounted
for.

There is deliberately **no catch-all entry**. Adding a directory means adding an
entry, and that is the whole mechanism: the check cannot verify that a licence is
being honoured, but it can guarantee that somebody had to write down which one
applies before the data could be merged.

An entry says how the data reached us, and that decides what else it must carry:

| `origin` | Also required | For |
| -------- | ------------- | --- |
| `ours` | `licence` | The catalog, the tooling, the English reference. |
| `contributed` | `termsRecordedIn` | Translations — one licence cannot describe them all, so the terms live per language in `locales/meta.json`. |
| `thirdParty` | `source`, `sourceLicence`, `attribution`, `redistribution` | Anything taken from outside. |

`redistribution` is the field that matters. It is a sentence, written by a
person, saying **why republishing this is permitted** — naming the clause or the
grant it rests on. Nothing checks that the sentence is true; what is enforced is
that it cannot be skipped.

Two things follow from this that are worth knowing before adding anything.
**A licence that permits use does not necessarily permit redistribution**, which
is the distinction this repository exists on the wrong side of by default —
everything here is fetched and stored on a viewer's device. And **if the terms
are unclear, ask before committing.** Reverting a commit does not unpublish it.

`assets/logos/` is described above and has rules in `.gitattributes`, but nothing
is committed there and it has no entry. That is on purpose: a publisher's mark is
a trademark rather than a licensable work, and the first commit of one will fail
validation until somebody writes down what it rests on.

The catalog is a table of facts — names, URLs, countries. CC0 waives the EU
*sui generis* database right along with everything else, so anyone can reuse the
list without asking. A share-alike licence would have propagated into every
downstream consumer, which is the opposite of what a list like this is for.

**Translations are not a table of facts.** A translation is somebody's writing and
is theirs to licence, so `locales/` is not CC0 by default and the terms are
recorded per language rather than assumed for the directory. MIT is the default
because that is what the app it translates is, and because it is what a
contribution to an MIT application ordinarily is — but a translator who wants
different terms says so in `meta.json`, the app carries that licence with the file
it downloads, and it is shown on the Language screen. `build-locales-index.mjs`
refuses to publish a language with no licence recorded, so this cannot be
forgotten.
