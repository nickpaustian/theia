// How small would child pages be if each vertex were sent relative to its parent page's surface?
// Walks a built hierarchy from the roots, pairs child pages with the parent page that reaches
// them, predicts each child vertex as the nearest point on the parent's triangles (triangle
// index + 8-bit barycentrics), and measures the residuals on the quantisation grid, the UV
// residuals, and how far stored normals are from ones derived from the child's own triangles.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { codecReady, decodePage } from "../tools/page.mjs"

const dir = process.argv[2]
const maxPairs = Number(process.argv[3] ?? 1500)
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
await codecReady()
const levels = manifest.levels.map((l) => readFileSync(join(dir, l.file)))
const q = manifest.quantisation
const RW = 32, NONE = 0xffffffff
const decodeAt = (level, offset, length) => decodePage(levels[level].subarray(offset, offset + length), manifest)

// Closest point on triangle abc to p (Ericson), returning barycentrics.
const closest = (p, a, b, c) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0]
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]]
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0]
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0] }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1]
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w] }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  return [1 - v - w, v, w]
}

const entropy = (counts) => { let n = 0; for (const c of counts.values()) n += c; let h = 0; for (const c of counts.values()) { const p = c / n; h -= p * Math.log2(p) }; return h }
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

const queue = manifest.roots.map((r) => ({ id: r.id, level: r.level, offset: r.offset, length: r.length }))
const seen = new Set()
let pairs = 0, vertices = 0, codedVertexBytes = 0, rawVertexBytes = 0
const resCounts = new Map(), uvCounts = new Map(), triBits = [], normalAngles = [], derivedAngles = []
let withinOne = 0, withinFour = 0
while (queue.length && pairs < maxPairs) {
  const p = queue.shift()
  if (seen.has(p.id)) continue
  seen.add(p.id)
  const parent = decodeAt(p.level, p.offset, p.length)
  const pv = parent.vertices, pi = parent.indices
  const triCount = pi.length / 3
  for (let c = 0; c < parent.clusterCount; c++) {
    const w = c * RW
    const child = parent.records[w + 2]
    if (child === NONE || seen.has(child)) continue
    const level = parent.records[w + 24], offset = parent.records[w + 25], length = parent.records[w + 26]
    queue.push({ id: child, level, offset, length })
    if (pairs >= maxPairs) continue
    const page = decodeAt(level, offset, length)
    pairs++
    const words = new Uint32Array(levels[level].buffer, levels[level].byteOffset + offset, 6)
    codedVertexBytes += words[4]
    rawVertexBytes += page.vertexCount * 20
    const cv = page.vertices, ci = page.indices
    // Derived normals: area-weighted average of the child's own triangle normals per vertex.
    const derived = new Float32Array(page.vertexCount * 3)
    for (let t = 0; t < ci.length; t += 3) {
      const a = ci[t] * 8, b = ci[t + 1] * 8, cc = ci[t + 2] * 8
      const e1 = [cv[b] - cv[a], cv[b + 1] - cv[a + 1], cv[b + 2] - cv[a + 2]], e2 = [cv[cc] - cv[a], cv[cc + 1] - cv[a + 1], cv[cc + 2] - cv[a + 2]]
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
      for (const vi of [ci[t], ci[t + 1], ci[t + 2]]) { derived[vi * 3] += n[0]; derived[vi * 3 + 1] += n[1]; derived[vi * 3 + 2] += n[2] }
    }
    for (let v = 0; v < page.vertexCount; v++) {
      const o = v * 8
      const pos = [cv[o], cv[o + 1], cv[o + 2]]
      let best = Infinity, bestTri = -1, bestBary = null
      for (let t = 0; t < triCount; t++) {
        const a = pi[t * 3] * 8, b = pi[t * 3 + 1] * 8, cc = pi[t * 3 + 2] * 8
        const A = [pv[a], pv[a + 1], pv[a + 2]], B = [pv[b], pv[b + 1], pv[b + 2]], C = [pv[cc], pv[cc + 1], pv[cc + 2]]
        const bary = closest(pos, A, B, C)
        const x = bary[0] * A[0] + bary[1] * B[0] + bary[2] * C[0], y = bary[0] * A[1] + bary[1] * B[1] + bary[2] * C[1], z = bary[0] * A[2] + bary[1] * B[2] + bary[2] * C[2]
        const d = (x - pos[0]) ** 2 + (y - pos[1]) ** 2 + (z - pos[2]) ** 2
        if (d < best) { best = d; bestTri = t; bestBary = bary }
      }
      // Barycentrics at 8 bits each (the third implied), the prediction from the quantised ones.
      const qb1 = Math.round(bestBary[1] * 255) / 255, qb2 = Math.round(bestBary[2] * 255) / 255, qb0 = 1 - qb1 - qb2
      const a = pi[bestTri * 3] * 8, b = pi[bestTri * 3 + 1] * 8, cc = pi[bestTri * 3 + 2] * 8
      const pred = [0, 1, 2].map((k) => qb0 * pv[a + k] + qb1 * pv[b + k] + qb2 * pv[cc + k])
      let maxRes = 0
      for (let k = 0; k < 3; k++) {
        const r = Math.round((pos[k] - q.origin[k]) / q.step) - Math.round((pred[k] - q.origin[k]) / q.step)
        bump(resCounts, r)
        maxRes = Math.max(maxRes, Math.abs(r))
      }
      if (maxRes <= 1) withinOne++
      if (maxRes <= 4) withinFour++
      for (let k = 0; k < 2; k++) {
        const predUv = qb0 * pv[a + 6 + k] + qb1 * pv[b + 6 + k] + qb2 * pv[cc + 6 + k]
        bump(uvCounts, Math.round(cv[o + 6 + k] * 65535) - Math.round(predUv * 65535))
      }
      triBits.push(Math.log2(Math.max(1, triCount)))
      // Normals: the parent's interpolated one, and the child's derived one, against the stored one.
      const n = [cv[o + 3], cv[o + 4], cv[o + 5]]
      const pn = [0, 1, 2].map((k) => qb0 * pv[a + 3 + k] + qb1 * pv[b + 3 + k] + qb2 * pv[cc + 3 + k])
      const pl = Math.hypot(...pn) || 1
      normalAngles.push((Math.acos(Math.min(1, Math.max(-1, (n[0] * pn[0] + n[1] * pn[1] + n[2] * pn[2]) / pl))) * 180) / Math.PI)
      const dn = [derived[v * 3], derived[v * 3 + 1], derived[v * 3 + 2]]
      const dl = Math.hypot(...dn) || 1
      derivedAngles.push((Math.acos(Math.min(1, Math.max(-1, (n[0] * dn[0] + n[1] * dn[1] + n[2] * dn[2]) / dl))) * 180) / Math.PI)
      vertices++
    }
  }
}
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const hRes = entropy(resCounts), hUv = entropy(uvCounts)
const triBitsMean = triBits.reduce((n, b) => n + b, 0) / triBits.length
console.log(`${dir.split("/").pop()}: ${pairs} parent/child pairs, ${vertices} child vertices`)
console.log(`  now on the wire: ${(codedVertexBytes / vertices).toFixed(1)} B/vertex after meshopt (${(rawVertexBytes / vertices).toFixed(0)} raw)`)
console.log(`  position residuals on the grid: within ±1 ${(100 * withinOne / vertices).toFixed(1)}%, within ±4 ${(100 * withinFour / vertices).toFixed(1)}%, entropy ${hRes.toFixed(2)} bits a coordinate`)
console.log(`  uv residuals: entropy ${hUv.toFixed(2)} bits a coordinate`)
console.log(`  normals: parent-interpolated vs stored p50 ${pct(normalAngles, 0.5).toFixed(1)}° p90 ${pct(normalAngles, 0.9).toFixed(1)}°; derived-from-triangles vs stored p50 ${pct(derivedAngles, 0.5).toFixed(1)}° p90 ${pct(derivedAngles, 0.9).toFixed(1)}° p99 ${pct(derivedAngles, 0.99).toFixed(1)}°`)
const estimate = (triBitsMean + 16 + 3 * hRes + 2 * hUv) / 8
console.log(`  estimate with residuals, derived normals: ${estimate.toFixed(1)} B/vertex (tri ${(triBitsMean / 8).toFixed(1)} + bary 2.0 + pos ${(3 * hRes / 8).toFixed(1)} + uv ${(2 * hUv / 8).toFixed(1)})`)
