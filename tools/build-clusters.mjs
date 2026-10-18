#!/usr/bin/env node
// Builds a Theia cluster hierarchy from a glTF binary with meshoptimizer.
//
//   theia build <input.glb> <outDir> [--max-tris 124] [--max-verts 64] [--group 4] [--max-group 8] [--target-tris N] [--mesh name|index] [--permissive] [--partition] [--regularize] [--position-bits 20] [--force]
//
// Level 0 is the master mesh (optionally pre-simplified to --target-tris) cut into meshlets.
// Each further level merges small groups of adjacent clusters, simplifies the group with its
// boundary locked (so neighbouring groups still meet exactly), and cuts the result into new
// meshlets. A group that cannot simplify is carried up whole into the next level, where it is
// grouped again with more neighbours, so the hierarchy always closes to a handful of roots.
// A mesh whose UV layout is broken into many small islands, as photogrammetry often is, stalls
// instead: the simplifier will not collapse across a seam, so tiny islands stay rigid. With
// --permissive a group that cannot simplify is tried again with its vertices joined by position,
// so seams no longer exist for it, which closes the hierarchy at the price of texture stretched
// over the seams it crossed.
//
// A group's member clusters form one PAGE, the unit of streaming: the clusters it produced
// all share the group's error and bounds, so when any of them is too coarse the whole page
// beneath is what the renderer needs. Pages are byte ranges inside per-level files.
//
// Output (format 3):
//   manifest.json  counts, level files, root pages with byte ranges, arena sizing, and the
//                  position grid the vertices are quantised on
//   level-<n>.bin  pages back to back, each self-describing: a 6-word header (page id, cluster,
//                  vertex and index counts, encoded vertex and index bytes), one 32-word record
//                  per cluster (see writeRecord: level, page, child page id, index/vertex offsets
//                  and counts, self error and bounds, parent error and bounds, normal cone, the
//                  child page's level/offset/length, UV centroid, cluster id), then the vertices
//                  (20 bytes each before the codec: position on the grid as three u32, normal as
//                  two octahedral snorm16, UV as two unorm16; duplicated per cluster) and the
//                  uint16 indices local to the page, each block packed by meshoptimizer's codec
//                  and padded to a word. Nothing is tabled up front; see docs/formats.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { MeshoptClusterizer } from "meshoptimizer/clusterizer"
import { MeshoptSimplifier } from "meshoptimizer/simplifier"
import { codecReady, encodeBlocks, quantisationFor, VERTEX_BYTES, headerWords } from "./page.mjs"

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith("--"))
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const fail = (message) => {
  console.error(`build-clusters: ${message}`)
  process.exit(1)
}
const [input, outDir] = positional
if (!input || !outDir) {
  fail("usage: theia build <input.glb> <outDir> [--max-tris 124] [--max-verts 64] [--group 4] [--max-group 8] [--target-tris N] [--mesh name|index] [--permissive] [--partition] [--regularize] [--position-bits 20] [--force]")
}
if (!existsSync(input) || !statSync(input).isFile()) fail(`${input} is not a file`)
if (existsSync(outDir) && readdirSync(outDir).length > 0) {
  if (!args.includes("--force")) fail(`${outDir} is not empty; pass --force to replace its contents`)
  rmSync(outDir, { recursive: true, force: true })
}
const maxTriangles = Number(option("max-tris", 124))
const maxVertices = Number(option("max-verts", 64))
const baseGroupSize = Number(option("group", 4))
// Pages are group members, so the largest group bounds the page and with it every arena slot
const maxGroupSize = Number(option("max-group", 8))
const targetTriangles = Number(option("target-tris", 0))
const meshChoice = option("mesh", null)
const permissive = args.includes("--permissive")
// Group clusters by meshoptimizer's partitioner (ported below) instead of the greedy pass
const partition = args.includes("--partition")
// meshoptimizer's Regularize: more even triangle sizes and shapes as groups simplify, at a small cost in error
const simplifyFlags = args.includes("--regularize") ? ["LockBorder", "Regularize"] : ["LockBorder"]
// Bits per axis of the position grid; 20 puts a step under a micron on a metre-sized object
const positionBits = Number(option("position-bits", 20))
if (!(positionBits >= 8 && positionBits <= 32)) fail("--position-bits must be between 8 and 32")
await codecReady()
const FLOATS = 8 // px py pz nx ny nz u v
const STRIDE = FLOATS // strides are in floats for the JS bindings
const NONE = 0xffffffff

//=========================
// glTF binary reader (first primitive, float attributes, uint16/32 indices, no extensions)
//=========================

const readGlb = (path) => {
  const data = readFileSync(path)
  if (data.length < 20 || data.readUInt32LE(0) !== 0x46546c67) fail(`${path} is not a glTF binary`)
  const jsonLength = data.readUInt32LE(12)
  const json = JSON.parse(data.subarray(20, 20 + jsonLength).toString())
  const bin = data.subarray(20 + jsonLength + 8)

  const accessorArray = (index, Type) => {
    const accessor = json.accessors[index]
    const view = json.bufferViews[accessor.bufferView]
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type]
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const elementBytes = Type.BYTES_PER_ELEMENT * components
    const stride = view.byteStride ?? elementBytes
    if (stride === elementBytes) {
      const start = bin.byteOffset + offset
      return new Type(bin.buffer.slice(start, start + accessor.count * elementBytes))
    }
    const out = new Type(accessor.count * components)
    for (let i = 0; i < accessor.count; i++) {
      const at = bin.byteOffset + offset + i * stride
      out.set(new Type(bin.buffer.slice(at, at + elementBytes)), i * components)
    }
    return out
  }

  const meshes = json.meshes ?? []
  const describe = (m, i) => `${i}: ${m.name ?? "(unnamed)"}, ${m.primitives.length} primitive${m.primitives.length === 1 ? "" : "s"}, ${json.accessors[m.primitives[0]?.indices]?.count / 3 || "?"} triangles`
  let meshIndex = 0
  if (meshChoice !== null) {
    meshIndex = /^\d+$/.test(meshChoice) ? Number(meshChoice) : meshes.findIndex((m) => m.name === meshChoice)
    if (!meshes[meshIndex]) fail(`no mesh ${meshChoice}; the file has:\n  ${meshes.map(describe).join("\n  ")}`)
  } else if (meshes.length !== 1) {
    fail(`the file has ${meshes.length} meshes; pick one with --mesh:\n  ${meshes.map(describe).join("\n  ")}`)
  }
  const mesh = meshes[meshIndex]
  if (mesh.primitives.length !== 1) fail(`mesh ${describe(mesh, meshIndex)} must have exactly one primitive; join or split it first`)
  const primitive = mesh.primitives[0]
  if (primitive.extensions) fail(`unsupported primitive extensions: ${Object.keys(primitive.extensions)}`)
  if ((primitive.mode ?? 4) !== 4) fail("primitive is not a triangle list")
  if (primitive.indices === undefined) fail("primitive is not indexed")
  if (primitive.attributes.POSITION === undefined) fail("primitive has no POSITION attribute")
  if (primitive.attributes.TEXCOORD_0 === undefined) fail("primitive has no TEXCOORD_0 attribute; a UV set is required")
  const indexAccessor = json.accessors[primitive.indices]
  const IndexType = indexAccessor.componentType === 5123 ? Uint16Array : Uint32Array
  const positions = accessorArray(primitive.attributes.POSITION, Float32Array)
  const normals = primitive.attributes.NORMAL !== undefined ? accessorArray(primitive.attributes.NORMAL, Float32Array) : null
  const uvs = primitive.attributes.TEXCOORD_0 !== undefined ? accessorArray(primitive.attributes.TEXCOORD_0, Float32Array) : null
  const indices = Uint32Array.from(accessorArray(primitive.indices, IndexType))

  const count = positions.length / 3
  const vertices = new Float32Array(count * FLOATS)
  for (let i = 0; i < count; i++) {
    vertices.set(positions.subarray(i * 3, i * 3 + 3), i * FLOATS)
    if (normals) vertices.set(normals.subarray(i * 3, i * 3 + 3), i * FLOATS + 3)
    if (uvs) vertices.set(uvs.subarray(i * 2, i * 2 + 2), i * FLOATS + 6)
  }
  return { vertices, indices, hasNormals: normals !== null, name: mesh.name ?? basename(path) }
}

//=========================
// Helpers
//=========================

// Each vertex's first vertex at the same position, for simplifying as though no UV or normal
// seam split the surface: the indices then name one vertex per point, so every seam is gone.
const positionRemap = (vertices) => {
  const count = vertices.length / FLOATS
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
  const remap = new Uint32Array(count)
  let tableBits = 1
  while (1 << tableBits < count * 2) tableBits++
  const table = new Uint32Array(1 << tableBits) // vertex + 1, 0 = empty
  const mask = (1 << tableBits) - 1
  for (let v = 0; v < count; v++) {
    const base = v * FLOATS
    let h = 2166136261
    for (let k = 0; k < 3; k++) h = Math.imul(h ^ words[base + k], 16777619)
    let slot = (h >>> 0) & mask
    while (true) {
      const entry = table[slot]
      if (entry === 0) { table[slot] = v + 1; remap[v] = v; break }
      const w = (entry - 1) * FLOATS
      if (vertices[w] === vertices[base] && vertices[w + 1] === vertices[base + 1] && vertices[w + 2] === vertices[base + 2]) { remap[v] = entry - 1; break }
      slot = (slot + 1) & mask
    }
  }
  return remap
}

// Welds exact duplicate vertices (all 8 floats) so per-cluster copies rejoin for simplification.
// Typed arrays and an open-addressing hash throughout: a plain array of 8 floats per vertex
// overflows V8's array limit on a 29M-triangle mesh, and string keys are far too slow.
const weld = (vertices, indices) => {
  const count = vertices.length / FLOATS
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
  const remap = new Uint32Array(count)
  const welded = new Float32Array(vertices.length)
  let tableBits = 1
  while (1 << tableBits < count * 2) tableBits++
  const table = new Uint32Array(1 << tableBits) // welded index + 1, 0 = empty
  const mask = (1 << tableBits) - 1
  let next = 0

  for (let v = 0; v < count; v++) {
    const base = v * FLOATS
    let h = 2166136261
    for (let k = 0; k < FLOATS; k++) {
      h ^= words[base + k]
      h = Math.imul(h, 16777619)
    }
    let slot = (h >>> 0) & mask
    while (true) {
      const entry = table[slot]
      if (entry === 0) {
        table[slot] = next + 1
        welded.set(vertices.subarray(base, base + FLOATS), next * FLOATS)
        remap[v] = next
        next++
        break
      }
      const w = (entry - 1) * FLOATS
      let same = true
      for (let k = 0; k < FLOATS; k++) {
        if (welded[w + k] !== vertices[base + k]) { same = false; break }
      }
      if (same) { remap[v] = entry - 1; break }
      slot = (slot + 1) & mask
    }
  }
  return { vertices: welded.subarray(0, next * FLOATS), indices: indices.map((i) => remap[i]), remap }
}

// Numbers vertices by position alone, so UV-seam copies of one point share an id
const positionIds = (vertices) => {
  const count = vertices.length / FLOATS
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length)
  const ids = new Uint32Array(count)
  let tableBits = 1
  while (1 << tableBits < count * 2) tableBits++
  const table = new Uint32Array(1 << tableBits) // vertex index + 1, 0 = empty
  const mask = (1 << tableBits) - 1
  let next = 0
  for (let v = 0; v < count; v++) {
    const base = v * FLOATS
    let h = 2166136261
    for (let k = 0; k < 3; k++) {
      h ^= words[base + k]
      h = Math.imul(h, 16777619)
    }
    let slot = (h >>> 0) & mask
    while (true) {
      const entry = table[slot]
      if (entry === 0) {
        table[slot] = v + 1
        ids[v] = next++
        break
      }
      const w = (entry - 1) * FLOATS
      if (vertices[w] === vertices[base] && vertices[w + 1] === vertices[base + 1] && vertices[w + 2] === vertices[base + 2]) {
        ids[v] = ids[entry - 1]
        break
      }
      slot = (slot + 1) & mask
    }
  }
  return { ids, count: next }
}

// Recomputes every vertex normal of a level from the level's own faces, area weighted and
// shared across UV seams and cluster copies. The simplifier carries normals as plain attributes
// through its collapses, and locked border vertices keep theirs while the faces around them
// change, which leaves normals pointing away from the faces they sit on: a dark wedge fanning
// out from a point on the lit surface. Done over the whole level so a border vertex sees the
// faces on both sides of its group.
const refreshLevelNormals = (clusters) => {
  const total = clusters.reduce((n, c) => n + c.vertices.length / FLOATS, 0)
  const all = new Float32Array(total * FLOATS)
  let at = 0
  for (const c of clusters) { all.set(c.vertices, at * FLOATS); at += c.vertices.length / FLOATS }
  const { ids, count } = positionIds(all)
  const sums = new Float64Array(count * 3)
  at = 0
  for (const c of clusters) {
    const v = c.vertices, tri = c.indices
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t] * FLOATS, b = tri[t + 1] * FLOATS, d = tri[t + 2] * FLOATS
      const abx = v[b] - v[a], aby = v[b + 1] - v[a + 1], abz = v[b + 2] - v[a + 2]
      const acx = v[d] - v[a], acy = v[d + 1] - v[a + 1], acz = v[d + 2] - v[a + 2]
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
      for (const corner of [tri[t], tri[t + 1], tri[t + 2]]) {
        const id = ids[at + corner] * 3
        sums[id] += nx; sums[id + 1] += ny; sums[id + 2] += nz
      }
    }
    at += c.vertices.length / FLOATS
  }
  at = 0
  for (const c of clusters) {
    const v = c.vertices
    for (let i = 0; i < v.length / FLOATS; i++) {
      const id = ids[at + i] * 3
      const length = Math.hypot(sums[id], sums[id + 1], sums[id + 2])
      if (length === 0) continue
      v[i * FLOATS + 3] = sums[id] / length
      v[i * FLOATS + 4] = sums[id + 1] / length
      v[i * FLOATS + 5] = sums[id + 2] / length
    }
    at += v.length / FLOATS
  }
}

// Drops vertices no index refers to and renumbers
const compact = (vertices, indices) => {
  const count = vertices.length / FLOATS
  const used = new Int32Array(count).fill(-1)
  let next = 0
  for (const i of indices) if (used[i] === -1) used[i] = next++
  const out = new Float32Array(next * FLOATS)
  for (let v = 0; v < count; v++) if (used[v] !== -1) out.set(vertices.subarray(v * FLOATS, v * FLOATS + FLOATS), used[v] * FLOATS)
  return { vertices: out, indices: indices.map((i) => used[i]) }
}

const mergeSpheres = (spheres) => {
  let [cx, cy, cz, r] = spheres.reduce((a, b) => (b[3] > a[3] ? b : a))
  for (const [x, y, z, radius] of spheres) {
    const dx = x - cx, dy = y - cy, dz = z - cz
    const d = Math.hypot(dx, dy, dz)
    if (d + radius <= r) continue
    const newR = (d + radius + r) / 2
    const t = d > 0 ? (newR - r) / d : 0
    cx += dx * t; cy += dy * t; cz += dz * t
    r = newR
  }
  return [cx, cy, cz, r]
}

const attributesOf = (vertices) => {
  const count = vertices.length / FLOATS
  const attributes = new Float32Array(count * 5)
  for (let v = 0; v < count; v++) attributes.set(vertices.subarray(v * FLOATS + 3, v * FLOATS + 8), v * 5)
  return attributes
}

// Cuts a (welded) index buffer into meshlets, returning per-cluster vertex copies and indices
const clusterise = (vertices, indices) => {
  const buffers = MeshoptClusterizer.buildMeshlets(indices, vertices, STRIDE, maxVertices, maxTriangles, 0)
  const clusters = []
  for (let m = 0; m < buffers.meshletCount; m++) {
    const meshlet = MeshoptClusterizer.extractMeshlet(buffers, m)
    const local = new Float32Array(meshlet.vertices.length * FLOATS)
    meshlet.vertices.forEach((v, i) => local.set(vertices.subarray(v * FLOATS, v * FLOATS + FLOATS), i * FLOATS))
    const tri = Uint32Array.from(meshlet.triangles)
    const bounds = MeshoptClusterizer.computeClusterBounds(tri, local, STRIDE)
    clusters.push({
      vertices: local,
      indices: tri,
      bounds: [bounds.centerX, bounds.centerY, bounds.centerZ, bounds.radius],
      // Normal cone: the cluster is wholly back-facing when dot(normalize(apex - eye), axis) >= cutoff
      cone: [bounds.coneApexX, bounds.coneApexY, bounds.coneApexZ, bounds.coneAxisX, bounds.coneAxisY, bounds.coneAxisZ, bounds.coneCutoff],
    })
  }
  return clusters
}

// meshoptimizer's meshopt_partitionClusters (partition.cpp, MIT, Arseny Kapoulkine), ported:
// Kurita's agglomerative clustering on a heap. Every cluster starts as a group; the group with
// the fewest vertices is merged into the adjacent group that shares the most vertices with it,
// the count normalised by each group's expected boundary (√vertices) and favouring groups whose
// bounding spheres overlap, until groups reach the target; a spatial pass then merges what is
// left small. Compact groups have short borders, and a group's border is what stays locked when
// it simplifies, so the coarser levels keep fewer slivers. Unlike meshoptimizer's, groups never
// exceed `groupSize`, since a group is a page and `--max-group` bounds every arena slot.
const partitionClusters = (clusters, groupSize, byPosition) => {
  const count = clusters.length
  const total = clusters.reduce((n, c) => n + c.vertices.length / FLOATS, 0)
  const all = new Float32Array(total * FLOATS)
  let at = 0
  for (const c of clusters) { all.set(c.vertices, at * FLOATS); at += c.vertices.length / FLOATS }
  const remap = byPosition ? positionRemap(all) : weld(all, new Uint32Array(0)).remap
  // Each cluster's distinct welded vertices, and the clusters each vertex belongs to.
  const offsets = new Uint32Array(count + 1)
  const lists = []
  at = 0
  clusters.forEach((cluster, c) => {
    const n = cluster.vertices.length / FLOATS
    const unique = new Set()
    for (let i = 0; i < n; i++) unique.add(remap[at + i])
    lists.push([...unique])
    offsets[c + 1] = offsets[c] + unique.size
    at += n
  })
  const owners = new Map()
  lists.forEach((list, c) => { for (const v of list) { let o = owners.get(v); if (!o) owners.set(v, (o = [])); o.push(c) } })
  const adjacency = lists.map((list, c) => {
    const shared = new Map()
    for (const v of list) for (const other of owners.get(v)) if (other !== c) shared.set(other, (shared.get(other) ?? 0) + 1)
    return shared
  })
  const group = new Int32Array(count), next = new Int32Array(count).fill(-1), size = new Uint32Array(count).fill(1)
  const vertices = new Float64Array(count), centre = new Float64Array(count * 3), radius = new Float64Array(count)
  for (let c = 0; c < count; c++) {
    group[c] = c
    vertices[c] = lists[c].length
    const v = clusters[c].vertices, n = v.length / FLOATS
    let x = 0, y = 0, z = 0
    for (let i = 0; i < n; i++) { x += v[i * FLOATS]; y += v[i * FLOATS + 1]; z += v[i * FLOATS + 2] }
    x /= n; y /= n; z /= n
    let r = 0
    for (let i = 0; i < n; i++) r = Math.max(r, Math.hypot(v[i * FLOATS] - x, v[i * FLOATS + 1] - y, v[i * FLOATS + 2] - z))
    centre[c * 3] = x; centre[c * 3 + 1] = y; centre[c * 3 + 2] = z; radius[c] = r
  }
  const boundsScore = (a, b) => {
    const d = Math.hypot(centre[b * 3] - centre[a * 3], centre[b * 3 + 1] - centre[a * 3 + 1], centre[b * 3 + 2] - centre[a * 3 + 2])
    const r1 = radius[a], r2 = radius[b]
    const merged = d + r1 < r2 ? r2 : d + r2 < r1 ? r1 : (d + r2 + r1) / 2
    return merged > 0 ? r1 / merged : 0
  }
  const mergeBounds = (into, from) => {
    const r1 = radius[into], r2 = radius[from]
    const dx = centre[from * 3] - centre[into * 3], dy = centre[from * 3 + 1] - centre[into * 3 + 1], dz = centre[from * 3 + 2] - centre[into * 3 + 2]
    const d = Math.hypot(dx, dy, dz)
    if (d + r1 < r2) { centre[into * 3] = centre[from * 3]; centre[into * 3 + 1] = centre[from * 3 + 1]; centre[into * 3 + 2] = centre[from * 3 + 2]; radius[into] = r2; return }
    if (d + r2 > r1) {
      const k = d > 0 ? (d + r2 - r1) / (2 * d) : 0
      centre[into * 3] += dx * k; centre[into * 3 + 1] += dy * k; centre[into * 3 + 2] += dz * k
      radius[into] = (d + r2 + r1) / 2
    }
  }
  const link = (into, from) => { let tail = into; while (next[tail] >= 0) tail = next[tail]; next[tail] = from }
  // A binary min-heap of [vertices, group].
  const heap = []
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0 && heap[i][0] < heap[(i - 1) >> 1][0]) { const p = (i - 1) >> 1; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p } }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { let j = i * 2 + 1; if (j >= heap.length) break; if (j + 1 < heap.length && heap[j + 1][0] < heap[j][0]) j++; if (heap[j][0] >= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j } }
    return top
  }
  for (let c = 0; c < count; c++) push([vertices[c], c])
  while (heap.length) {
    const [, id] = pop()
    if (size[id] === 0) continue
    for (let i = id; i >= 0; i = next[i]) group[i] = -1
    if (size[id] >= groupSize) continue
    const acc = new Map()
    for (let ci = id; ci >= 0; ci = next[ci]) for (const [other, n] of adjacency[ci]) { const g = group[other]; if (g >= 0) acc.set(g, (acc.get(g) ?? 0) + n) }
    let best = -1, bestScore = 0, bestShared = 0
    const own = 1 / Math.sqrt(vertices[id])
    for (const [g, shared] of acc) {
      if (size[id] + size[g] > groupSize) continue
      const score = shared * (own + 1 / Math.sqrt(vertices[g])) * (1 + 0.4 * boundsScore(id, g))
      if (score > bestScore) { best = g; bestScore = score; bestShared = shared }
    }
    if (best === -1) continue
    link(id, best)
    size[id] += size[best]
    vertices[id] = Math.max(1, vertices[id] + vertices[best] - bestShared)
    size[best] = 0
    vertices[best] = 0
    mergeBounds(id, best)
    radius[best] = 0
    for (let i = id; i >= 0; i = next[i]) group[i] = id
    push([vertices[id], id])
  }
  // Spatial pass: groups still under the target merge with nearby ones, within leaves of a median split.
  const order = []
  for (let c = 0; c < count; c++) if (size[c]) order.push(c)
  const mergeLeaf = (ids) => {
    for (const id of ids) {
      if (size[id] === 0 || size[id] >= groupSize) continue
      let best = -1, bestScore = -1
      for (const other of ids) {
        if (other === id || size[other] === 0 || size[id] + size[other] > groupSize) continue
        const score = boundsScore(id, other)
        if (score > bestScore) { bestScore = score; best = other }
      }
      if (best !== -1) { link(best, id); size[best] += size[id]; size[id] = 0; mergeBounds(best, id); radius[id] = 0 }
    }
  }
  const mergeSpatial = (ids, depth) => {
    const total = ids.reduce((n, id) => n + size[id], 0)
    if (total <= groupSize || ids.length <= 8 || depth >= 40) return mergeLeaf(ids)
    const mean = [0, 0, 0], vars = [0, 0, 0]
    ids.forEach((id, i) => { for (let k = 0; k < 3; k++) { const p = centre[id * 3 + k], delta = p - mean[k]; mean[k] += delta / (i + 1); vars[k] += delta * (p - mean[k]) } })
    const axis = vars[0] >= vars[1] && vars[0] >= vars[2] ? 0 : vars[1] >= vars[2] ? 1 : 2
    let low = ids.filter((id) => centre[id * 3 + axis] < mean[axis]), high = ids.filter((id) => centre[id * 3 + axis] >= mean[axis])
    if (low.length <= 4 || high.length <= 4) { const sorted = [...ids].sort((a, b) => centre[a * 3 + axis] - centre[b * 3 + axis]); low = sorted.slice(0, sorted.length >> 1); high = sorted.slice(sorted.length >> 1) }
    mergeSpatial(low, depth + 1)
    mergeSpatial(high, depth + 1)
  }
  mergeSpatial(order, 0)
  const groups = []
  for (let c = 0; c < count; c++) {
    if (!size[c]) continue
    const members = []
    for (let i = c; i >= 0; i = next[i]) members.push(i)
    groups.push(members)
  }
  return groups
}

// Greedy grouping of adjacent clusters, groupSize at a time, by welding the whole level
const groupClusters = (clusters, groupSize, byPosition = false) => {
  if (partition) return partitionClusters(clusters, groupSize, byPosition)
  const total = clusters.reduce((n, c) => n + c.vertices.length / FLOATS, 0)
  const all = new Float32Array(total * FLOATS)
  let at = 0
  for (const c of clusters) { all.set(c.vertices, at * FLOATS); at += c.vertices.length / FLOATS }
  // Neighbours share vertices; with byPosition, also across UV seams, which on a mesh of tiny UV
  // islands is the only way most clusters have neighbours at all
  const remap = byPosition ? positionRemap(all) : weld(all, new Uint32Array(0)).remap
  const owners = new Map()
  at = 0
  clusters.forEach((cluster, c) => {
    const count = cluster.vertices.length / FLOATS
    for (let i = 0; i < count; i++) {
      const v = remap[at + i]
      let list = owners.get(v)
      if (!list) owners.set(v, (list = []))
      if (list[list.length - 1] !== c) list.push(c)
    }
    at += count
  })
  const shared = clusters.map(() => new Map())
  for (const list of owners.values()) {
    for (const a of list) for (const b of list) if (a !== b) shared[a].set(b, (shared[a].get(b) ?? 0) + 1)
  }
  const grouped = new Uint8Array(clusters.length)
  const groups = []
  const order = clusters.map((_, c) => c).sort((a, b) => shared[a].size - shared[b].size)
  for (const seed of order) {
    if (grouped[seed]) continue
    const group = [seed]
    grouped[seed] = 1
    while (group.length < groupSize) {
      let best = -1, bestShared = 0
      for (const member of group) {
        for (const [neighbour, n] of shared[member]) {
          if (!grouped[neighbour] && n > bestShared) { best = neighbour; bestShared = n }
        }
      }
      if (best === -1) break
      group.push(best)
      grouped[best] = 1
    }
    groups.push(group)
  }
  return groups
}

//=========================
// Build
//=========================

await MeshoptClusterizer.ready
await MeshoptSimplifier.ready

let mesh = readGlb(input)
const scale = MeshoptSimplifier.getScale(mesh.vertices, STRIDE)
console.log(`${mesh.name}: ${mesh.indices.length / 3} triangles, ${mesh.vertices.length / FLOATS} vertices, extent ${scale.toFixed(3)}`)

// Attribute weights are absolute: a unit change in a normal component costs as much as moving
// a vertex this far, likewise for a unit of UV, kept small so error stays close to geometric
const edge = scale / Math.sqrt(mesh.indices.length / 3)
const attributeWeights = [0.5 * edge, 0.5 * edge, 0.5 * edge, 2 * edge, 2 * edge]

const preSimplified = targetTriangles > 0 && mesh.indices.length / 3 > targetTriangles
if (preSimplified) {
  const t0 = Date.now()
  const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
    mesh.indices, mesh.vertices, STRIDE, attributesOf(mesh.vertices), 5, attributeWeights, null, targetTriangles * 3, 1.0, []
  )
  const compacted = compact(mesh.vertices, simplified)
  mesh = { ...mesh, vertices: compacted.vertices, indices: compacted.indices }
  console.log(`pre-simplified to ${mesh.indices.length / 3} triangles, ${mesh.vertices.length / FLOATS} vertices, error ${(error * scale).toExponential(2)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

// A cluster: { vertices, indices, bounds, selfError, selfBounds, parentError, parentBounds, level, page, childPage }
let current = clusterise(mesh.vertices, mesh.indices).map((c) => ({
  ...c, selfError: 0, selfBounds: c.bounds, parentError: Infinity, parentBounds: c.bounds, level: 0, page: NONE, childPage: NONE,
}))
if (!mesh.hasNormals) console.log("no NORMAL attribute; level 0 normals computed from the faces")
if (preSimplified || !mesh.hasNormals) refreshLevelNormals(current)
console.log(`level 0: ${current.length} clusters`)

const pages = [] // { level, clusters: [] }
let groupSize = baseGroupSize
// With --permissive, set once a level has carried up more than a quarter of its clusters: from
// there every group simplifies across seams, as retrying only the groups that fail still stalls
let acrossSeams = false

for (let level = 1; level < 32 && current.length > 1; level++) {
  const groups = groupClusters(current, groupSize, permissive)
  const next = []
  let simplifiedGroups = 0
  let permissiveGroups = 0
  let carried = 0

  for (const group of groups) {
    const members = group.map((c) => current[c])
    let offset = 0
    const parts = members.map((m) => { const indices = m.indices.map((i) => i + offset); offset += m.vertices.length / FLOATS; return indices })
    const merged = new Float32Array(offset * FLOATS)
    offset = 0
    for (const m of members) { merged.set(m.vertices, offset * FLOATS); offset += m.vertices.length / FLOATS }
    const mergedIndices = new Uint32Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) { mergedIndices.set(p, at); at += p.length }
    const { vertices, indices } = weld(merged, mergedIndices)

    const target = Math.max(3, Math.floor(indices.length / 2 / 3) * 3)
    const attributes = attributesOf(vertices)
    let source = indices
    let [simplified] = MeshoptSimplifier.simplifyWithAttributes(source, vertices, STRIDE, attributes, 5, attributeWeights, null, target, 1.0, simplifyFlags)
    if (permissive && (acrossSeams || simplified.length >= indices.length * 0.9)) {
      // Collapsing across seams: one vertex per position, so each kept vertex brings the UV of
      // whichever island it came from. meshoptimizer's own Permissive flag is not enough here, as
      // it still locks vertices where three or more islands meet, which is most of them.
      const remap = positionRemap(vertices)
      const across = indices.map((i) => remap[i])
      const [retried] = MeshoptSimplifier.simplifyWithAttributes(across, vertices, STRIDE, attributes, 5, attributeWeights, null, target, 1.0, simplifyFlags)
      if (retried.length < indices.length * 0.9) {
        source = across
        simplified = retried
        permissiveGroups++
      }
    }
    // The attribute-aware result keeps UVs and normals honest, but its error folds attribute
    // terms in; a position-only pass to the same target gives the geometric error to store,
    // which is what screen-space selection should be judged by
    const [, relativeError] = MeshoptSimplifier.simplify(source, vertices, STRIDE, target, 1.0, simplifyFlags)
    // meshoptimizer reports error relative to the extent of the mesh it was given, the group
    const groupScale = MeshoptSimplifier.getScale(vertices, STRIDE)

    // Nothing left would orphan the group's page: no parent cluster would point down to it
    if (simplified.length === 0 || simplified.length >= indices.length * 0.9) {
      // Carry the clusters up whole; a larger neighbourhood next level may free their borders
      for (const m of members) { m.level = level; next.push(m) }
      carried += members.length
      continue
    }

    simplifiedGroups++
    const groupBounds = mergeSpheres(members.map((m) => m.selfBounds))
    const groupError = Math.max(...members.map((m) => m.selfError)) + relativeError * groupScale
    const pageId = pages.length
    pages.push({ level: level - 1, clusters: members })
    for (const m of members) { m.parentError = groupError; m.parentBounds = groupBounds; m.page = pageId }
    for (const parent of clusterise(vertices, simplified)) {
      next.push({ ...parent, selfError: groupError, selfBounds: groupBounds, parentError: Infinity, parentBounds: groupBounds, level, page: NONE, childPage: pageId })
    }
  }

  if (simplifiedGroups === 0) {
    if (groupSize >= maxGroupSize) break
    groupSize *= 2
    console.log(`level ${level}: nothing simplified at group size ${groupSize / 2}; retrying with ${groupSize}`)
    level--
    continue
  }
  refreshLevelNormals(next)
  const tris = next.reduce((n, c) => n + c.indices.length / 3, 0)
  console.log(`level ${level}: ${next.length} clusters, ${tris} triangles, ${groups.length} groups of ${groupSize} (${simplifiedGroups} simplified${permissive ? `, ${permissiveGroups} across seams` : ""}, ${carried} clusters carried up)`)
  if (permissive && !acrossSeams && carried > current.length / 4) {
    acrossSeams = true
    console.log(`level ${level}: over a quarter carried up; every group simplifies across seams from here`)
  }
  current = next
  // Once most of a level is being carried, the locked borders need bigger neighbourhoods
  if (carried > next.length / 2 && groupSize < maxGroupSize) groupSize *= 2
}

// Whatever is left are roots: give them pages of their own so the renderer can start from them
const rootGroups = groupClusters(current, baseGroupSize)
for (const group of rootGroups) {
  const members = group.map((c) => current[c])
  const pageId = pages.length
  pages.push({ level: members[0].level, clusters: members })
  for (const m of members) m.page = pageId
}
const rootPages = rootGroups.map((_, i) => pages.length - rootGroups.length + i)
console.log(`${current.length} root clusters in ${rootPages.length} root pages`)

//=========================
// Write
//=========================

const levelCount = pages.reduce((n, p) => Math.max(n, p.level), 0) + 1
const levelBuffers = Array.from({ length: levelCount }, () => [])
const levelBytes = new Array(levelCount).fill(0)

// Each page is self-describing: a header, one record per cluster (with the byte range of the
// page beneath it, so nothing is needed up front but the manifest), then vertices and indices.
// A cluster's children were paged before it, so their ranges are known by the time it is written.
const RECORD_WORDS = 32
const HEADER_WORDS = headerWords(3)
// Every vertex of every level quantises on one grid over the whole hierarchy, so shared
// vertices land on the same point whichever page carries them
const gridMin = [Infinity, Infinity, Infinity], gridMax = [-Infinity, -Infinity, -Infinity]
for (const page of pages) for (const c of page.clusters) for (let i = 0; i < c.vertices.length; i += FLOATS) for (let k = 0; k < 3; k++) {
  const value = c.vertices[i + k]
  if (value < gridMin[k]) gridMin[k] = value
  if (value > gridMax[k]) gridMax[k] = value
}
const quantisation = quantisationFor(gridMin, gridMax, positionBits)
let uvClamped = 0
const pageSizes = pages.map((page) => {
  let vertexCount = 0, indexCount = 0
  for (const c of page.clusters) { vertexCount += c.vertices.length / FLOATS; indexCount += c.indices.length }
  const vertices = new Float32Array(vertexCount * FLOATS)
  const indices = new Uint32Array(indexCount)
  let v = 0, i = 0
  for (const c of page.clusters) {
    vertices.set(c.vertices, v * FLOATS)
    for (let k = 0; k < c.indices.length; k++) indices[i + k] = c.indices[k] + v
    v += c.vertices.length / FLOATS
    i += c.indices.length
  }
  const blocks = encodeBlocks(vertices, indices, quantisation)
  uvClamped += blocks.uvClamped
  return { vertexCount, indexCount, blocks, byteLength: (HEADER_WORDS + page.clusters.length * RECORD_WORDS) * 4 + blocks.byteLength }
})
const pageRanges = pages.map((page, pageId) => {
  const range = { level: page.level, offset: levelBytes[page.level], length: pageSizes[pageId].byteLength }
  levelBytes[page.level] += range.length
  return range
})
const clusterIds = new Map()
let maxPageVertices = 0, maxPageIndices = 0, maxPageClusters = 0, maxClusterVertices = 0
const writeRecord = (words, floats, o, c, pageId, indexOffset, vertexOffset) => {
  words[o] = c.level
  words[o + 1] = pageId
  words[o + 2] = c.childPage
  words[o + 3] = indexOffset
  words[o + 4] = c.indices.length
  words[o + 5] = vertexOffset
  words[o + 6] = c.vertices.length / FLOATS
  floats[o + 7] = c.selfError
  floats.set(c.selfBounds, o + 8)
  floats[o + 12] = Number.isFinite(c.parentError) ? c.parentError : 3.0e38
  floats.set(c.parentBounds, o + 13)
  floats.set(c.cone, o + 17)
  if (c.childPage !== NONE) {
    const child = pageRanges[c.childPage]
    words[o + 24] = child.level; words[o + 25] = child.offset; words[o + 26] = child.length
  } else {
    words[o + 24] = NONE; words[o + 25] = 0; words[o + 26] = 0
  }
  // UV centroid, for detail maps painted in texture space to be sampled per cluster at runtime
  let u = 0, v = 0
  const n = c.vertices.length / FLOATS
  for (let i = 0; i < n; i++) { u += c.vertices[i * FLOATS + 6]; v += c.vertices[i * FLOATS + 7] }
  floats[o + 27] = u / n; floats[o + 28] = v / n
  if (!clusterIds.has(c)) clusterIds.set(c, clusterIds.size)
  words[o + 29] = clusterIds.get(c)
}
pages.forEach((page, pageId) => {
  const { vertexCount, indexCount, blocks, byteLength } = pageSizes[pageId]
  const words = new Uint32Array(byteLength / 4)
  const floats = new Float32Array(words.buffer)
  const bytes = new Uint8Array(words.buffer)
  words[0] = pageId; words[1] = page.clusters.length; words[2] = vertexCount; words[3] = indexCount
  words[4] = blocks.vertexBlock.byteLength; words[5] = blocks.indexBlock.byteLength
  let v = 0, i = 0
  page.clusters.forEach((c, n) => {
    writeRecord(words, floats, HEADER_WORDS + n * RECORD_WORDS, c, pageId, i, v)
    maxClusterVertices = Math.max(maxClusterVertices, c.vertices.length / FLOATS)
    v += c.vertices.length / FLOATS
    i += c.indices.length
  })
  const vertexStart = (HEADER_WORDS + page.clusters.length * RECORD_WORDS) * 4
  bytes.set(blocks.vertexBlock, vertexStart)
  bytes.set(blocks.indexBlock, vertexStart + ((blocks.vertexBlock.byteLength + 3) & ~3))
  levelBuffers[page.level].push(Buffer.from(words.buffer))
  maxPageVertices = Math.max(maxPageVertices, vertexCount)
  maxPageIndices = Math.max(maxPageIndices, indexCount)
  maxPageClusters = Math.max(maxPageClusters, page.clusters.length)
})

mkdirSync(outDir, { recursive: true })
levelBuffers.forEach((chunks, level) => writeFileSync(join(outDir, `level-${level}.bin`), Buffer.concat(chunks)))
const roots = rootPages.map((id) => ({ id, ...pageRanges[id] }))
// The mesh's own sphere, from the vertex extents the grid was sized on: tight, and the same
// whatever the roots turned out to be, so a rebuild frames alike. (The roots' merged
// spheres were up to 40% looser and moved with the grouping.)
const rootSphere = (() => {
  const centre = [0, 1, 2].map((k) => (gridMin[k] + gridMax[k]) / 2)
  let radius = 0
  for (const page of pages) for (const c of page.clusters) for (let i = 0; i < c.vertices.length; i += FLOATS) {
    const d = Math.hypot(c.vertices[i] - centre[0], c.vertices[i + 1] - centre[1], c.vertices[i + 2] - centre[2])
    if (d > radius) radius = d
  }
  return [centre[0], centre[1], centre[2], radius]
})()
const manifest = {
  format: 3,
  name: mesh.name,
  // Cache-buster for the binary files, which are byte-range fetched and change size per build
  build: Date.now().toString(36),
  // The decoded layout: 8 floats a vertex, as format 2 stored them
  floatsPerVertex: FLOATS,
  recordWords: RECORD_WORDS,
  vertexBytes: VERTEX_BYTES,
  quantisation,
  clusterCount: clusterIds.size,
  pageCount: pages.length,
  levels: levelBuffers.map((_, level) => ({ file: `level-${level}.bin`, byteLength: levelBytes[level] })),
  roots,
  maxPageVertices,
  maxPageIndices,
  maxPageClusters,
  // The largest cluster: an arena that gives each cluster a block of this many vertices wastes nothing at the finest level
  maxClusterVertices,
  bounds: rootSphere.map((n) => +n.toFixed(6)),
  triangles: mesh.indices.length / 3,
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest))
const total = levelBytes.reduce((n, b) => n + b, 0)
const records = clusterIds.size * RECORD_WORDS * 4 + pages.length * HEADER_WORDS * 4
const summary = levelBytes.map((bytes, level) => {
  const levelPages = pages.filter((p) => p.level === level)
  const clusters = levelPages.reduce((n, p) => n + p.clusters.length, 0)
  const triangles = levelPages.reduce((n, p) => n + p.clusters.reduce((t, c) => t + c.indices.length / 3, 0), 0)
  return { level, pages: levelPages.length, clusters, triangles, MB: +(bytes / 1048576).toFixed(2) }
})
console.table(summary)
if (uvClamped > 0) console.warn(`${uvClamped} vertex UVs fell outside [0, 1] and were clamped; format 3 stores UVs in that range`)
console.log(`${clusterIds.size} clusters in ${pages.length} pages over ${levelCount} levels, ${(total / 1048576).toFixed(1)} MB in level files of which ${(records / 1048576).toFixed(1)} MB are records; up front: manifest with ${roots.length} root page${roots.length === 1 ? "" : "s"} -> ${outDir}`)
