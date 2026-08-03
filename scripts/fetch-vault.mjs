#!/usr/bin/env node
/**
 * Download the Obsidian vault from Google Drive into `_vault/`, using a service
 * account rather than an interactive connector.
 *
 * Why this exists: the Drive *connector* truncates downloads at roughly 11.5 KB
 * and reports success, so a long note silently loses its tail. The Drive REST
 * API reports each file's `size` and `md5Checksum`, so every download here is
 * verified byte-for-byte and a short read is a hard failure instead of a quiet
 * corruption. It also means publishing no longer depends on any connector being
 * present in whatever session happens to be running - CI can do it alone.
 *
 * Auth is a bare RS256 JWT against Google's token endpoint. That is a few dozen
 * lines and avoids pulling the whole googleapis SDK into a repo whose entire
 * point is controlling what leaves the machine.
 *
 * Usage:
 *   GDRIVE_SERVICE_ACCOUNT_JSON='<the key file contents>' node scripts/fetch-vault.mjs
 *   node scripts/fetch-vault.mjs --folder <id> --out _vault
 *
 * The service account needs read access to the vault folder and nothing else:
 * share that one folder with its email address as Viewer.
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

const REPO = path.resolve(import.meta.dirname, "..")

/** The vault folder in Drive. Not a secret - it is only an addressable id. */
const DEFAULT_FOLDER = "1KnQ8uRROg9KUBb3N7fK3pSEqwdhpIaVq"

/** Obsidian bookkeeping - large, useless here, and `.trash` holds deleted notes. */
const SKIP_DIRS = new Set([".obsidian", ".trash", ".smart-env"])

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const DRIVE = "https://www.googleapis.com/drive/v3"
const SCOPE = "https://www.googleapis.com/auth/drive.readonly"

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url")

function signedJWT({ client_email, private_key }) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claim = b64url(
    JSON.stringify({
      iss: client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  )
  const unsigned = `${header}.${claim}`
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(private_key)
  return `${unsigned}.${b64url(signature)}`
}

async function accessToken(creds) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJWT(creds),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      `Google refused the service account (${res.status} ${body.error ?? ""}): ` +
        `${body.error_description ?? "no detail"}`,
    )
  }
  return body.access_token
}

function loadCredentials() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON
  if (!raw) {
    throw new Error(
      "GDRIVE_SERVICE_ACCOUNT_JSON is not set.\n" +
        "Locally:  $env:GDRIVE_SERVICE_ACCOUNT_JSON = Get-Content key.json -Raw\n" +
        "In CI:    add it as a repository secret (see CLAUDE.md).",
    )
  }
  let creds
  try {
    creds = JSON.parse(raw)
  } catch {
    throw new Error("GDRIVE_SERVICE_ACCOUNT_JSON is not valid JSON - paste the whole key file")
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error("service account key is missing client_email / private_key")
  }
  return creds
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

async function driveJSON(token, pathAndQuery) {
  const res = await fetch(`${DRIVE}${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Drive API ${res.status} on ${pathAndQuery}: ${detail.slice(0, 300)}`)
  }
  return res.json()
}

async function listChildren(token, folderId) {
  const out = []
  let pageToken
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,size,md5Checksum)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    })
    if (pageToken) params.set("pageToken", pageToken)
    const page = await driveJSON(token, `/files?${params}`)
    out.push(...(page.files ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Download and verify. Drive reports both the byte length and an MD5 for
 * ordinary files, so a truncated or corrupted transfer is detectable here -
 * which is the entire reason this script exists.
 */
async function download(token, file) {
  const res = await fetch(`${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`download failed ${res.status}: ${detail.slice(0, 200)}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  const expected = file.size == null ? null : Number(file.size)
  if (expected != null && buf.length !== expected) {
    throw new Error(`truncated: got ${buf.length} bytes, Drive reports ${expected}`)
  }
  if (file.md5Checksum) {
    const got = crypto.createHash("md5").update(buf).digest("hex")
    if (got !== file.md5Checksum) {
      throw new Error(`checksum mismatch: got ${got}, Drive reports ${file.md5Checksum}`)
    }
  }
  return buf
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { folder: DEFAULT_FOLDER, out: path.join(REPO, "_vault") }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--folder") args.folder = argv[++i]
    else if (a === "--out") args.out = path.resolve(argv[++i])
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/** Drive names are arbitrary; refuse anything that would escape the output dir. */
function safeName(name) {
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`refusing suspicious Drive file name: ${JSON.stringify(name)}`)
  }
  return name
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const creds = loadCredentials()

  console.log(`service account: ${creds.client_email}`)
  console.log(`vault folder:    ${args.folder}`)
  console.log(`output:          ${args.out}`)

  const token = await accessToken(creds)

  await fs.rm(args.out, { recursive: true, force: true })
  await fs.mkdir(args.out, { recursive: true })

  let files = 0
  let bytes = 0
  let skipped = 0
  const failures = []

  async function walk(folderId, relDir) {
    let children
    try {
      children = await listChildren(token, folderId)
    } catch (err) {
      failures.push(`${relDir || "/"}: ${err.message}`)
      return
    }

    for (const child of children) {
      let name
      try {
        name = safeName(child.name)
      } catch (err) {
        failures.push(err.message)
        continue
      }
      const rel = relDir ? `${relDir}/${name}` : name

      if (child.mimeType === "application/vnd.google-apps.folder") {
        if (SKIP_DIRS.has(name)) continue
        await fs.mkdir(path.join(args.out, rel), { recursive: true })
        await walk(child.id, rel)
        continue
      }

      // Docs/Sheets/Slides have no byte stream and cannot be verified; the vault
      // holds none, so treat one showing up as noteworthy rather than guessing.
      if (child.mimeType?.startsWith("application/vnd.google-apps.")) {
        skipped++
        console.log(`  skipped (Google-native ${child.mimeType}): ${rel}`)
        continue
      }

      try {
        const buf = await download(token, child)
        const dest = path.join(args.out, rel)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, buf)
        files++
        bytes += buf.length
      } catch (err) {
        failures.push(`${rel}: ${err.message}`)
      }
    }
  }

  await walk(args.folder, "")

  console.log("")
  console.log(`downloaded: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  if (skipped) console.log(`skipped:    ${skipped} Google-native files`)

  if (failures.length) {
    console.error(`\n!! ${failures.length} file(s) failed:`)
    for (const f of failures) console.error(`   ${f}`)
    // Carrying on would hand sync.mjs an incomplete vault, and sync rebuilds
    // content/ from scratch - a missing note would be quietly unpublished.
    throw new Error("vault fetch incomplete; not safe to sync from this")
  }
}

main().catch((err) => {
  console.error(`\nfetch-vault failed: ${err.message}`)
  process.exit(1)
})
