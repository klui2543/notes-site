#!/usr/bin/env node
/**
 * Render the Excalidraw scenes staged by `sync.mjs` into SVG.
 *
 *   drawings-src/<slug>.excalidraw.json  ->  content/assets/drawings/<slug>.svg
 *
 * Excalidraw's `exportToSvg` is a browser API: it measures text with canvas
 * metrics and builds the SVG through the DOM, so there is no faithful
 * Node-only path. Rather than approximate the renderer, this drives the real
 * one inside headless Chromium.
 *
 * That is why this runs in GitHub Actions rather than at sync time - CI already
 * has Chromium, so neither the PC nor a phone/cloud session has to.
 *
 * The package ships ESM with bare specifiers and React as a peer dependency,
 * so it is bundled with esbuild first instead of being dropped into a <script>.
 */

import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import os from "node:os"
import * as esbuild from "esbuild"
import { chromium } from "playwright"

const REPO = path.resolve(import.meta.dirname, "..")
const SRC = path.join(REPO, "drawings-src")
const OUT = path.join(REPO, "content", "assets", "drawings")

/** Bundle Excalidraw's exporter into a single browser-ready IIFE. */
async function buildBundle() {
  // Fed through stdin with an explicit resolveDir so bare specifiers resolve
  // against this repo's node_modules (a temp-file entry would resolve against
  // the temp directory and find nothing).
  const result = await esbuild.build({
    stdin: {
      contents:
        `import { exportToSvg } from "@excalidraw/excalidraw"\n` +
        `window.__exportToSvg = exportToSvg\n`,
      resolveDir: REPO,
      sourcefile: "excalidraw-entry.js",
      loader: "js",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    write: false,
    minify: true,
    absWorkingDir: REPO,
    define: { "process.env.NODE_ENV": '"production"', global: "window" },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    logLevel: "silent",
  })
  return result.outputFiles[0].text
}

/**
 * Emit a self-contained HTML page that renders every staged scene in a normal
 * browser. Useful to check the exporter without a Playwright browser installed
 * (`node scripts/render-drawings.mjs --harness out.html`).
 */
async function writeHarness(dest, bundle, sceneEntries) {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Excalidraw export harness</title>
<body style="font-family:sans-serif;padding:1rem">
<h1>Excalidraw export harness</h1>
<div id="status">rendering…</div>
<div id="out"></div>
<script>${bundle}</script>
<script>
const scenes = ${JSON.stringify(sceneEntries)};
(async () => {
  const out = document.getElementById("out");
  const status = document.getElementById("status");
  const results = [];
  for (const { slug, scene } of scenes) {
    const h = document.createElement("h2");
    h.textContent = slug;
    out.appendChild(h);
    try {
      const el = await window.__exportToSvg({
        elements: scene.elements ?? [],
        files: scene.files ?? null,
        appState: { ...(scene.appState ?? {}), exportBackground: true, exportWithDarkMode: false },
        exportPadding: 10,
      });
      el.removeAttribute("width");
      el.removeAttribute("height");
      el.setAttribute("style", "max-width:100%;height:auto;border:1px solid #ccc");
      out.appendChild(el);
      results.push(slug + ": OK " + el.outerHTML.length + " bytes");
    } catch (err) {
      const p = document.createElement("pre");
      p.textContent = "FAILED: " + err.message;
      out.appendChild(p);
      results.push(slug + ": FAILED " + err.message);
    }
  }
  status.textContent = results.join(" | ");
  window.__harnessResults = results;
})();
</script>
</body>`
  await fs.writeFile(dest, html, "utf8")
  console.log(`wrote harness: ${dest}`)
}

async function main() {
  const harnessIdx = process.argv.indexOf("--harness")
  const harnessDest = harnessIdx !== -1 ? process.argv[harnessIdx + 1] : null

  if (!fsSync.existsSync(SRC)) {
    console.log("no drawings-src/ - nothing to render")
    return
  }
  const scenes = (await fs.readdir(SRC)).filter((f) => f.endsWith(".excalidraw.json"))
  if (!scenes.length) {
    console.log("no staged drawings - nothing to render")
    return
  }

  console.log(`bundling Excalidraw exporter for ${scenes.length} drawing(s)...`)
  const bundle = await buildBundle()

  if (harnessDest) {
    const entries = []
    for (const file of scenes) {
      entries.push({
        slug: file.replace(/\.excalidraw\.json$/, ""),
        scene: JSON.parse(await fs.readFile(path.join(SRC, file), "utf8")),
      })
    }
    await writeHarness(path.resolve(harnessDest), bundle, entries)
    return
  }

  const browser = await chromium.launch()
  const page = await browser.newPage()
  // about:blank keeps everything local - no network fetches during export.
  await page.goto("about:blank")
  await page.addScriptTag({ content: bundle })

  const ok = await page.evaluate(() => typeof window.__exportToSvg === "function")
  if (!ok) throw new Error("Excalidraw bundle loaded but exportToSvg is missing")

  await fs.mkdir(OUT, { recursive: true })
  let failures = 0

  for (const file of scenes) {
    const slug = file.replace(/\.excalidraw\.json$/, "")
    const scene = JSON.parse(await fs.readFile(path.join(SRC, file), "utf8"))
    try {
      const svg = await page.evaluate(async (scene) => {
        const el = await window.__exportToSvg({
          elements: scene.elements ?? [],
          files: scene.files ?? null,
          appState: {
            ...(scene.appState ?? {}),
            exportBackground: true,
            exportWithDarkMode: false,
          },
          exportPadding: 10,
        })
        // Make the drawing scale with its container instead of pinning to the
        // scene's pixel width.
        el.removeAttribute("width")
        el.removeAttribute("height")
        el.setAttribute("style", "max-width:100%;height:auto")
        return el.outerHTML
      }, scene)

      await fs.writeFile(path.join(OUT, `${slug}.svg`), svg, "utf8")
      console.log(`  rendered ${slug}.svg  (${scene.elements?.length ?? 0} elements, ${svg.length} bytes)`)
    } catch (err) {
      failures++
      console.error(`  FAILED ${slug}: ${err.message}`)
    }
  }

  await browser.close()

  if (failures) {
    // A missing drawing means a published page has a broken image, which is a
    // visible defect - fail the build rather than deploy it.
    throw new Error(`${failures} drawing(s) failed to render`)
  }
}

main().catch((err) => {
  console.error(`render-drawings failed: ${err.message}`)
  process.exit(1)
})
