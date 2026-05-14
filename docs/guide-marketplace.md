# ClawdCursor Guides Marketplace

Status: design + client implementation shipped in v0.9 Phase 3. The
server-side GitHub repo (`clawdcursor/clawdcursor-guides`) is the contract
this client expects to talk to; this doc is the spec for setting it up.

## Why

clawdcursor's blind/hybrid/vision agents reason about every app from
screenshots and a11y trees. That works for any app on the planet, but it's
slow and brittle for popular apps where the keyboard shortcuts, workflow
patterns, and failure modes are well-known. Bundling that knowledge inside
the binary gives a free 5-10× speedup for those apps — but bundling every
known app inflates the binary and the bundle lags behind UI changes.

**The marketplace separates the binary release cycle from the knowledge
release cycle.** clawdcursor ships minimum core knowledge (currently
msedge + notepad) and fetches the rest on demand from a public GitHub
repo. Community contributions land via Pull Requests. Frequently-used
guides survive in a local LRU cache; rare ones get re-fetched when
needed. The agent never blocks on the network — if a guide isn't local
and the registry is unreachable, the agent reasons from first principles
like it does for any unknown app.

## Wire diagram

```
Agent run                                              Local              Remote
─────────                                              ─────              ──────
preprocess(task, ctx)
  └─ detectApp(activeWindow.title) → "youtube"
  └─ prefetchGuideForApp("youtube")  ─── async ───────────────────────►  GET /guides/youtube.json
                                                                          │
loadGuide("youtube")                                                      │
  ├─ in-memory cache?         no                                          │
  ├─ ~/.clawdcursor/ui-knowledge/youtube.json?  no  (learn_app override)  │
  ├─ ~/.clawdcursor/guide-cache/youtube.json?   no  (first encounter)     │
  └─ src/llm/knowledge/guides/youtube.json?     no  (not in minimum core) │
  → null                                                                   │
                                                                          ▼
                                                                       lintGuide(payload)
                                                                          │ pass
                                                                          ▼
                                                                       setCached("youtube", …)
                                                                       (TTL 7d, LRU 50)

Next task involving YouTube
  loadGuide("youtube")
  ├─ in-memory cache? no
  ├─ user-override?   no
  └─ ~/.clawdcursor/guide-cache/youtube.json? YES  ← from prefetch
     → adopt + lint defense-in-depth → return guide → ★ render to prompt
```

## Cache locations

| Path | Purpose | Writer | Reader |
|------|---------|--------|--------|
| `src/llm/knowledge/guides/` | Bundled minimum core. Shipped in the binary. | maintainer commits | `loadGuide` last-resort fallback |
| `seed-registry/guides/` | Source files for the GitHub registry. Not bundled. | maintainer commits | uploaded to the GitHub repo |
| `~/.clawdcursor/guide-cache/` | LRU + TTL cache populated by `fetchGuide`. | `setCached` (auto) | `loadGuide` second-priority |
| `~/.clawdcursor/ui-knowledge/` | User overrides + `learn_app` writes. | `saveLearnedLesson`, `mergeIntoUserGuide` | `loadGuide` highest-priority |

`CLAWD_HOME` overrides `~/` for both cache locations.

## GitHub repo layout (`clawdcursor/clawdcursor-guides`)

```
clawdcursor-guides/
├── README.md                Submission + maintainer flow
├── CONTRIBUTING.md          PR template + review SLAs
├── CODEOWNERS               Required reviewers for guides/* changes
├── guides/
│   ├── youtube.json
│   ├── reddit.json
│   ├── notion.json
│   └── …
├── index.json               Aggregated metadata (auto-generated, see below)
└── .github/
    ├── workflows/
    │   ├── validate.yml     Runs schema + lint on every PR
    │   └── aggregate.yml    Builds index.json from guides/ + vote issues
    └── ISSUE_TEMPLATE/
        └── vote.yml         "vote: <app>" issue template (👍/👎 source)
```

### `guides/{app}.json`

The same `AppGuide` schema as the bundled guides. See
[`src/core/pipeline-types.ts`](../src/core/pipeline-types.ts) and
[`seed-registry/guides/youtube.json`](../seed-registry/guides/youtube.json)
for a reference example. Required fields: `app`, plus at least one of
`shortcuts` / `workflows` / `tips` / `layout`. The client linter at
[`src/llm/knowledge/guide-linter.ts`](../src/llm/knowledge/guide-linter.ts)
runs both client-side (defense-in-depth) and as the validate.yml CI step.

### `index.json`

Auto-generated from `guides/` content + vote-issue reactions. Schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-13T12:34:56Z",
  "guides": {
    "youtube": {
      "version": "1.2.0",
      "trust": "verified",
      "upvotes": 42,
      "downvotes": 1,
      "submitter": "@user",
      "etag": "..."
    }
  }
}
```

- `trust`: `verified` (curated by maintainers), `community` (vetted but
  user-contributed), `experimental` (un-vetted, opt-in). Maintainers set
  the level on PR merge via a label.
- `upvotes` / `downvotes`: count of 👍 / 👎 reactions on the corresponding
  `vote: <app>` issue. Aggregated nightly.
- `version`: semver, bumped on each merged PR.
- `etag`: content hash, used by the client for conditional GETs.

### Voting

Each guide has a corresponding GitHub Issue titled `vote: <app>`,
created automatically when the guide is first merged. Voters react with
👍 or 👎 on the issue. The aggregate.yml workflow counts reactions and
writes the totals into `index.json`. Native GitHub identity means voters
are rate-limited + bot-resistant without us building user accounts.

## Trust model

- **verified**: curated by maintainers. Default trust level the client
  accepts. ~12 guides on launch.
- **community**: user-submitted via PR, passed CI lint + schema, merged
  by a maintainer. Fetched if `CLAWD_TRUST_COMMUNITY_GUIDES=1` or the
  user enabled it through the doctor flow.
- **experimental**: same as community but the maintainer flagged it as
  unstable / un-vetted. Fetched only when explicitly requested by app
  name (`clawdcursor guides install youtube-experimental`).

Every guide loaded — bundled, cached, user-override, or freshly fetched
— runs through `lintGuide` before injection into the agent prompt.
Defense-in-depth catches:
- Schema violations (missing required fields, wrong types)
- Prompt-injection patterns ("ignore previous instructions", fake `<system>` tags, persona overrides)
- Dangerous prose (unconditional delete/transfer/purchase verbs, "never confirm" patterns)
- Domain hints that look like URLs / paths (must be bare domains)
- Oversize files (>64 KB → rejected)

A guide that fails lint is silently dropped. The agent falls back to
first-principles reasoning, same as for any unknown app.

## Client behavior

### Fetch policy
1. First call for an app this session: check disk cache.
2. Cache fresh (<7 days): use it, increment usageCount.
3. Cache stale OR missing: fire `prefetchGuideForApp(app)` in the
   background. Current task uses whatever's local; next task gets fresh.
4. Cache miss + bundled exists: bundled wins for current task.
5. Cache miss + no bundle + remote available: blocking fetch — first
   touch is slower but every subsequent touch is fast.
6. Network unreachable + stale cache: serve stale (offline tolerance).

### Cache eviction
- LRU with 50-entry cap (see `CACHE_INTERNALS.LRU_CAPACITY`).
- `usageCount` bumps reorder LRU on every cache hit — popular guides
  survive even when not most-recently-fetched.
- Per-file size cap 256 KB. Total cache size bounded by 50 × 256 KB = 12 MB.

### Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `CLAWD_GUIDES_REGISTRY_URL` | `https://raw.githubusercontent.com/clawdcursor/clawdcursor-guides/main` | Base URL for fetches |
| `CLAWD_GUIDES_REGISTRY_OFF` | unset | `1` to disable all remote fetches (bundled-only mode) |
| `CLAWD_GUIDES_FETCH_TIMEOUT` | `4000` | Fetch timeout in ms |
| `CLAWD_BUNDLED_GUIDES_DIR` | the build dir | Override bundle path (used by tests) |
| `CLAWD_HOME` | `~/` | Cache + user-override root |
| `CLAWD_GUIDES_REPO_URL` | the GH repo | Used by `submit` instruction strings |

## CLI

See `clawdcursor guides help` — implementation at
[`src/llm/guide-registry.ts`](../src/llm/guide-registry.ts).

```
clawdcursor guides list                 What's cached + ratings
clawdcursor guides info <app>           Cache metadata for one app
clawdcursor guides available            Browse the registry index
clawdcursor guides install <app>        Pre-warm the cache
clawdcursor guides install --all        Pre-warm everything (offline prep)
clawdcursor guides refresh <app>        Force re-fetch
clawdcursor guides remove <app>         Evict one
clawdcursor guides clean                Wipe cache
clawdcursor guides lint <file.json>     Validate a local JSON
clawdcursor guides submit <file.json>   Print PR instructions
```

## Migration plan

Phase 3 (this commit):
- Client: linter, cache, remote-loader, CLI rewrite all shipped.
- Bundle: trimmed to msedge + notepad. The other 10 curated guides
  moved to `seed-registry/guides/` — the source files for the GitHub repo.

Next steps (separate from this commit):
1. Create the `clawdcursor/clawdcursor-guides` GitHub repo.
2. Seed `guides/` from `seed-registry/guides/` (10 files: gmail, outlook,
   slack, youtube, figma, discord, excel, mspaint, olk, spotify).
3. Add `index.json` with all 10 marked `trust: verified`.
4. Wire `validate.yml` to run the same `lintGuide` we ship in the client.
5. Wire `aggregate.yml` to read `vote: <app>` issue reactions nightly.
6. Document submission flow in `CONTRIBUTING.md`.

Once the repo is live, no further client changes are needed — the agent
already fetches from `CLAWD_GUIDES_REGISTRY_URL` by default.
