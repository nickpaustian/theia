// A page's bytes to its records, vertices and indices, for either format the runtime reads.
//
// Format 2 stores vertices as 8 floats and indices as 32-bit words, so both are views onto
// the page. Format 3 quantises each vertex to 20 bytes (position as three 32-bit integers on
// a grid over the mesh, normal as two octahedral snorm16, UV as two unorm16) and packs the
// vertices and the 16-bit indices through meshoptimizer's vertex and index codecs, so they
// are decoded into fresh arrays. The decoded layout is the format-2 one either way:
// interleaved px py pz nx ny nz u v, and indices local to the page.
import { MeshoptDecoder } from "meshoptimizer/decoder"

export interface Quantisation {
  // Grid origin and step: position = origin + q × step
  origin: [number, number, number]
  step: number
  positionBits: number
}

export interface PageManifestFields {
  format: number
  recordWords: number
  floatsPerVertex: number
  vertexBytes?: number
  quantisation?: Quantisation
  /** Format 4: the grid the packed records' spheres and cone are on; derived from the quantisation when absent. */
  recordGrid?: RecordGrid
  wireRecordWords?: number
}

export interface RecordGrid {
  origin: [number, number, number]
  step: number
}

export interface DecodedPage {
  page: number
  clusterCount: number
  vertexCount: number
  indexCount: number
  records: Uint32Array
  vertices: Float32Array
  indices: Uint32Array
}

export const FLOATS = 8
export const RECORD_WORDS = 32
export const FORMATS = [2, 3, 4]
/** Words per cluster record on the wire in format 4; decoded records are always RECORD_WORDS. */
export const WIRE_RECORD_WORDS = 17

/** The grid a format-4 record's spheres and cone sit on: the quantisation's extent at 16 bits an axis. */
export const recordGridFor = (q: Quantisation): RecordGrid => ({ origin: [q.origin[0], q.origin[1], q.origin[2]], step: (q.step * (2 ** q.positionBits - 1)) / 65535 })

// 17-word wire records to the 32-word layout the walk reads; `pageId` fills word 1.
export const expandRecords = (packed: Uint32Array, clusterCount: number, pageId: number, grid: RecordGrid): Uint32Array => {
  const out = new Uint32Array(clusterCount * RECORD_WORDS)
  const outF = new Float32Array(out.buffer)
  const packedF = new Float32Array(packed.buffer, packed.byteOffset, packed.length)
  const lo = (v: number) => v & 0xffff
  const hi = (v: number) => v >>> 16
  const signed = (v: number) => (v & 0x8000 ? v - 0x10000 : v)
  const sphere = (at: number, o: number) => {
    outF[o] = grid.origin[0] + lo(packed[at]) * grid.step
    outF[o + 1] = grid.origin[1] + hi(packed[at]) * grid.step
    outF[o + 2] = grid.origin[2] + lo(packed[at + 1]) * grid.step
    outF[o + 3] = hi(packed[at + 1]) * grid.step
  }
  for (let c = 0; c < clusterCount; c++) {
    const o = c * RECORD_WORDS
    const p = c * WIRE_RECORD_WORDS
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
    decodeOctahedral(signed(hi(packed[p + 15])) / 32767, signed(lo(packed[p + 16])) / 32767, outF, o + 20)
    outF[o + 23] = signed(hi(packed[p + 3])) / 32767
    out[o + 24] = childLevel === 255 ? 0xffffffff : childLevel
    out[o + 25] = packed[p + 5]
    out[o + 26] = packed[p + 6]
    outF[o + 27] = hi(packed[p + 2]) / 65535
    outF[o + 28] = lo(packed[p + 3]) / 65535
    out[o + 29] = packed[p + 7]
  }
  return out
}

export const VERTEX_BYTES = 20
const HEADER_WORDS_2 = 4
const HEADER_WORDS_3 = 6

export const headerWords = (format: number): number => (format >= 3 ? HEADER_WORDS_3 : HEADER_WORDS_2)
export const wireRecordWords = (format: number): number => (format === 4 ? WIRE_RECORD_WORDS : RECORD_WORDS)

// Resolves once the decoder can run; format 2 needs nothing
export const codecReady = (format: number): Promise<void> => (format >= 3 ? MeshoptDecoder.ready : Promise.resolve())

export const decodePage = (buffer: ArrayBuffer, manifest: PageManifestFields): DecodedPage => {
  const words = new Uint32Array(buffer, 0, buffer.byteLength >> 2)
  const [page, clusterCount, vertexCount, indexCount] = words
  const recordsStart = headerWords(manifest.format)
  const onWire = wireRecordWords(manifest.format)
  // Format 4 records are packed on the wire; the walk reads the 32-word layout, so they are expanded here.
  const records =
    manifest.format === 4
      ? expandRecords(words.subarray(recordsStart, recordsStart + clusterCount * onWire), clusterCount, page, manifest.recordGrid ?? recordGridFor(manifest.quantisation!))
      : words.subarray(recordsStart, recordsStart + clusterCount * RECORD_WORDS)
  const dataWord = recordsStart + clusterCount * onWire
  if (manifest.format < 3) {
    const vertices = new Float32Array(buffer, dataWord * 4, vertexCount * FLOATS)
    const indices = words.slice(dataWord + vertexCount * FLOATS, dataWord + vertexCount * FLOATS + indexCount)
    return { page, clusterCount, vertexCount, indexCount, records, vertices, indices }
  }
  const quantisation = manifest.quantisation
  if (!quantisation) throw new Error("format 3 manifest has no quantisation")
  const vertexBytes = words[4]
  const indexBytes = words[5]
  const stride = manifest.vertexBytes ?? VERTEX_BYTES
  const bytes = new Uint8Array(buffer)
  const vertexStart = dataWord * 4
  const indexStart = vertexStart + ((vertexBytes + 3) & ~3)
  const packed = new Uint8Array(vertexCount * stride)
  MeshoptDecoder.decodeVertexBuffer(packed, vertexCount, stride, bytes.subarray(vertexStart, vertexStart + vertexBytes))
  const vertices = dequantise(packed, vertexCount, stride, quantisation)
  const shorts = new Uint8Array(indexCount * 2)
  MeshoptDecoder.decodeIndexBuffer(shorts, indexCount, 2, bytes.subarray(indexStart, indexStart + indexBytes))
  const indices = Uint32Array.from(new Uint16Array(shorts.buffer, 0, indexCount))
  return { page, clusterCount, vertexCount, indexCount, records, vertices, indices }
}

// The packed vertex: u32 x y z, i16 octahedral u v, u16 texture u v
const dequantise = (packed: Uint8Array, count: number, stride: number, q: Quantisation): Float32Array => {
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
  const out = new Float32Array(count * FLOATS)
  const [ox, oy, oz] = q.origin
  for (let v = 0; v < count; v++) {
    const at = v * stride
    const o = v * FLOATS
    out[o] = ox + view.getUint32(at, true) * q.step
    out[o + 1] = oy + view.getUint32(at + 4, true) * q.step
    out[o + 2] = oz + view.getUint32(at + 8, true) * q.step
    decodeOctahedral(view.getInt16(at + 12, true) / 32767, view.getInt16(at + 14, true) / 32767, out, o + 3)
    out[o + 6] = view.getUint16(at + 16, true) / 65535
    out[o + 7] = view.getUint16(at + 18, true) / 65535
  }
  return out
}

// The lower hemisphere's octant is folded over the upper one's edge; unfolded, the
// three components are renormalised. Zero takes the positive sign, as the encoder does.
const decodeOctahedral = (u: number, v: number, out: Float32Array, at: number): void => {
  let x = u, y = v
  const z = 1 - Math.abs(u) - Math.abs(v)
  if (z < 0) {
    x = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1)
    y = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1)
  }
  const length = Math.hypot(x, y, z) || 1
  out[at] = x / length
  out[at + 1] = y / length
  out[at + 2] = z / length
}
