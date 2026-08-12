# World News Simulator — public data

The news source catalog for [World News
Simulator](https://github.com/duoable/World-News-Simulator), published as data so
that adding an outlet is a pull request rather than an app release.

The app ships with a snapshot of this catalog baked in, so it works offline and on
first run. **Update source list** in the app's settings fetches the latest revision
from this repository and caches it locally.

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
assets/
  logos/              Publisher logos, referenced by path + sha256.
schema/               JSON Schema (draft 2020-12) for each file above.
scripts/              Validation and link checking. Zero dependencies.
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
| `scripts/`, `schema/` | [MIT](LICENSE) |
| `assets/logos/` | Third-party trademarks. Neither licence applies. See above. |

The catalog is a table of facts — names, URLs, countries. CC0 waives the EU
*sui generis* database right along with everything else, so anyone can reuse the
list without asking. A share-alike licence would have propagated into every
downstream consumer, which is the opposite of what a list like this is for.
