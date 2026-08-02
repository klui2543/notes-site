#!/usr/bin/env node
/**
 * Add or remove `publish: true` on vault notes.
 *
 * Writing to the vault touches the real Google Drive files that sync to every
 * device, so this only ever inserts/removes that one frontmatter key and leaves
 * the rest of the file byte-identical.
 *
 * Usage:
 *   node scripts/tag-publish.mjs --vault <path> [--remove] <note path> [<note path> ...]
 *   node scripts/tag-publish.mjs --vault <path> --list
 *
 * Note paths are vault-relative and may omit the `.md` extension.
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"

const FRONTMATTER_RE = /^(﻿?)---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n)/

function parseArgs(argv) {
  const args = { vault: null, remove: false, list: false, targets: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--vault") args.vault = argv[++i]
    else if (a.startsWith("--vault=")) args.vault = a.slice(8)
    else if (a === "--remove") args.remove = true
    else if (a === "--list") args.list = true
    else args.targets.push(a)
  }
  return args
}

function findNote(vault, target) {
  const candidates = [target, `${target}.md`]
  for (const c of candidates) {
    const abs = path.join(vault, c)
    if (fsSync.existsSync(abs) && fsSync.statSync(abs).isFile()) return abs
  }
  return null
}

/** Insert `publish: true` into existing frontmatter, or create a block. */
function addPublish(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) {
    const bom = raw.startsWith("﻿") ? "﻿" : ""
    const rest = bom ? raw.slice(1) : raw
    return `${bom}---\npublish: true\n---\n\n${rest}`
  }
  const [, bom, yaml, trailingNewline] = m
  if (/^[ \t]*publish[ \t]*:/m.test(yaml)) {
    // Already present - normalise its value rather than adding a duplicate key.
    const updated = yaml.replace(/^[ \t]*publish[ \t]*:.*$/m, "publish: true")
    return `${bom}---\n${updated}\n---${trailingNewline}${raw.slice(m[0].length)}`
  }
  return `${bom}---\n${yaml}\npublish: true\n---${trailingNewline}${raw.slice(m[0].length)}`
}

function removePublish(raw) {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return raw
  const [, bom, yaml, trailingNewline] = m
  const stripped = yaml
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*publish[ \t]*:/.test(line))
    .join("\n")
  if (!stripped.trim()) return `${bom}${raw.slice(m[0].length)}`
  return `${bom}---\n${stripped}\n---${trailingNewline}${raw.slice(m[0].length)}`
}

async function listPublished(vault) {
  const found = []
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue
        await walk(path.join(dir, e.name))
      } else if (e.name.toLowerCase().endsWith(".md")) {
        const abs = path.join(dir, e.name)
        const raw = await fs.readFile(abs, "utf8")
        const m = raw.match(FRONTMATTER_RE)
        if (m && /^[ \t]*publish[ \t]*:[ \t]*(true|"true"|'true')/m.test(m[2])) {
          found.push(path.relative(vault, abs).split(path.sep).join("/"))
        }
      }
    }
  }
  await walk(vault)
  return found
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.vault) throw new Error("--vault is required")
  if (!fsSync.existsSync(args.vault)) throw new Error(`vault not found: ${args.vault}`)

  if (args.list) {
    const found = await listPublished(args.vault)
    console.log(found.length ? found.join("\n") : "(no notes are marked publish: true)")
    return
  }

  if (!args.targets.length) throw new Error("no note paths given")

  for (const target of args.targets) {
    const abs = findNote(args.vault, target)
    if (!abs) {
      console.error(`  MISSING  ${target}`)
      process.exitCode = 1
      continue
    }
    const before = await fs.readFile(abs, "utf8")
    const after = args.remove ? removePublish(before) : addPublish(before)
    if (before === after) {
      console.log(`  unchanged ${target}`)
      continue
    }
    await fs.writeFile(abs, after, "utf8")
    console.log(`  ${args.remove ? "untagged " : "tagged   "} ${target}`)
  }
}

main().catch((err) => {
  console.error(`tag-publish failed: ${err.message}`)
  process.exit(1)
})
