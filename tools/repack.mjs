#!/usr/bin/env node
// Rewrites a built hierarchy in format 4 on a coarser position grid, without rebuilding it: the
// same clusters, pages and errors, so a viewer's cut is the same, with the vertices requantised
// (16 bits an axis by default) and each cluster record packed to 17 words on the wire.
//
//   theia repack <inDir> <outDir> [--position-bits 16] [--force]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { codecReady, decodePage, encodeBlocks, headerWords, packRecords, recordGridFor, RECORD_WORDS, VERTEX_BYTES, WIRE_RECORD_WORDS } from "./page.mjs"

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const fail = (message) => {
  console.error(`repack: ${message}`)
  process.exit(1)
}
const [inDir, outDir] = positional
if (!inDir || !outDir) fail("usage: theia repack <inDir> <outDir> [--position-bits 16] [--force]")
if (!existsSync(join(inDir, "manifest.json"))) fail(`${inDir} has no manifest.json`)
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  if (!args.includes("--force")) fail(`${outDir} is not empty; pass --force to replace its contents`)
  rmSync(outDir, { recursive: true, force: true })
}
const positionBits = Number(option("position-bits", 16))
if (!(positionBits >= 8 && positionBits <= 32)) fail("--position-bits must be between 8 and 32")

const manifest = JSON.parse(readFileSync(join(inDir, "manifest.json"), "utf8"))
if (manifest.format < 3) fail(`format ${manifest.format} has no quantisation to repack; rebuild with theia build`)
await codecReady()
const levels = manifest.levels.map((l) => readFileSync(join(inDir, l.file)))
const NONE = 0xffffffff

// The new grid keeps the old one's origin and extent, so every page's vertices snap alike.
const old = manifest.quantisation
const extent = old.step * (2 ** old.positionBits - 1)
const quantisation = { origin: old.origin, step: extent / (2 ** positionBits - 1), positionBits }
const recordGrid = recordGridFor(quantisation)

// Every page, reached from the roots: decoded records (32 words), the re-encoded blocks, and its level.
const pages = new Map()
const queue = manifest.roots.map((r) => ({ id: r.id, level: r.level, offset: r.offset, length: r.length }))
while (queue.length) {
  const p = queue.shift()
  if (pages.has(p.id)) continue
  const decoded = decodePage(levels[p.level].subarray(p.offset, p.offset + p.length), manifest)
  const blocks = encodeBlocks(decoded.vertices, decoded.indices, quantisation)
  const records = Uint32Array.from(decoded.records)
  pages.set(p.id, { level: p.level, records, clusterCount: decoded.clusterCount, vertexCount: decoded.vertexCount, indexCount: decoded.indexCount, blocks })
  for (let c = 0; c < decoded.clusterCount; c++) {
    const w = c * RECORD_WORDS
    const child = records[w + 2]
    if (child !== NONE && !pages.has(child)) queue.push({ id: child, level: records[w + 24], offset: records[w + 25], length: records[w + 26] })
  }
}

// New ranges: pages in id order within each level, records pointing at the new child ranges.
const HEADER = headerWords(4)
const levelBytes = manifest.levels.map(() => 0)
const ranges = new Map()
for (const id of [...pages.keys()].sort((a, b) => a - b)) {
  const page = pages.get(id)
  const length = (HEADER + page.clusterCount * WIRE_RECORD_WORDS) * 4 + page.blocks.byteLength
  ranges.set(id, { level: page.level, offset: levelBytes[page.level], length })
  levelBytes[page.level] += length
}
const levelBuffers = manifest.levels.map(() => [])
for (const id of [...pages.keys()].sort((a, b) => a - b)) {
  const page = pages.get(id)
  const range = ranges.get(id)
  for (let c = 0; c < page.clusterCount; c++) {
    const w = c * RECORD_WORDS
    const child = page.records[w + 2]
    if (child === NONE) continue
    const childRange = ranges.get(child)
    page.records[w + 24] = childRange.level
    page.records[w + 25] = childRange.offset
    page.records[w + 26] = childRange.length
  }
  const words = new Uint32Array(range.length / 4)
  const bytes = new Uint8Array(words.buffer)
  words[0] = id; words[1] = page.clusterCount; words[2] = page.vertexCount; words[3] = page.indexCount
  words[4] = page.blocks.vertexBlock.byteLength; words[5] = page.blocks.indexBlock.byteLength
  words.set(packRecords(page.records, page.clusterCount, recordGrid), HEADER)
  const vertexStart = (HEADER + page.clusterCount * WIRE_RECORD_WORDS) * 4
  bytes.set(page.blocks.vertexBlock, vertexStart)
  bytes.set(page.blocks.indexBlock, vertexStart + ((page.blocks.vertexBlock.byteLength + 3) & ~3))
  levelBuffers[page.level].push(Buffer.from(words.buffer))
}

mkdirSync(outDir, { recursive: true })
manifest.levels.forEach((level, i) => writeFileSync(join(outDir, level.file), Buffer.concat(levelBuffers[i])))
const out = {
  ...manifest,
  format: 4,
  build: Date.now().toString(36),
  vertexBytes: VERTEX_BYTES,
  quantisation,
  wireRecordWords: WIRE_RECORD_WORDS,
  recordGrid,
  levels: manifest.levels.map((level, i) => ({ file: level.file, byteLength: levelBytes[i] })),
  roots: manifest.roots.map((r) => ({ id: r.id, ...ranges.get(r.id) })),
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(out))
const before = manifest.levels.reduce((n, l) => n + l.byteLength, 0)
const after = levelBytes.reduce((n, b) => n + b, 0)
console.log(`repacked ${pages.size} pages at ${positionBits} bits: ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB (${(100 * after / before).toFixed(0)}%), grid step ${(quantisation.step * 1000).toFixed(4)} mm, records ${WIRE_RECORD_WORDS} words`)
