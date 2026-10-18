#!/usr/bin/env node
// Builds a Theia cluster hierarchy from a glTF binary with meshoptimizer.
//
//   theia build <input.glb> <outDir> [--max-tris 124] [--max-verts 64] [--group 4] [--max-group 8] [--target-tris N] [--mesh name|index] [--permissive] [--force]
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
// Output (format 2):
//   manifest.json  counts, level files, root pages with byte ranges, arena sizing
//   level-<n>.bin  pages back to back, each self-describing: a 4-word header (page id, cluster,
//                  vertex and index counts), one 32-word record per cluster (see writeRecord:
//                  level, page, child page id, index/vertex offsets and counts, self error and
//                  bounds, parent error and bounds, normal cone, the child page's level/offset/
//                  length, UV centroid, cluster id), vertices (8 floats each, duplicated per
//                  cluster), then uint32 indices local to the page. Nothing is tabled up front.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { MeshoptClusterizer } from "meshoptimizer/clusterizer"
import { MeshoptSimplifier } from "meshoptimizer/simplifier"

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
  fail("usage: theia build <input.glb> <outDir> [--max-tris 124] [--max-verts 64] [--group 4] [--max-group 8] [--target-tris N] [--mesh name|index] [--permissive] [--force]")
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

// Greedy grouping of adjacent clusters, groupSize at a time, by welding the whole level
const groupClusters = (clusters, groupSize, byPosition = false) => {
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
    let [simplified] = MeshoptSimplifier.simplifyWithAttributes(source, vertices, STRIDE, attributes, 5, attributeWeights, null, target, 1.0, ["LockBorder"])
    if (permissive && (acrossSeams || simplified.length >= indices.length * 0.9)) {
      // Collapsing across seams: one vertex per position, so each kept vertex brings the UV of
      // whichever island it came from. meshoptimizer's own Permissive flag is not enough here, as
      // it still locks vertices where three or more islands meet, which is most of them.
      const remap = positionRemap(vertices)
      const across = indices.map((i) => remap[i])
      const [retried] = MeshoptSimplifier.simplifyWithAttributes(across, vertices, STRIDE, attributes, 5, attributeWeights, null, target, 1.0, ["LockBorder"])
      if (retried.length < indices.length * 0.9) {
        source = across
        simplified = retried
        permissiveGroups++
      }
    }
    // The attribute-aware result keeps UVs and normals honest, but its error folds attribute
    // terms in; a position-only pass to the same target gives the geometric error to store,
    // which is what screen-space selection should be judged by
    const [, relativeError] = MeshoptSimplifier.simplify(source, vertices, STRIDE, target, 1.0, ["LockBorder"])
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
const HEADER_WORDS = 4
const pageSizes = pages.map((page) => {
  let vertexCount = 0, indexCount = 0
  for (const c of page.clusters) { vertexCount += c.vertices.length / FLOATS; indexCount += c.indices.length }
  return { vertexCount, indexCount, byteLength: (HEADER_WORDS + page.clusters.length * RECORD_WORDS + vertexCount * FLOATS + indexCount) * 4 }
})
const pageRanges = pages.map((page, pageId) => {
  const range = { level: page.level, offset: levelBytes[page.level], length: pageSizes[pageId].byteLength }
  levelBytes[page.level] += range.length
  return range
})
const clusterIds = new Map()
let maxPageVertices = 0, maxPageIndices = 0, maxPageClusters = 0
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
  const { vertexCount, indexCount, byteLength } = pageSizes[pageId]
  const words = new Uint32Array(byteLength / 4)
  const floats = new Float32Array(words.buffer)
  words[0] = pageId; words[1] = page.clusters.length; words[2] = vertexCount; words[3] = indexCount
  const vertexBase = HEADER_WORDS + page.clusters.length * RECORD_WORDS
  const indexBase = vertexBase + vertexCount * FLOATS
  let v = 0, i = 0
  page.clusters.forEach((c, n) => {
    writeRecord(words, floats, HEADER_WORDS + n * RECORD_WORDS, c, pageId, i, v)
    floats.set(c.vertices, vertexBase + v * FLOATS)
    for (let k = 0; k < c.indices.length; k++) words[indexBase + i + k] = c.indices[k] + v
    v += c.vertices.length / FLOATS
    i += c.indices.length
  })
  levelBuffers[page.level].push(Buffer.from(words.buffer))
  maxPageVertices = Math.max(maxPageVertices, vertexCount)
  maxPageIndices = Math.max(maxPageIndices, indexCount)
  maxPageClusters = Math.max(maxPageClusters, page.clusters.length)
})

mkdirSync(outDir, { recursive: true })
levelBuffers.forEach((chunks, level) => writeFileSync(join(outDir, `level-${level}.bin`), Buffer.concat(chunks)))
const roots = rootPages.map((id) => ({ id, ...pageRanges[id] }))
const rootSphere = mergeSpheres(current.map((c) => c.selfBounds))
const manifest = {
  format: 2,
  name: mesh.name,
  // Cache-buster for the binary files, which are byte-range fetched and change size per build
  build: Date.now().toString(36),
  floatsPerVertex: FLOATS,
  recordWords: RECORD_WORDS,
  clusterCount: clusterIds.size,
  pageCount: pages.length,
  levels: levelBuffers.map((_, level) => ({ file: `level-${level}.bin`, byteLength: levelBytes[level] })),
  roots,
  maxPageVertices,
  maxPageIndices,
  maxPageClusters,
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
console.log(`${clusterIds.size} clusters in ${pages.length} pages over ${levelCount} levels, ${(total / 1048576).toFixed(1)} MB in level files of which ${(records / 1048576).toFixed(1)} MB are records; up front: manifest with ${roots.length} root page${roots.length === 1 ? "" : "s"} -> ${outDir}`)
