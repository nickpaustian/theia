import { writeFileSync } from "node:fs"

export interface SphereOptions { segments?: number; rings?: number; radius?: number }

// A UV sphere with positions, normals, uvs and a triangle list
export const sphere = ({ segments = 48, rings = 24, radius = 1 }: SphereOptions = {}) => {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, theta = v * Math.PI
    for (let s = 0; s <= segments; s++) {
      const u = s / segments, phi = u * Math.PI * 2
      const x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi)
      positions.push(x * radius, y * radius, z * radius)
      normals.push(x, y, z)
      uvs.push(u, v)
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s, b = a + segments + 1
      if (r > 0) indices.push(a, b, a + 1)
      if (r < rings - 1) indices.push(b, b + 1, a + 1)
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) }
}

export interface GlbOptions { name?: string; indexed?: boolean; uv?: boolean; normals?: boolean; meshes?: number }

// Writes a glTF binary holding the mesh as one primitive per mesh
export const writeGlb = (path: string, mesh: ReturnType<typeof sphere>, { name = "fixture", indexed = true, uv = true, normals = true, meshes = 1 }: GlbOptions = {}) => {
  const chunks: Buffer[] = []
  const views: object[] = []
  const accessors: object[] = []
  let offset = 0
  const add = (array: Float32Array | Uint32Array, type: string, componentType: number, extra: object = {}) => {
    const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
    chunks.push(buffer)
    views.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length })
    offset += buffer.length
    while (offset % 4) { chunks.push(Buffer.alloc(1)); offset++ }
    accessors.push({ bufferView: views.length - 1, componentType, count: array.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type]!, type, ...extra })
    return accessors.length - 1
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], mesh.positions[i + k]); max[k] = Math.max(max[k], mesh.positions[i + k]) }
  const attributes: Record<string, number> = { POSITION: add(mesh.positions, "VEC3", 5126, { min, max }) }
  if (normals) attributes.NORMAL = add(mesh.normals, "VEC3", 5126)
  if (uv) attributes.TEXCOORD_0 = add(mesh.uvs, "VEC2", 5126)
  const primitive: Record<string, unknown> = { attributes }
  if (indexed) primitive.indices = add(mesh.indices, "SCALAR", 5125)
  const bin = Buffer.concat(chunks)
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: Array.from({ length: meshes }, (_, i) => i) }],
    nodes: Array.from({ length: meshes }, (_, i) => ({ mesh: i })),
    meshes: Array.from({ length: meshes }, (_, i) => ({ name: meshes > 1 ? `${name}${i}` : name, primitives: [primitive] })),
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
  }))
  const pad = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)])
  const jsonChunk = pad(json, 0x20), binChunk = pad(bin, 0)
  const header = Buffer.alloc(12)
  header.write("glTF", 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunkHeader = (length: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(length, 0); b.writeUInt32LE(type, 4); return b }
  writeFileSync(path, Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]))
}
