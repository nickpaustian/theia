// Wire bytes per vertex for the same pages at coarser position grids, and without normals:
// decode child pages reached from the roots, requantise, re-encode through meshopt, and sum.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MeshoptEncoder } from "meshoptimizer/encoder"
import { codecReady, decodePage, encodeOctahedral } from "../tools/page.mjs"

const dir = process.argv[2]
const maxPages = Number(process.argv[3] ?? 1500)
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
await codecReady()
const levels = manifest.levels.map((l) => readFileSync(join(dir, l.file)))
const q = manifest.quantisation
const RW = 32, NONE = 0xffffffff

// Normals from the page's own triangles, area weighted, so a residual against them needs no parent.
const derivedNormals = (vertices, indices) => {
  const count = vertices.length / 8
  const d = new Float32Array(count * 3)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 8, b = indices[t + 1] * 8, c = indices[t + 2] * 8
    const e1 = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]], e2 = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]]
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    for (const vi of [indices[t], indices[t + 1], indices[t + 2]]) { d[vi * 3] += n[0]; d[vi * 3 + 1] += n[1]; d[vi * 3 + 2] += n[2] }
  }
  for (let v = 0; v < count; v++) { const l = Math.hypot(d[v * 3], d[v * 3 + 1], d[v * 3 + 2]) || 1; d[v * 3] /= l; d[v * 3 + 1] /= l; d[v * 3 + 2] /= l }
  return d
}
const pack = (vertices, bits, withNormals, withUv, residualNormals = null) => {
  const count = vertices.length / 8
  const stride = 12 + (withNormals ? 4 : 0) + (withUv ? 4 : 0)
  const out = new Uint8Array(count * stride)
  const view = new DataView(out.buffer)
  const shift = q.positionBits - bits
  for (let v = 0; v < count; v++) {
    const f = v * 8, at = v * stride
    for (let k = 0; k < 3; k++) view.setUint32(at + k * 4, Math.round((vertices[f + k] - q.origin[k]) / q.step) >>> shift, true)
    let o = at + 12
    if (withNormals) {
      let [u, w] = encodeOctahedral(vertices[f + 3], vertices[f + 4], vertices[f + 5])
      if (residualNormals) { const [du, dw] = encodeOctahedral(residualNormals[v * 3], residualNormals[v * 3 + 1], residualNormals[v * 3 + 2]); u = Math.max(-32768, Math.min(32767, u - du)); w = Math.max(-32768, Math.min(32767, w - dw)) }
      view.setInt16(o, u, true); view.setInt16(o + 2, w, true); o += 4
    }
    if (withUv) { view.setUint16(o, Math.round(vertices[f + 6] * 65535), true); view.setUint16(o + 2, Math.round(vertices[f + 7] * 65535), true) }
  }
  return MeshoptEncoder.encodeVertexBuffer(out, count, stride).byteLength
}

const queue = manifest.roots.map((r) => ({ id: r.id, level: r.level, offset: r.offset, length: r.length }))
const seen = new Set()
const variants = { "20-bit (now)": [20, true, true], "16-bit": [16, true, true], "16-bit, normals as residuals": [16, true, true, "residual"], "16-bit, no normals": [16, false, true], "16-bit, no normals, no uv": [16, false, false] }
const bytes = Object.fromEntries(Object.keys(variants).map((k) => [k, 0]))
let vertices = 0, indexBytes = 0, pages = 0, recorded = 0
while (queue.length && pages < maxPages) {
  const p = queue.shift()
  if (seen.has(p.id)) continue
  seen.add(p.id)
  const page = decodePage(levels[p.level].subarray(p.offset, p.offset + p.length), manifest)
  pages++
  const words = new Uint32Array(levels[p.level].buffer, levels[p.level].byteOffset + p.offset, 6)
  recorded += words[4]
  indexBytes += words[5]
  vertices += page.vertexCount
  const derived = derivedNormals(page.vertices, page.indices)
  for (const [name, [bits, n, uv, residual]] of Object.entries(variants)) bytes[name] += pack(page.vertices, bits, n, uv, residual ? derived : null)
  for (let c = 0; c < page.clusterCount; c++) {
    const w = c * RW
    const child = page.records[w + 2]
    if (child !== NONE && !seen.has(child)) queue.push({ id: child, level: page.records[w + 24], offset: page.records[w + 25], length: page.records[w + 26] })
  }
}
console.log(`${dir.split("/").pop()}: ${pages} pages, ${vertices} vertices; recorded vertex bytes ${(recorded / vertices).toFixed(1)} B/vertex, indices ${(indexBytes / vertices).toFixed(1)} B/vertex, step ${(q.step * 1000).toFixed(4)} mm at ${q.positionBits} bits`)
for (const [name, b] of Object.entries(bytes)) console.log(`  ${name.padEnd(26)} ${(b / vertices).toFixed(1)} B/vertex`)
