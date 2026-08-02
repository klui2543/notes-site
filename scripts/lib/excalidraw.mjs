/**
 * Extract the raw Excalidraw scene JSON from either format the Obsidian
 * Excalidraw plugin writes:
 *
 *   1. `<name>.excalidraw`     - plain scene JSON (plugin >= 2.x "Excalidraw file format")
 *   2. `<name>.excalidraw.md`  - markdown wrapper with the scene in a fenced block:
 *        ```json               -> plain, when plugin setting `compress: false`
 *        ```compressed-json    -> LZ-String base64, when `compress: true`
 *
 * The vault this repo syncs from has `compress: true`, so new drawings land in
 * the compressed variant while older ones are still parsed/plain. Both are handled.
 */

// lz-string is CommonJS and only exposes a default export under Node's ESM interop.
import LZString from "lz-string"

/** Fenced block bodies, keyed by the fence's info string. */
function fencedBlocks(markdown) {
  const blocks = []
  const re = /^[ \t]*```([^\n`]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm
  let m
  while ((m = re.exec(markdown)) !== null) {
    blocks.push({ lang: m[1].trim().toLowerCase(), body: m[2] })
  }
  return blocks
}

/**
 * The plugin writes compressed scenes as base64 broken across many lines for
 * readability. LZ-String cannot tolerate the inserted whitespace, so strip it.
 */
function decompressScene(body) {
  const packed = body.replace(/\s+/g, "")
  const json = LZString.decompressFromBase64(packed)
  if (!json) throw new Error("lz-string returned empty output")
  return JSON.parse(json)
}

function assertScene(scene, where) {
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
    throw new Error(`${where}: not an Excalidraw scene (no elements array)`)
  }
  return scene
}

/**
 * @param {string} filePath  path the contents came from, used for error messages
 * @param {string} raw       file contents
 * @returns {{type: 'excalidraw', version: number, elements: object[], appState?: object, files?: object}}
 */
export function parseExcalidraw(filePath, raw) {
  // Plain `.excalidraw` - the whole file is the scene.
  if (!filePath.toLowerCase().endsWith(".md")) {
    try {
      return assertScene(JSON.parse(raw), filePath)
    } catch (err) {
      throw new Error(`${filePath}: could not parse as Excalidraw JSON - ${err.message}`)
    }
  }

  // `.excalidraw.md` - dig the scene out of a fenced block.
  const blocks = fencedBlocks(raw)

  const compressed = blocks.find((b) => b.lang === "compressed-json")
  if (compressed) {
    try {
      return assertScene(decompressScene(compressed.body), filePath)
    } catch (err) {
      throw new Error(`${filePath}: could not decompress compressed-json block - ${err.message}`)
    }
  }

  // Plain JSON block. A drawing note can contain other ```json blocks in its
  // text, so take the first one that actually looks like a scene.
  for (const block of blocks) {
    if (block.lang !== "json") continue
    try {
      const parsed = JSON.parse(block.body)
      if (parsed?.type === "excalidraw" || Array.isArray(parsed?.elements)) {
        return assertScene(parsed, filePath)
      }
    } catch {
      // not this block
    }
  }

  throw new Error(
    `${filePath}: no Excalidraw scene found ` +
      `(looked for \`\`\`compressed-json and \`\`\`json blocks, saw: ${
        blocks.map((b) => b.lang || "«none»").join(", ") || "no fenced blocks"
      })`,
  )
}

/** True for any path the Excalidraw plugin owns. */
export function isExcalidrawPath(p) {
  const lower = p.toLowerCase()
  return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md")
}

/**
 * Scenes may embed raster images under `files`. Those are self-contained
 * data URLs, so nothing extra needs copying - but callers may want to warn
 * when a drawing carries megabytes of embedded PNGs.
 */
export function embeddedFileCount(scene) {
  return scene.files ? Object.keys(scene.files).length : 0
}
