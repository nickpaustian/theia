// Page encoding and decoding for the build and inspect tools: the Node twin of pageCodec.ts,
// which the runtime uses. Format 2 pages hold 8 floats a vertex and 32-bit indices; format 3
// quantises each vertex to 20 bytes (three u32 on a grid over the mesh, two octahedral snorm16,
// two unorm16) and packs vertices and 16-bit indices through meshoptimizer's codecs. Format 4
// is format 3 with each cluster record packed to 17 words on the wire (spheres and cone on a
// 16-bit grid over the mesh, counts as shorts) and expanded to the 32-word layout on decode.
import { MeshoptDecoder } from "meshoptimizer/decoder"
import { MeshoptEncoder } from "meshoptimizer/encoder"

export const FLOATS = 8
export const RECORD_WORDS = 32
export const VERTEX_BYTES = 20
export const FORMATS = [2, 3, 4]
/** Words per cluster record on the wire in format 4; decoded records are always RECORD_WORDS. */
export const WIRE_RECORD_WORDS = 17
export const headerWords = (format) => (format >= 3 ? 6 : 4)
export const wireRecordWords = (format) => (format === 4 ? WIRE_RECORD_WORDS : RECORD_WORDS)
export const codecReady = () => Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready])

const sign = (n) => (n >= 0 ? 1 : -1)
const pad4 = (n) => (n + 3) & ~3

// Positions land on one grid for the whole mesh, so a vertex shared by two pages (or two
// levels) quantises to the same point in both and the cut stays crack-free
export const quantisationFor = (min, max, positionBits) => {
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  return { origin: [min[0], min[1], min[2]], step: extent / (2 ** positionBits - 1), positionBits }
}

export const encodeOctahedral = (x, y, z) => {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1
  let u = x / s, v = y / s
  if (z < 0) {
    const ou = u, ov = v
    u = (1 - Math.abs(ov)) * sign(ou)
    v = (1 - Math.abs(ou)) * sign(ov)
  }
  return [Math.round(u * 32767), Math.round(v * 32767)]
}

export const decodeOctahedral = (u, v) => {
  let x = u, y = v
  const z = 1 - Math.abs(u) - Math.abs(v)
  if (z < 0) {
    x = (1 - Math.abs(v)) * sign(u)
    y = (1 - Math.abs(u)) * sign(v)
  }
  const length = Math.hypot(x, y, z) || 1
  return [x / length, y / length, z / length]
}

// Interleaved floats to the packed layout; returns the bytes and how many UVs fell outside [0, 1]
export const quantise = (vertices, q) => {
  const count = vertices.length / FLOATS
  const packed = new Uint8Array(count * VERTEX_BYTES)
  const view = new DataView(packed.buffer)
  const top = 2 ** q.positionBits - 1
  let uvClamped = 0
  for (let v = 0; v < count; v++) {
    const f = v * FLOATS, at = v * VERTEX_BYTES
    for (let k = 0; k < 3; k++) view.setUint32(at + k * 4, Math.min(top, Math.max(0, Math.round((vertices[f + k] - q.origin[k]) / q.step))), true)
    const [ou, ov] = encodeOctahedral(vertices[f + 3], vertices[f + 4], vertices[f + 5])
    view.setInt16(at + 12, ou, true)
    view.setInt16(at + 14, ov, true)
    for (let k = 0; k < 2; k++) {
      const uv = vertices[f + 6 + k]
      if (uv < 0 || uv > 1) uvClamped++
      view.setUint16(at + 16 + k * 2, Math.round(Math.min(1, Math.max(0, uv)) * 65535), true)
    }
  }
  return { packed, uvClamped }
}

export const dequantise = (packed, count, q) => {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  const out = new Float32Array(count * FLOATS)
  for (let v = 0; v < count; v++) {
    const at = v * VERTEX_BYTES, o = v * FLOATS
    for (let k = 0; k < 3; k++) out[o + k] = q.origin[k] + view.getUint32(at + k * 4, true) * q.step
    const [nx, ny, nz] = decodeOctahedral(view.getInt16(at + 12, true) / 32767, view.getInt16(at + 14, true) / 32767)
    out[o + 3] = nx; out[o + 4] = ny; out[o + 5] = nz
    out[o + 6] = view.getUint16(at + 16, true) / 65535
    out[o + 7] = view.getUint16(at + 18, true) / 65535
  }
  return out
}

// The grid a format-4 record's spheres and cone sit on: the quantisation's extent at 16 bits an axis
export const recordGridFor = (q) => ({ origin: [q.origin[0], q.origin[1], q.origin[2]], step: (q.step * (2 ** q.positionBits - 1)) / 65535 })

const NONE = 0xffffffff
const u16 = (n) => Math.max(0, Math.min(65535, Math.round(n)))
const i16 = (n) => Math.max(-32768, Math.min(32767, Math.round(n)))

// 32-word records to 17 words each. A sphere's centre rounds to the grid and its radius rounds
// up by a step and a half, so the sphere still contains the cluster; the cone's cutoff rounds up,
// so no cluster is culled that was not before.
export const packRecords = (records, clusterCount, grid) => {
  const out = new Uint32Array(clusterCount * WIRE_RECORD_WORDS)
  const outF = new Float32Array(out.buffer)
  const floats = new Float32Array(records.buffer, records.byteOffset, records.length)
  const g = (k, v) => (v - grid.origin[k]) / grid.step
  const sphere = (o, at) => {
    out[at] = u16(g(0, floats[o])) | (u16(g(1, floats[o + 1])) << 16)
    out[at + 1] = u16(g(2, floats[o + 2])) | (u16(floats[o + 3] / grid.step + 1.5) << 16)
  }
  for (let c = 0; c < clusterCount; c++) {
    const w = c * RECORD_WORDS, o = c * WIRE_RECORD_WORDS
    const childLevel = records[w + 24] === NONE ? 255 : records[w + 24]
    if (records[w + 6] > 255 || records[w] > 254 || childLevel > 255) throw new Error(`record ${c}: level ${records[w]} or vertex count ${records[w + 6]} does not fit format 4`)
    if (records[w + 3] > 65535 || records[w + 4] > 65535 || records[w + 5] > 65535) throw new Error(`record ${c}: index or vertex offsets do not fit format 4`)
    out[o] = records[w] | (childLevel << 8) | (records[w + 6] << 16)
    out[o + 1] = records[w + 3] | (records[w + 4] << 16)
    out[o + 2] = records[w + 5] | (u16(floats[w + 27] * 65535) << 16)
    const [au, av] = encodeOctahedral(floats[w + 20], floats[w + 21], floats[w + 22])
    out[o + 3] = u16(floats[w + 28] * 65535) | ((i16(Math.ceil(floats[w + 23] * 32767)) & 0xffff) << 16)
    out[o + 4] = records[w + 2]
    out[o + 5] = records[w + 25]
    out[o + 6] = records[w + 26]
    out[o + 7] = records[w + 29]
    outF[o + 8] = floats[w + 7]
    outF[o + 9] = floats[w + 12]
    sphere(w + 8, o + 10)
    sphere(w + 13, o + 12)
    out[o + 14] = u16(g(0, floats[w + 17])) | (u16(g(1, floats[w + 18])) << 16)
    out[o + 15] = u16(g(2, floats[w + 19])) | ((au & 0xffff) << 16)
    out[o + 16] = av & 0xffff
  }
  return out
}

// 17-word records back to the 32-word layout the runtimes walk; `pageId` fills word 1.
export const expandRecords = (packed, clusterCount, pageId, grid) => {
  const out = new Uint32Array(clusterCount * RECORD_WORDS)
  const outF = new Float32Array(out.buffer)
  const packedF = new Float32Array(packed.buffer, packed.byteOffset, packed.length)
  const lo = (v) => v & 0xffff, hi = (v) => v >>> 16
  const signed = (v) => (v & 0x8000 ? v - 0x10000 : v)
  const sphere = (at, o) => {
    outF[o] = grid.origin[0] + lo(packed[at]) * grid.step
    outF[o + 1] = grid.origin[1] + hi(packed[at]) * grid.step
    outF[o + 2] = grid.origin[2] + lo(packed[at + 1]) * grid.step
    outF[o + 3] = hi(packed[at + 1]) * grid.step
  }
  for (let c = 0; c < clusterCount; c++) {
    const o = c * RECORD_WORDS, p = c * WIRE_RECORD_WORDS
    const childLevel = (packed[p] >>> 8) & 0xff
    out[o] = packed[p] & 0xff
    out[o + 1] = pageId
    out[o + 2] = packed[p + 4]
    out[o + 3] = lo(packed[p + 1])
    out[o + 4] = hi(packed[p + 1])
    out[o + 5] = lo(packed[p + 2])
    out[o + 6] = (packed[p] >>> 16) & 0xff
    outF[o + 7] = packedF[p + 8]
    sphere(p + 10, o + 8)
    outF[o + 12] = packedF[p + 9]
    sphere(p + 12, o + 13)
    outF[o + 17] = grid.origin[0] + lo(packed[p + 14]) * grid.step
    outF[o + 18] = grid.origin[1] + hi(packed[p + 14]) * grid.step
    outF[o + 19] = grid.origin[2] + lo(packed[p + 15]) * grid.step
    const [ax, ay, az] = decodeOctahedral(signed(hi(packed[p + 15])) / 32767, signed(lo(packed[p + 16])) / 32767)
    outF[o + 20] = ax; outF[o + 21] = ay; outF[o + 22] = az
    outF[o + 23] = signed(hi(packed[p + 3])) / 32767
    out[o + 24] = childLevel === 255 ? NONE : childLevel
    out[o + 25] = packed[p + 5]
    out[o + 26] = packed[p + 6]
    outF[o + 27] = hi(packed[p + 2]) / 65535
    outF[o + 28] = lo(packed[p + 3]) / 65535
    out[o + 29] = packed[p + 7]
  }
  return out
}

// A format-3 page's vertex and index blocks, each padded to a word
export const encodeBlocks = (vertices, indices, q) => {
  const { packed, uvClamped } = quantise(vertices, q)
  const vertexBlock = MeshoptEncoder.encodeVertexBuffer(packed, vertices.length / FLOATS, VERTEX_BYTES)
  const shorts = new Uint16Array(indices)
  const indexBlock = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(shorts.buffer), indices.length, 2)
  return { vertexBlock, indexBlock, uvClamped, byteLength: pad4(vertexBlock.byteLength) + pad4(indexBlock.byteLength) }
}

// A page's bytes to records, vertices and indices in the format-2 layout, for either format
export const decodePage = (bytes, manifest) => {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
  const [page, clusterCount, vertexCount, indexCount] = words
  const recordsStart = headerWords(manifest.format)
  const onWire = wireRecordWords(manifest.format)
  const records = manifest.format === 4
    ? expandRecords(words.subarray(recordsStart, recordsStart + clusterCount * onWire), clusterCount, page, manifest.recordGrid ?? recordGridFor(manifest.quantisation))
    : words.subarray(recordsStart, recordsStart + clusterCount * RECORD_WORDS)
  const dataWord = recordsStart + clusterCount * onWire
  if (manifest.format < 3) {
    const vertices = new Float32Array(words.buffer, words.byteOffset + dataWord * 4, vertexCount * FLOATS)
    const indices = words.subarray(dataWord + vertexCount * FLOATS, dataWord + vertexCount * FLOATS + indexCount)
    return { page, clusterCount, vertexCount, indexCount, records, vertices, indices, expectedBytes: (dataWord + vertexCount * FLOATS + indexCount) * 4 }
  }
  const vertexBytes = words[4], indexBytes = words[5]
  const vertexStart = dataWord * 4
  const indexStart = vertexStart + pad4(vertexBytes)
  const packed = new Uint8Array(vertexCount * VERTEX_BYTES)
  MeshoptDecoder.decodeVertexBuffer(packed, vertexCount, VERTEX_BYTES, bytes.subarray(vertexStart, vertexStart + vertexBytes))
  const vertices = dequantise(packed, vertexCount, manifest.quantisation)
  const shorts = new Uint8Array(indexCount * 2)
  MeshoptDecoder.decodeIndexBuffer(shorts, indexCount, 2, bytes.subarray(indexStart, indexStart + indexBytes))
  const indices = Uint32Array.from(new Uint16Array(shorts.buffer, 0, indexCount))
  return { page, clusterCount, vertexCount, indexCount, records, vertices, indices, expectedBytes: indexStart + pad4(indexBytes) }
}
