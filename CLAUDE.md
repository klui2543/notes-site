# notes-site

Publishes a hand-picked subset of the Obsidian vault **"Klui's Database"** to
GitHub Pages using Quartz v5.

- Vault (source of truth): Google Drive → `Obsidian/Klui's Database`
  - on the Windows PC it is mounted at `G:\My Drive\Obsidian\Klui's Database`
  - Drive folder id: `1KnQ8uRROg9KUBb3N7fK3pSEqwdhpIaVq`
  - there is a *second*, unrelated vault at `Obsidian/New Vault` — never sync from it
- Site: <https://klui2543.github.io/notes-site/>
- `content/` and `drawings-src/` are **generated**. Never hand-edit them.

---

## The rule that matters most

**A note reaches the web only if it says so itself.** Everything in the vault is
private by default: personal finances, shift schedules, hospital-internal
procedure notes, and the six main projects.

A note is published when, and only when, it has one of:

- frontmatter `publish: true`
- `publish` in its frontmatter `tags:`
- a literal `#publish` tag in the body

`publish: false` overrides everything.

Two independent gates enforce this:

1. **`scripts/sync.mjs`** decides what is ever copied into `content/`. This is
   the real gate — static assets (images, SVG, canvases) are emitted by Quartz
   unconditionally, so anything that lands in `content/` is public.
2. **`@quartz-community/explicit-publish`** makes Quartz refuse to emit a
   markdown page without `publish: true`. Backstop only; do not disable it.

`scripts/sync.mjs` also carries a `DENY_PATTERNS` list that refuses paths under
the financial / hospital / personal-schedule trees **even if tagged**. If a
deliberate publish is blocked, the script says so and names the pattern.

### Never do these

- Do not add files to `content/` by hand.
- Do not relax the publish check to "make the site less empty".
- Do not publish a `.canvas` without reading what its nodes point at: canvas
  nodes with `portal: true` inline another file's entire contents, so an
  unfiltered canvas leaks every file it references, transitively. `sync.mjs`
  drops nodes that resolve to anything unpublished — keep it that way.

---

## Routine task: "sync และ publish Obsidian vault ขึ้นเว็บ"

### From the PC (vault mounted at `G:`)

```bash
node scripts/sync.mjs && git add -A && git commit -m "sync: publish notes" && git push
```

`sync.mjs` finds the vault automatically. Read its report before pushing — it
lists every published file, every blocked file, and every dropped link.

Preview locally first with `npx quartz build --serve` (drawings will show as
broken images unless Chromium is installed; that is expected — see below).

### From a phone — press a button (preferred)

Repo → **Actions** → **Sync vault and publish** → **Run workflow**.

`.github/workflows/sync.yml` fetches the vault from Drive with a service
account, runs the publish gate, commits anything that changed, and deploys. No
connector, no staging by hand, no PC. Setup is one-time:

1. Google Cloud console → new project → enable the **Google Drive API**.
2. Create a **service account**; no roles are needed — it is authorised by
   sharing, not by IAM. Create a **JSON key** for it.
3. In Drive, share the vault folder with the service account's
   `…@….iam.gserviceaccount.com` address as **Viewer**. Share *only* that
   folder: the key grants whatever the account can see.
4. Repo → Settings → Secrets and variables → Actions → new secret
   **`GDRIVE_SERVICE_ACCOUNT_JSON`**, pasting the whole key file.

The workflow downloads the *entire* vault, private notes included, into
`_vault/` on the runner. That is safe only because `_vault/` is gitignored,
`sync.mjs` refuses to run if it ever stops being, and the job asserts afterwards
that nothing under `_vault/` became tracked. Keep all three.

`scripts/fetch-vault.mjs` verifies every download against the `size` and
`md5Checksum` Drive reports, and fails the run if any file is short — the exact
failure the connector produces silently.

### From a phone via the Drive connector (fallback, no setup)

There is no Drive mount, so stage the vault first:

1. Use the Google Drive connector to walk the vault, starting from folder id
   `1KnQ8uRROg9KUBb3N7fK3pSEqwdhpIaVq`. To narrow the search, Drive full-text
   search does index `.md` bodies:
   `fullText contains 'publish' and mimeType = 'text/markdown'`
   — but that also matches files in other folders, so **verify each hit's
   ancestry walks up to the vault folder id** before trusting it.
2. Write the candidates into `_vault/`, preserving their vault-relative paths.
   Also stage any attachment or `.excalidraw` file they embed.
3. `node scripts/sync.mjs --vault _vault`
4. Commit and push.

`_vault/` is gitignored — it holds unpublished notes and must never be committed.
`sync.mjs` refuses to run if it is not, so do not "fix" that by deleting the
check. Note that upstream Quartz's `.gitignore` contains a `.gitignore` entry
which makes the file ignore *itself*; if that line ever comes back, `git add -A`
will stop tracking it and the repo silently loses all ignore rules.

**Drive connector caveat.** `download_file_content` truncates at roughly 11.5 KB
and reports success anyway. A truncated note still parses, still carries its
publish marker, and still syncs — it just loses its tail. The one time this was
caught, it was luck: the file happened to hold a compressed Excalidraw payload,
which fails loudly when it cannot decompress. Prose would have gone straight
through. `read_file_content` returns the whole file, but as a text rendering, so
it is not guaranteed byte-exact.

**You do not have to catch this by hand.** Every sync writes `sync-manifest.json`
recording the size and hash of each source file it consumed. When the vault is a
directory inside the repo — i.e. staged rather than mounted — the next sync
checks the stage against it and refuses to write anything if either:

- a staged file is **smaller** than it was last time (truncation), or
- a file that was published last time is **missing** from the stage — which
  matters because sync rebuilds `content/` from scratch, so a partial stage
  silently unpublishes whatever it left out.

Both are real situations sometimes, so both have an escape hatch — but they have
to be stated rather than assumed: `--allow-shrink` and `--allow-missing`.

The manifest is keyed by a *hash* of each vault path, never the path itself: it
is committed to a public repo, and the vault's folder names are exactly what the
output paths go out of their way to strip.

When a large note does get truncated, the cheapest fix is usually to avoid the
download entirely: compare the Drive file's `modifiedTime` against the last sync
commit, and if the note has not changed, regenerate it from what is already
committed. Confirm either way by re-running sync and checking `content/` and
`drawings-src/` come out byte-identical — that round-trip has already caught a
single wrong character in a hand-transcribed payload.

Staging only *candidate* files is fine: sync re-checks the publish marker on
everything it sees, and a note that is missing from `_vault/` simply does not get
published that round. But note the consequence — **sync wipes `content/` and
rebuilds it**, so a partial stage will *unpublish* anything it left out. When in
doubt stage the whole vault.

### Un-publishing

Remove the marker in the vault (`node scripts/tag-publish.mjs --vault <path>
--remove "<note>"`), then sync as usual. Sync empties `content/` on every run, so
the page disappears on the next deploy.

---

## Excalidraw

The vault's Excalidraw plugin is configured with `compress: true`, so drawings
appear in three shapes, all handled by `scripts/lib/excalidraw.mjs`:

| shape | where the scene lives |
|---|---|
| `<name>.excalidraw` | the whole file is the scene JSON |
| `<name>.excalidraw.md` | a ` ```compressed-json ` block (LZ-String base64) |
| any `.md` with `excalidraw-plugin:` frontmatter | a ` ```json ` block |

A drawing note is emitted as a page containing only the rendered SVG — the
plugin's "Excalidraw Data" section (a plain-text dump of every label in the
drawing) is stripped.

**Rendering happens in CI, not at sync time.** `exportToSvg` is a browser API,
so `scripts/render-drawings.mjs` bundles Excalidraw with esbuild and drives it in
headless Chromium. GitHub Actions already has Chromium; a phone does not. Flow:

```
sync.mjs   →  drawings-src/<slug>.excalidraw.json   (committed)
CI         →  content/assets/drawings/<slug>.svg    (built, not committed)
```

To check the exporter without installing a browser:

```bash
node scripts/render-drawings.mjs --harness harness.html
```

then open `harness.html` over http (a `file://` URL will not work).

Consequence: a local `npx quartz build` shows drawings as broken images unless
you run `npx playwright install chromium` first. The deployed site is fine.

---

## Layout

```
content/                 generated — the published subset
drawings-src/            generated — Excalidraw scenes staged for CI
scripts/sync.mjs         THE PRIVACY GATE: vault → content/
scripts/tag-publish.mjs  add/remove `publish: true` in the vault
scripts/render-drawings.mjs  Excalidraw → SVG (CI)
scripts/lib/excalidraw.mjs   scene extraction for all three formats
quartz.config.yaml       site config (overrides quartz.config.default.yaml)
.github/workflows/deploy.yml  build + deploy to Pages on push to main
```

`sync.mjs` trims meaningless leading path segments (`📁 Folder`, `หลังบ้าน`,
`Archive`, …) from output paths, both to keep URLs short and to avoid publishing
the vault's private folder taxonomy. It backs out to the full path if trimming
would make two notes collide — see `STRIP_SEGMENTS`.

## Useful commands

```bash
node scripts/sync.mjs --dry-run --verbose        # see decisions, write nothing
node scripts/tag-publish.mjs --vault <path> --list   # what is currently tagged
```
