#!/usr/bin/env node
/**
 * Obsidian vault -> Quartz `content/` sync.
 *
 * THIS SCRIPT IS THE PRIMARY PRIVACY GATE.
 *
 * Quartz's `@quartz-community/explicit-publish` plugin is a useful second line
 * of defence, but it only filters *markdown pages*: images, SVGs, canvases and
 * every other static asset that lands in `content/` is emitted to the site
 * unconditionally. So nothing may be copied into `content/` unless this script
 * has positively cleared it.
 *
 * A note is published only when it says so, explicitly:
 *   - frontmatter `publish: true`  (or the string "true"), or
 *   - the tag `publish` in frontmatter `tags:`, or
 *   - a literal `#publish` tag in the body (outside code fences)
 * `publish: false` always wins. Everything unmarked stays private.
 *
 * Usage:
 *   node scripts/sync.mjs [--vault <path>] [--dry-run] [--verbose]
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { parseExcalidraw, embeddedFileCount } from "./lib/excalidraw.mjs"

const REPO = path.resolve(import.meta.dirname, "..")
const OUT = path.join(REPO, "content")
const DRAWINGS_SRC = path.join(REPO, "drawings-src")
const ASSETS_SUBDIR = "assets"
const DRAWINGS_SUBDIR = "assets/drawings"

/** Vault directories that never contain publishable notes. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".smart-env", ".git", "node_modules"])

/**
 * Belt-and-braces denylist. Even a note that is explicitly tagged is refused if
 * its vault path matches one of these, because these trees hold the financial,
 * personal-schedule and hospital-internal material that must never reach the web.
 * Remove an entry here (deliberately) if you really do want to publish from it.
 */
const DENY_PATTERNS = [
  /(^|\/)Financial(\/|$)/i,
  /(^|\/)Financial plan(\/|$)/i,
  /Financial research/i,
  /Stock analysis framework/i,
  /(^|\/)Siriraj/i,
  /ศิริราช/,
  /SiRxShift/i,
  /ตารางงานประจำเดือน/,
  /Life OS/i,
]

const IMAGE_EXTS = new Set([
  ".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".avif", ".bmp",
])

/**
 * Leading path segments that are vault filing structure rather than anything a
 * reader cares about. Stripping them keeps URLs short and avoids broadcasting
 * the vault's private folder taxonomy. Applied only while the result stays
 * unique - on a collision the full path is kept.
 */
const STRIP_SEGMENTS = ["📁 Folder", "หลังบ้าน", "Archive", "จัดการงานและชีวิต"]

function trimVaultPath(rel) {
  const parts = rel.split("/")
  while (parts.length > 1 && STRIP_SEGMENTS.includes(parts[0])) parts.shift()
  return parts.join("/")
}

/** Trim every path, backing out to the full path for anything that collides. */
function planOutputPaths(rels) {
  const proposed = new Map()
  const counts = new Map()
  for (const rel of rels) {
    const t = trimVaultPath(rel)
    proposed.set(rel, t)
    counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1)
  }
  const final = new Map()
  for (const [rel, t] of proposed) {
    final.set(rel, counts.get(t.toLowerCase()) > 1 ? rel : t)
  }
  return final
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, verbose: false, vault: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--verbose" || a === "-v") args.verbose = true
    else if (a === "--vault") args.vault = argv[++i]
    else if (a.startsWith("--vault=")) args.vault = a.slice("--vault=".length)
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/**
 * A vault staged inside the repo is full of unpublished notes, and the routine
 * command is `sync && git add -A && git commit`. If git is not ignoring that
 * directory, that command publishes the entire private vault.
 *
 * This is not hypothetical: upstream Quartz ships a `.gitignore` containing a
 * `.gitignore` entry, so the file ignores itself and `git add -A` never tracks
 * it - leaving a repo with no ignore rules at all and no visible sign of it.
 */
function assertVaultIsIgnored(vaultPath) {
  const rel = path.relative(REPO, vaultPath)
  const insideRepo = rel && !rel.startsWith("..") && !path.isAbsolute(rel)
  if (!insideRepo) return

  const probe = spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: REPO })
  // 0 = ignored, 1 = not ignored, anything else = git could not tell us.
  if (probe.status === 0) return

  throw new Error(
    `the vault is staged at "${rel}", inside the repo, but git is NOT ignoring it.\n` +
      `Running \`git add -A\` after this would commit every unpublished note.\n\n` +
      `Add this to .gitignore, and make sure .gitignore itself is tracked\n` +
      `(\`git ls-files .gitignore\` must print the path):\n\n` +
      `    ${rel.split(path.sep).join("/")}/\n`,
  )
}

/**
 * On the Windows PC the vault is a Google Drive mount; in a cloud session there
 * is no mount, so files are staged into `_vault/` first (see CLAUDE.md).
 */
function resolveVault(explicit) {
  const candidates = [
    explicit,
    process.env.OBSIDIAN_VAULT,
    readIfExists(path.join(REPO, ".vault-path"))?.trim(),
    path.join(REPO, "_vault"),
    "G:\\My Drive\\Obsidian\\Klui's Database",
  ].filter(Boolean)

  for (const c of candidates) {
    if (fsSync.existsSync(c) && fsSync.statSync(c).isDirectory()) return c
  }
  throw new Error(
    "could not locate the vault. Pass --vault <path>, set OBSIDIAN_VAULT, " +
      "write the path into .vault-path, or stage files into _vault/.\n" +
      `tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  )
}

function readIfExists(p) {
  try {
    return fsSync.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Vault walking
// ---------------------------------------------------------------------------

async function walk(dir, base = dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      await walk(path.join(dir, e.name), base, out)
    } else if (e.isFile()) {
      const abs = path.join(dir, e.name)
      out.push({ abs, rel: path.relative(base, abs).split(path.sep).join("/") })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

function splitFrontmatter(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw, hadFrontmatter: false }
  let frontmatter = {}
  try {
    frontmatter = parseYaml(m[1]) ?? {}
  } catch {
    // Obsidian tolerates slightly-off YAML; treat unparseable frontmatter as
    // absent rather than crashing the whole sync.
    frontmatter = {}
  }
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) frontmatter = {}
  return { frontmatter, body: raw.slice(m[0].length), hadFrontmatter: true }
}

/** Body with fenced/inline code removed, so `#publish` inside a snippet doesn't count. */
function stripCode(body) {
  return body
    .replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
}

function tagList(frontmatter) {
  const raw = frontmatter.tags ?? frontmatter.tag
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/)
  return arr.filter(Boolean).map((t) => String(t).replace(/^#/, "").trim().toLowerCase())
}

/**
 * The single source of truth for "may this go on the web?".
 * @returns {{publish: boolean, reason: string}}
 */
function publishDecision(frontmatter, body) {
  if (frontmatter.publish === false || frontmatter.publish === "false") {
    return { publish: false, reason: "publish: false" }
  }
  if (frontmatter.publish === true || frontmatter.publish === "true") {
    return { publish: true, reason: "frontmatter publish: true" }
  }
  if (tagList(frontmatter).includes("publish")) {
    return { publish: true, reason: "frontmatter tag: publish" }
  }
  if (/(^|[\s(\[])#publish(?![\w/-])/m.test(stripCode(body))) {
    return { publish: true, reason: "inline #publish tag" }
  }
  return { publish: false, reason: "not marked" }
}

function denied(rel) {
  return DENY_PATTERNS.find((re) => re.test(rel)) ?? null
}

// ---------------------------------------------------------------------------
// Link/embed rewriting
// ---------------------------------------------------------------------------

/** `[[target#heading|alias]]` and `![[target|alias]]`. */
const WIKILINK_RE = /(!?)\[\[([^\]|#^]+)((?:[#^][^\]|]*)?)(?:\|([^\]]*))?\]\]/g

/** Obsidian resolves by full path first, then by unique basename. */
function makeResolver(files) {
  const byRel = new Map()
  const byBase = new Map()
  for (const f of files) {
    byRel.set(f.rel.toLowerCase(), f)
    const base = f.rel.split("/").pop()
    const noExt = base.replace(/\.md$/i, "")
    for (const key of [base.toLowerCase(), noExt.toLowerCase()]) {
      if (!byBase.has(key)) byBase.set(key, [])
      byBase.get(key).push(f)
    }
  }
  return (target) => {
    const t = target.trim().replace(/^\.\//, "")
    const tl = t.toLowerCase()
    if (byRel.has(tl)) return byRel.get(tl)
    if (byRel.has(tl + ".md")) return byRel.get(tl + ".md")
    const base = tl.split("/").pop()
    const hits = byBase.get(base) ?? byBase.get(base + ".md") ?? []
    // Prefer an unambiguous match; on collision prefer one whose path ends with
    // the requested sub-path.
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
      const exact = hits.find((h) => h.rel.toLowerCase().endsWith(tl)) ?? hits[0]
      return exact
    }
    return null
  }
}

function shortHash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const VAULT = resolveVault(args.vault)
  assertVaultIsIgnored(VAULT)
  const log = (...a) => console.log(...a)
  const vlog = (...a) => args.verbose && console.log(...a)

  log(`vault:  ${VAULT}`)
  log(`output: ${OUT}`)
  if (args.dryRun) log("mode:   DRY RUN (nothing will be written)\n")

  const files = await walk(VAULT)
  const resolve = makeResolver(files)

  // -- pass 1: decide -------------------------------------------------------
  const notes = []          // publishable markdown notes
  const canvases = []       // publishable canvases
  const skipped = []
  const blocked = []
  const unreadable = []     // files we could not even parse - never silently dropped

  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase()
    if (ext !== ".md" && ext !== ".canvas") continue

    let frontmatter, body
    // Strip a UTF-8 BOM: JSON.parse rejects it outright, and a canvas that
    // fails to parse would otherwise drop out of the run unnoticed.
    const raw = (await fs.readFile(f.abs, "utf8")).replace(/^﻿/, "")

    if (ext === ".canvas") {
      let canvas
      try {
        canvas = JSON.parse(raw)
      } catch (err) {
        unreadable.push({ rel: f.rel, reason: err.message })
        continue
      }
      frontmatter = canvas.metadata?.frontmatter ?? {}
      body = ""
      const d = publishDecision(frontmatter, body)
      if (!d.publish) {
        skipped.push({ rel: f.rel, reason: d.reason })
        continue
      }
      const deny = denied(f.rel)
      if (deny) {
        blocked.push({ rel: f.rel, pattern: String(deny) })
        continue
      }
      canvases.push({ ...f, canvas })
      continue
    }

    ;({ frontmatter, body } = splitFrontmatter(raw))
    const d = publishDecision(frontmatter, body)
    if (!d.publish) {
      skipped.push({ rel: f.rel, reason: d.reason })
      continue
    }
    const deny = denied(f.rel)
    if (deny) {
      blocked.push({ rel: f.rel, pattern: String(deny) })
      continue
    }
    notes.push({ ...f, frontmatter, body, reason: d.reason })
  }

  // Set of everything cleared for publication, for link rewriting.
  const publishedRel = new Set([...notes, ...canvases].map((n) => n.rel))
  const outPaths = planOutputPaths([...publishedRel])

  if (unreadable.length) {
    log("\n!! COULD NOT PARSE - these files were skipped without a publish decision:")
    for (const u of unreadable) log(`   ${u.rel}\n     ${u.reason}`)
  }

  if (blocked.length) {
    log("\n!! BLOCKED by denylist (marked for publish but path is protected):")
    for (const b of blocked) log(`   ${b.rel}\n     pattern: ${b.pattern}`)
    log("   -> edit DENY_PATTERNS in scripts/sync.mjs if this is intentional.")
  }

  if (!notes.length && !canvases.length) {
    log("\nNothing is marked for publication. content/ will be emptied.")
  }

  // -- pass 2: emit ---------------------------------------------------------
  const assets = new Map()   // vault rel -> output filename under content/assets
  const drawings = new Map() // vault rel -> { slug, scene }
  const warnings = []

  /** Register an attachment for copying; returns its embed name. */
  function useAsset(file) {
    if (assets.has(file.rel)) return assets.get(file.rel)
    const base = file.rel.split("/").pop()
    const taken = new Set(assets.values())
    let name = base
    if (taken.has(name)) {
      const ext = path.extname(base)
      name = `${base.slice(0, -ext.length)}-${shortHash(file.rel)}${ext}`
    }
    assets.set(file.rel, name)
    return name
  }

  /** Register an Excalidraw scene for CI rendering; returns the SVG filename. */
  function useDrawing(file, raw) {
    if (drawings.has(file.rel)) return `${drawings.get(file.rel).slug}.svg`
    let scene
    try {
      scene = parseExcalidraw(file.rel, raw)
    } catch (err) {
      warnings.push(`excalidraw: ${err.message}`)
      return null
    }
    const base = file.rel.split("/").pop().replace(/\.excalidraw(\.md)?$/i, "").replace(/\.md$/i, "")
    // Lower-cased deliberately: Quartz slugifies asset links to lower case, and
    // GitHub Pages serves from a case-sensitive filesystem, so a capitalised
    // filename here would 404 in production while working fine on Windows.
    const slug = `${base.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "drawing"}-${shortHash(file.rel)}`
    const n = embeddedFileCount(scene)
    if (n) warnings.push(`${file.rel}: scene embeds ${n} raster image(s); they are inlined into the SVG`)
    drawings.set(file.rel, { slug, scene })
    return `${slug}.svg`
  }

  function isDrawingNote(file, raw) {
    if (/\.excalidraw$/i.test(file.rel)) return true
    if (/\.excalidraw\.md$/i.test(file.rel)) return true
    const { frontmatter } = splitFrontmatter(raw)
    return Boolean(frontmatter["excalidraw-plugin"])
  }

  /** Rewrite wikilinks/embeds; unpublished targets degrade to plain text. */
  function rewrite(body, ownerRel) {
    return body.replace(WIKILINK_RE, (whole, bang, target, anchor, alias) => {
      const label = (alias ?? target.split("/").pop().replace(/\.md$/i, "")).trim()
      const file = resolve(target)

      if (!file) {
        vlog(`   unresolved link in ${ownerRel}: [[${target}]]`)
        return label
      }

      const ext = path.extname(file.rel).toLowerCase()

      if (IMAGE_EXTS.has(ext)) {
        const name = useAsset(file)
        return `${bang}[[${ASSETS_SUBDIR}/${name}${alias ? `|${alias}` : ""}]]`
      }

      // An Excalidraw drawing referenced from another note.
      const rawTarget = fsSync.existsSync(file.abs) ? fsSync.readFileSync(file.abs, "utf8") : ""
      if (rawTarget && isDrawingNote(file, rawTarget)) {
        const svg = useDrawing(file, rawTarget)
        if (!svg) return label
        return `![[${DRAWINGS_SUBDIR}/${svg}${alias ? `|${alias}` : ""}]]`
      }

      if (!publishedRel.has(file.rel)) {
        // Deliberately drop the path: an unpublished note's location is itself
        // information we do not want on the web.
        vlog(`   link to unpublished ${file.rel} from ${ownerRel} -> plain text`)
        return label
      }

      const outTarget = outPaths.get(file.rel).replace(/\.md$/i, "")
      return `${bang}[[${outTarget}${anchor}${alias ? `|${alias}` : ""}]]`
    })
  }

  /** Excalidraw plugin notes: keep the drawing, drop the plugin's data dump. */
  function drawingNoteBody(file, raw) {
    const svg = useDrawing(file, raw)
    if (!svg) return "> [!warning] This drawing could not be rendered.\n"
    return `![[${DRAWINGS_SUBDIR}/${svg}]]\n`
  }

  const outputs = [] // { outRel, contents } | { outRel, copyFrom }

  for (const note of notes) {
    const raw = await fs.readFile(note.abs, "utf8")
    const drawing = isDrawingNote(note, raw)
    const body = drawing ? drawingNoteBody(note, raw) : rewrite(note.body, note.rel).trim() + "\n"

    // Rebuild frontmatter: strip Obsidian plugin bookkeeping, guarantee the
    // `publish: true` that Quartz's explicit-publish filter looks for.
    const fm = { ...note.frontmatter }
    for (const k of ["excalidraw-plugin", "mindmap-plugin", "excalidraw-open-md", "excalidraw-export-dark"]) {
      delete fm[k]
    }
    if (Array.isArray(fm.tags)) fm.tags = fm.tags.filter((t) => String(t).replace(/^#/, "") !== "excalidraw")
    fm.publish = true
    if (!fm.title) fm.title = note.rel.split("/").pop().replace(/\.md$/i, "")

    const outRel = outPaths.get(note.rel)
    outputs.push({
      outRel,
      contents: `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${body}`,
    })
    vlog(` + ${outRel}  (${note.reason}${drawing ? ", excalidraw" : ""})`)
  }

  for (const c of canvases) {
    // Drop nodes pointing at anything not cleared for publication. `portal: true`
    // nodes inline another file's whole contents, so an unfiltered canvas is a
    // transitive leak of every file it references.
    const keptNodes = []
    const droppedNodes = new Set()
    for (const node of c.canvas.nodes ?? []) {
      if (node.type !== "file") {
        keptNodes.push(node)
        continue
      }
      const target = resolve(node.file ?? "")
      const ext = target ? path.extname(target.rel).toLowerCase() : ""
      if (target && IMAGE_EXTS.has(ext)) {
        const name = useAsset(target)
        keptNodes.push({ ...node, file: `${ASSETS_SUBDIR}/${name}` })
        continue
      }
      if (target && publishedRel.has(target.rel)) {
        keptNodes.push({ ...node, file: outPaths.get(target.rel) })
        continue
      }
      droppedNodes.add(node.id)
      warnings.push(
        `${c.rel}: dropped node -> "${node.file}" (${target ? "not published" : "unresolved"}${node.portal ? ", portal" : ""})`,
      )
    }
    const keptEdges = (c.canvas.edges ?? []).filter(
      (e) => !droppedNodes.has(e.fromNode) && !droppedNodes.has(e.toNode),
    )
    const out = {
      ...c.canvas,
      nodes: keptNodes,
      edges: keptEdges,
      metadata: { ...(c.canvas.metadata ?? {}), frontmatter: { ...(c.canvas.metadata?.frontmatter ?? {}), publish: true } },
    }
    outputs.push({ outRel: outPaths.get(c.rel), contents: JSON.stringify(out, null, "\t") })
    vlog(` + ${c.rel}  (canvas, ${keptNodes.length}/${(c.canvas.nodes ?? []).length} nodes kept)`)
  }

  // Quartz needs a root page. If the vault does not publish one, generate an
  // index listing exactly what was published - nothing else is known to it.
  if (!outputs.some((o) => o.outRel.toLowerCase() === "index.md")) {
    const entries = [...notes, ...canvases]
      .map((n) => outPaths.get(n.rel))
      .sort((a, b) => a.localeCompare(b, "th"))
      .map((p) => `- [[${p.replace(/\.md$/i, "")}]]`)
    outputs.push({
      outRel: "index.md",
      contents:
        `---\npublish: true\ntitle: Klui's Notes\n---\n\n` +
        (entries.length
          ? `บันทึกที่เผยแพร่ไว้\n\n${entries.join("\n")}\n`
          : `ยังไม่มีโน้ตที่เผยแพร่\n`),
    })
  }

  for (const [rel, name] of assets) {
    const src = files.find((f) => f.rel === rel)
    outputs.push({ outRel: `${ASSETS_SUBDIR}/${name}`, copyFrom: src.abs })
  }

  // -- write ----------------------------------------------------------------
  if (args.dryRun) {
    log("\n--- would write ---")
    for (const o of outputs) log(`  content/${o.outRel}`)
    for (const [, d] of drawings) log(`  drawings-src/${d.slug}.excalidraw.json`)
  } else {
    // Wipe first so that un-publishing a note actually removes it from the site.
    await fs.rm(OUT, { recursive: true, force: true })
    await fs.rm(DRAWINGS_SRC, { recursive: true, force: true })
    await fs.mkdir(OUT, { recursive: true })

    for (const o of outputs) {
      const dest = path.join(OUT, o.outRel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      if (o.copyFrom) await fs.copyFile(o.copyFrom, dest)
      else await fs.writeFile(dest, o.contents, "utf8")
    }

    if (drawings.size) {
      await fs.mkdir(DRAWINGS_SRC, { recursive: true })
      for (const [, d] of drawings) {
        await fs.writeFile(
          path.join(DRAWINGS_SRC, `${d.slug}.excalidraw.json`),
          JSON.stringify(d.scene),
          "utf8",
        )
      }
    }
  }

  // -- report ---------------------------------------------------------------
  log("")
  log(`published notes:    ${notes.length}`)
  log(`published canvases: ${canvases.length}`)
  log(`attachments:        ${assets.size}`)
  log(`drawings:           ${drawings.size}`)
  log(`skipped (private):  ${skipped.length}`)
  log(`blocked (denylist): ${blocked.length}`)
  log(`unparseable:        ${unreadable.length}`)

  if (warnings.length) {
    log("\nwarnings:")
    for (const w of warnings) log(`  - ${w}`)
  }

  for (const n of notes) log(`  published: ${n.rel}`)
  for (const c of canvases) log(`  published: ${c.rel} (canvas)`)
}

main().catch((err) => {
  console.error(`\nsync failed: ${err.message}`)
  process.exit(1)
})
