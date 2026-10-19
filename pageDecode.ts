// Everything a page's bytes become before they touch the geometry: the decoded page with its
// vertices split into the attribute arrays the arena holds (position, normal, uv and the
// per-vertex level and cluster id the debug colours read). Pure, so it runs the same on the
// main thread or in a worker (see PageDecoder); every buffer in the result is transferable.
import { FLOATS, RECORD_WORDS, decodePage, type PageManifestFields } from "./pageCodec.js"

export interface PreparedPage {
  page: number
  clusterCount: number
  vertexCount: number
  indexCount: number
  // The cluster records in the 32-word runtime layout, back to back
  records: Uint32Array
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  // Level and cluster id per vertex, for the debug colours
  info: Float32Array
  indices: Uint32Array
}

const C_LEVEL = 0, C_VERTEX_OFFSET = 5, C_VERTEX_COUNT = 6, C_ID = 29

export const preparePage = (buffer: ArrayBuffer, manifest: PageManifestFields): PreparedPage => {
  const decoded = decodePage(buffer, manifest)
  const count = decoded.vertexCount
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const info = new Float32Array(count * 2)
  const v = decoded.vertices
  for (let i = 0; i < count; i++) {
    const s = i * FLOATS
    positions[i * 3] = v[s]
    positions[i * 3 + 1] = v[s + 1]
    positions[i * 3 + 2] = v[s + 2]
    normals[i * 3] = v[s + 3]
    normals[i * 3 + 1] = v[s + 4]
    normals[i * 3 + 2] = v[s + 5]
    uvs[i * 2] = v[s + 6]
    uvs[i * 2 + 1] = v[s + 7]
  }
  // Records of a format below 4 are a view into the page's bytes; copied so the result owns every buffer
  const records = decoded.records.buffer === buffer ? decoded.records.slice() : decoded.records
  for (let c = 0; c < decoded.clusterCount; c++) {
    const w = c * RECORD_WORDS
    const level = records[w + C_LEVEL]
    const id = records[w + C_ID]
    const from = records[w + C_VERTEX_OFFSET]
    const n = records[w + C_VERTEX_COUNT]
    for (let i = 0; i < n; i++) {
      info[(from + i) * 2] = level
      info[(from + i) * 2 + 1] = id
    }
  }
  return { page: decoded.page, clusterCount: decoded.clusterCount, vertexCount: count, indexCount: decoded.indexCount, records, positions, normals, uvs, info, indices: decoded.indices }
}

// The buffers to hand across a worker boundary without copying
export const transferablesOf = (p: PreparedPage): ArrayBuffer[] => [...new Set([p.records.buffer, p.positions.buffer, p.normals.buffer, p.uvs.buffer, p.info.buffer, p.indices.buffer])] as ArrayBuffer[]
