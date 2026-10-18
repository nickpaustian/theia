#!/usr/bin/env node
// Checks a built Theia hierarchy: the manifest, every page reached from the roots (headers,
// records, ranges, monotone errors) and, unless --no-scan, the geometry of each level
// (degenerate, inverted and folded triangles, open edges).
//
//   theia inspect <dir> [--no-scan]

import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { codecReady, decodePage, FORMATS } from "./page.mjs"

const argv = process.argv.slice(2)
const [dir] = argv.filter((a) => !a.startsWith("--"))
const scan = !argv.includes("--no-scan")
const fail = (message) => {
  console.error(`inspect: ${message}`)
  process.exit(1)
}
if (!dir) fail("usage: theia inspect <dir> [--no-scan]")
if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} has no manifest.json`)

const FLOATS = 8
const RECORD_WORDS = 32
const NONE = 0xffffffff
const issues = []
const issue = (message) => {
  if (issues.length < 50) issues.push(message)
  else if (issues.length === 50) issues.push("... further issues not listed")
}

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
if (!FORMATS.includes(manifest.format)) fail(`manifest format ${manifest.format}; this tool reads formats ${FORMATS.join(" and ")}`)
if (manifest.recordWords !== RECORD_WORDS) fail(`manifest recordWords ${manifest.recordWords}; expected ${RECORD_WORDS}`)
if (manifest.format === 3 && !manifest.quantisation) fail("format 3 manifest has no quantisation")
await codecReady()

const levels = manifest.levels.map((level, i) => {
  const path = join(dir, level.file)
  if (!existsSync(path)) fail(`level ${i} file ${level.file} is missing`)
  const size = statSync(path).size
  if (size !== level.byteLength) issue(`level ${i} file ${level.file} is ${size} bytes, manifest says ${level.byteLength}`)
  return { ...level, data: readFileSync(path) }
})

const perLevel = levels.map(() => ({ pages: 0, clusters: 0, triangles: 0, bytes: 0, geometry: [] }))
const clusterIds = new Set()
const seen = new Set()
const queue = manifest.roots.map((root) => ({ ...root, parentLevel: Infinity }))
if (queue.length === 0) fail("manifest has no root pages")

while (queue.length > 0) {
  const { id, level, offset, length, parentLevel } = queue.shift()
  if (seen.has(id)) continue
  seen.add(id)
  const file = levels[level]
  if (!file) { issue(`page ${id} is on level ${level}, which has no file`); continue }
  if (offset + length > file.data.length) { issue(`page ${id} range ${offset}+${length} runs past level ${level} (${file.data.length} bytes)`); continue }
  if (level >= parentLevel) issue(`page ${id} on level ${level} is reached from level ${parentLevel}; children must be finer`)
  const decoded = decodePage(file.data.subarray(offset, offset + length), manifest)
  const { clusterCount, vertexCount, indexCount, records, vertices, indices } = decoded
  const floats = new Float32Array(records.buffer, records.byteOffset, records.length)
  if (decoded.page !== id) issue(`page ${id} is headed ${decoded.page}`)
  if (decoded.expectedBytes !== length) issue(`page ${id} is ${length} bytes but its header describes ${decoded.expectedBytes}`)
  if (clusterCount > manifest.maxPageClusters) issue(`page ${id} has ${clusterCount} clusters, manifest max is ${manifest.maxPageClusters}`)
  if (vertexCount > manifest.maxPageVertices) issue(`page ${id} has ${vertexCount} vertices, manifest max is ${manifest.maxPageVertices}`)
  if (indexCount > manifest.maxPageIndices) issue(`page ${id} has ${indexCount} indices, manifest max is ${manifest.maxPageIndices}`)
  if (indexCount % 3 !== 0) issue(`page ${id} index count ${indexCount} is not a multiple of 3`)

  const stats = perLevel[level]
  stats.pages++
  stats.clusters += clusterCount
  stats.triangles += indexCount / 3
  stats.bytes += length
  for (let c = 0; c < clusterCount; c++) {
    const w = c * RECORD_WORDS
    const [recordLevel, recordPage, childPage, indexOffset, indexLength, vertexOffset, vertexLength] = records.subarray(w, w + 7)
    const selfError = floats[w + 7]
    const parentError = floats[w + 12]
    const clusterId = records[w + 29]
    const where = `page ${id} cluster ${c}`
    if (recordLevel !== level) issue(`${where} says level ${recordLevel}, page is on ${level}`)
    if (recordPage !== id) issue(`${where} says page ${recordPage}`)
    if (indexOffset + indexLength > indexCount) issue(`${where} index range ${indexOffset}+${indexLength} exceeds ${indexCount}`)
    if (vertexOffset + vertexLength > vertexCount) issue(`${where} vertex range ${vertexOffset}+${vertexLength} exceeds ${vertexCount}`)
    if (!(selfError >= 0) || !(parentError >= selfError)) issue(`${where} errors not monotone: self ${selfError}, parent ${parentError}`)
    if (clusterIds.has(clusterId)) issue(`${where} repeats cluster id ${clusterId}`)
    clusterIds.add(clusterId)
    for (let i = indexOffset; i < indexOffset + indexLength && i < indexCount; i++) {
      const v = indices[i]
      if (v < vertexOffset || v >= vertexOffset + vertexLength) { issue(`${where} index ${v} outside its vertices ${vertexOffset}+${vertexLength}`); break }
    }
    if (childPage !== NONE) {
      queue.push({ id: childPage, level: records[w + 24], offset: records[w + 25], length: records[w + 26], parentLevel: level })
    } else if (level !== 0) {
      issue(`${where} has no child page but is on level ${level}`)
    }
  }
  if (scan) stats.geometry.push({ vertices, indices })
}

if (seen.size !== manifest.pageCount) issue(`${seen.size} pages reachable from the roots, manifest says ${manifest.pageCount}`)
if (clusterIds.size !== manifest.clusterCount) issue(`${clusterIds.size} clusters found, manifest says ${manifest.clusterCount}`)
if (perLevel[0].triangles !== manifest.triangles) issue(`level 0 has ${perLevel[0].triangles} triangles, manifest says ${manifest.triangles}`)
const fileBytes = perLevel.map((s) => s.bytes)
levels.forEach((level, i) => {
  if (fileBytes[i] !== level.data.length) issue(`level ${i}: ${fileBytes[i]} bytes in reachable pages, file holds ${level.data.length}`)
})

// Geometry of one level as a whole: positions welded exactly, so edges shared between
// clusters and pages count as shared, which is what crack-free rendering needs
const scanLevel = (parts) => {
  const vertexCount = parts.reduce((n, p) => n + p.vertices.length / FLOATS, 0)
  const triangleCount = parts.reduce((n, p) => n + p.indices.length / 3, 0)
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const triangles = new Uint32Array(triangleCount * 3)
  let v = 0, t = 0
  for (const part of parts) {
    const count = part.vertices.length / FLOATS
    for (let i = 0; i < count; i++) {
      positions.set(part.vertices.subarray(i * FLOATS, i * FLOATS + 3), (v + i) * 3)
      normals.set(part.vertices.subarray(i * FLOATS + 3, i * FLOATS + 6), (v + i) * 3)
    }
    for (let i = 0; i < part.indices.length; i++) triangles[t + i] = part.indices[i] + v
    v += count
    t += part.indices.length
  }
  let nan = 0
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]) || !Number.isFinite(normals[i])) nan++

  const welded = new Uint32Array(vertexCount)
  const byPosition = new Map()
  for (let i = 0; i < vertexCount; i++) {
    const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`
    let id = byPosition.get(key)
    if (id === undefined) { id = byPosition.size; byPosition.set(key, id) }
    welded[i] = id
  }
  const uniqueCount = byPosition.size

  const faceNormals = new Float32Array(triangleCount * 3)
  let degenerate = 0, opposing = 0
  for (let f = 0; f < triangleCount; f++) {
    const a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2]
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz)
    if (len === 0 || welded[a] === welded[b] || welded[b] === welded[c] || welded[a] === welded[c]) { degenerate++; continue }
    nx /= len; ny /= len; nz /= len
    faceNormals[f * 3] = nx; faceNormals[f * 3 + 1] = ny; faceNormals[f * 3 + 2] = nz
    for (const i of [a, b, c]) if (normals[i * 3] * nx + normals[i * 3 + 1] * ny + normals[i * 3 + 2] * nz < 0) { opposing++; break }
  }

  // Edge -> the two triangles on it (more than two is non-manifold, one is open)
  const edges = new Map()
  const edgeKey = (p, q) => (p < q ? p * uniqueCount + q : q * uniqueCount + p)
  for (let f = 0; f < triangleCount; f++) {
    for (let k = 0; k < 3; k++) {
      const p = welded[triangles[f * 3 + k]], q = welded[triangles[f * 3 + ((k + 1) % 3)]]
      if (p === q) continue
      const key = edgeKey(p, q)
      const entry = edges.get(key)
      if (entry === undefined) edges.set(key, f)
      else if (typeof entry === "number") edges.set(key, [entry, f])
      else entry.push(f)
    }
  }
  let open = 0, nonManifold = 0
  for (const entry of edges.values()) {
    if (typeof entry === "number") open++
    else if (entry.length > 2) nonManifold++
  }
  let folded = 0
  for (let f = 0; f < triangleCount; f++) {
    const nx = faceNormals[f * 3], ny = faceNormals[f * 3 + 1], nz = faceNormals[f * 3 + 2]
    if (nx === 0 && ny === 0 && nz === 0) continue
    let sx = 0, sy = 0, sz = 0, neighbours = 0
    for (let k = 0; k < 3; k++) {
      const p = welded[triangles[f * 3 + k]], q = welded[triangles[f * 3 + ((k + 1) % 3)]]
      if (p === q) continue
      const entry = edges.get(edgeKey(p, q))
      if (typeof entry !== "object") continue
      for (const g of entry) {
        if (g === f) continue
        sx += faceNormals[g * 3]; sy += faceNormals[g * 3 + 1]; sz += faceNormals[g * 3 + 2]
        neighbours++
      }
    }
    if (neighbours > 0 && nx * sx + ny * sy + nz * sz < 0) folded++
  }
  return { nan, degenerate, opposing, folded, open, nonManifold }
}

const rows = perLevel.map((stats, level) => {
  const row = { level, pages: stats.pages, clusters: stats.clusters, triangles: stats.triangles, MB: +(stats.bytes / 1048576).toFixed(2) }
  if (scan && stats.geometry.length > 0) {
    const g = scanLevel(stats.geometry)
    Object.assign(row, { degenerate: g.degenerate, inverted: g.opposing, folded: g.folded })
    if (level === 0) row.open = g.open
    if (g.nonManifold > 0) row.nonManifold = g.nonManifold
    if (g.nan > 0) issue(`level ${level} has ${g.nan} non-finite position or normal components`)
    if (g.degenerate > 0) issue(`level ${level} has ${g.degenerate} degenerate triangles`)
  }
  return row
})

console.log(`${manifest.name}: ${manifest.clusterCount} clusters in ${manifest.pageCount} pages over ${levels.length} levels, ${manifest.triangles} triangles at level 0, ${manifest.roots.length} root page${manifest.roots.length === 1 ? "" : "s"}, build ${manifest.build ?? "(none)"}`)
console.log(`arena slot: ${manifest.maxPageVertices} vertices, ${manifest.maxPageIndices} indices, ${manifest.maxPageClusters} clusters (${((manifest.maxPageVertices * FLOATS + manifest.maxPageIndices) * 4 / 1024).toFixed(1)} KB per slot)`)
console.table(rows)
if (scan) console.log("inverted: triangles with a vertex normal against the face; folded: face normal against its edge neighbours; open: level 0 edges with one triangle (expected on an open mesh; coarser levels are not whole surfaces, since groups that cannot simplify are carried to later levels)")
if (issues.length > 0) {
  console.error(`\n${issues.length} issue${issues.length === 1 ? "" : "s"}:`)
  for (const message of issues) console.error(`  ${message}`)
  process.exit(1)
}
console.log("\nok")
