# notes-site

Selected notes from a personal Obsidian vault, published with
[Quartz](https://quartz.jzhao.xyz) to <https://klui2543.github.io/notes-site/>.

The vault itself is private. A note appears here only when it is explicitly
marked `publish: true` (or tagged `#publish`); `scripts/sync.mjs` copies nothing
else into `content/`, and Quartz's `explicit-publish` filter refuses to render a
page that lacks the marker.

## How it works

```
Obsidian vault (Google Drive)
        │  node scripts/sync.mjs      ← filters, rewrites links, stages drawings
        ▼
   content/  +  drawings-src/          ← committed
        │  git push
        ▼
   GitHub Actions                      ← renders Excalidraw → SVG, builds Quartz
        ▼
   GitHub Pages
```

`content/` and `drawings-src/` are generated — do not edit them by hand.

See [CLAUDE.md](CLAUDE.md) for the full runbook, including how to sync from a
phone and how the Excalidraw and Canvas handling works.

---

Built on Quartz v5 (MIT) — see [LICENSE.txt](LICENSE.txt).
