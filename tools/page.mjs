// Page encoding and decoding for the build and inspect tools: the Node twin of pageCodec.ts,
// which the runtime uses. Format 2 pages hold 8 floats a vertex and 32-bit indices; format 3
// quantises each vertex to 20 bytes (three u32 on a grid over the mesh, two octahedral snorm16,
// two unorm16) and packs vertices and 16-bit indices through meshoptimizer's codecs.
import { MeshoptDecoder } from "meshoptimizer/decoder"
import { MeshoptEncoder } from "meshoptimizer/encoder"

export const FLOATS = 8
export const RECORD_WORDS = 32
export const VERTEX_BYTES = 20
export const FORMATS = [2, 3]
export const headerWords = (format) => (format === 3 ? 6 : 4)
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
  const records = words.subarray(recordsStart, recordsStart + clusterCount * RECORD_WORDS)
  const dataWord = recordsStart + clusterCount * RECORD_WORDS
  if (manifest.format !== 3) {
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
