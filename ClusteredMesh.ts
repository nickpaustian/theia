import * as THREE from "three"
import type { PoolClient } from "./pool.js"
import type { FetchLike } from "./PageScheduler.js"
import PageScheduler, { type PageSchedulerOptions, type PageSchedulerStats } from "./PageScheduler.js"
import OcclusionPass, { type OcclusionPassOptions } from "./OcclusionPass.js"

export interface PageRange {
  level: number
  offset: number
  length: number
}

export interface ClusterManifest {
  format: number
  name: string
  // Per-build token appended to the binary file URLs, so a rebuilt hierarchy is never served
  // from a cache of the old one
  build?: string
  recordWords: number
  // Root pages with their byte ranges; every other page is found through the records of the
  // page above it
  roots: Array<PageRange & { id: number }>
  maxPageClusters: number
  floatsPerVertex: number
  clusterCount: number
  pageCount: number
  levels: { file: string; byteLength: number }[]
  maxPageVertices: number
  maxPageIndices: number
  bounds: [number, number, number, number]
  triangles: number
}

export interface ClusteredMeshOptions {
  material?: THREE.Material
  // Largest screen-space error, in pixels, a drawn cluster may have
  pixelError?: number
  // Levels held back from the finest (1 halves the triangles). Pages below it are neither
  // drawn nor requested; see the detailCap field
  detailCap?: number
  // Pages the arena can hold at once; each slot holds manifest.maxPageVertices vertices
  slots?: number
  // Milliseconds a page stays safe from eviction after it was last part of the cut
  protectMs?: number
  // How much closeness to the screen centre counts when pages compete for slots
  centreBias?: number
  // Skip clusters whose normal cone faces away from the camera. Right for opaque, single-sided
  // surfaces; turn off for double-sided or transparent materials
  backfaceCull?: boolean
  // Margin on the cone cutoff; larger culls less, protecting silhouettes where a simplified
  // parent's cone can disagree slightly with its children
  backfaceMargin?: number
  // Skip clusters hidden behind what was drawn last frame, tested against a small depth
  // target of this mesh. Right for meshes that write depth; off for transparent ones
  occlusionCull?: boolean
  // Fraction of a sphere's distance it is pulled toward the camera before the depth test,
  // so coarse occluder geometry cannot hide a cluster it only just covers
  occlusionBias?: number
  // Frames between depth renders while the camera is still; any camera movement re-renders,
  // since a grid from another viewpoint tested with this one's projection hides the wrong things
  occlusionInterval?: number
  occlusion?: OcclusionPassOptions
  // What occlusion culling does to a cluster it catches. "refine" (default) draws it at the
  // level reached but never descends or requests beneath it, so a cluster the test gets wrong
  // for a frame or two (the depth grid is read back late and lags a fast turn) is coarse rather
  // than a hole; "hide" skips it outright. Backface culling always hides: its cone test is made
  // against the current camera, so it cannot lag
  cullMode?: CullMode
  // "compact": copy the cut's index ranges into one buffer and draw it once (default).
  // "ranges": submit the ranges through WEBGL_multi_draw. Faster on GPUs with native
  // multi-draw; on ANGLE's Metal backend the extension loops draw calls and loses
  drawMode?: DrawMode
  scheduler?: PageSchedulerOptions
  // A client of a shared fetch pool (@nickpaustian/tethys), when Theia streams alongside other modules
  pool?: PoolClient
  // Used for the manifest and every page request; the global fetch by default
  fetch?: FetchLike
}

export type DebugColour = 0 | 1 | 2
export type DrawMode = "compact" | "ranges"
export type CullMode = "refine" | "hide"

export interface ClusteredMeshStats {
  drawnClusters: number
  drawnTriangles: number
  totalTriangles: number
  perLevel: number[]
  culledClusters: number
  backfaceCulled: number
  occlusionCulled: number
  residentPages: number
  slots: number
  wantedPages: number
  dropped: number
  network: PageSchedulerStats
  pixelError: number
  detailCap: number
  memoryBytes: number
  // Ranges submitted this frame: merged cluster runs in "ranges" mode, 1 in "compact" mode
  drawRanges: number
  drawMode: DrawMode
  cullMode: CullMode
  multiDrawExtension: boolean
  indexRebuilds: number
}

const FLOATS = 8
const NONE = 0xffffffff
const FORMAT = 2
// A page: header, one record per cluster, vertices, indices. Layouts in 32-bit words
const HEADER_WORDS = 4
const H_PAGE = 0, H_CLUSTER_COUNT = 1, H_VERTEX_COUNT = 2, H_INDEX_COUNT = 3
const RECORD_WORDS = 32
const C_LEVEL = 0, C_CHILD_PAGE = 2, C_INDEX_OFFSET = 3, C_INDEX_COUNT = 4, C_VERTEX_OFFSET = 5, C_VERTEX_COUNT = 6
// words 12..16 hold the parent error and bounds; the traversal never needs them because a
// page is only reached through a parent that already failed that exact test
const C_SELF_ERROR = 7, C_SELF_BOUNDS = 8, C_CONE = 17
// the page beneath: level, byte offset, byte length; then the UV centroid and a cluster id
const C_CHILD_LEVEL = 24, C_CHILD_OFFSET = 25, C_CHILD_LENGTH = 26, C_ID = 29

// A mesh that walks a cluster hierarchy top-down each frame, drawing each cluster whose
// screen-space error is small enough and descending into the page beneath the ones that are
// not. Pages are byte ranges of per-level files, fetched on demand into a fixed arena of
// slots and evicted least-recently-used, so what is resident tracks what is on screen rather
// than the size of the source mesh.
//
// Every resident page's indices sit in a fixed region of a CPU-side slot index array. In the
// default "compact" mode a change of cut copies the drawn ranges back to back into a modest,
// growable index buffer and the mesh draws like any other, through drawRange. In "ranges"
// mode the ranges go to WEBGL_multi_draw as they are: three only takes that path for a
// BatchedMesh, so the object then declares itself one and supplies the private fields the
// r164 renderer reads (`_multiDrawStarts` as byte offsets, `_multiDrawCounts`,
// `_multiDrawCount`, `_multiDrawInstances`, `_matricesTexture`) plus the `batchId` attribute
// the batching shader wants, and mirrors the whole slot index array into a GPU buffer. That
// buffer is large (every slot's full region) and ANGLE's Metal backend stalls on it, which is
// why it is only allocated when the mode is switched on.
export default class ClusteredMesh extends THREE.Mesh {
  public _multiDrawStarts: Int32Array
  public _multiDrawCounts: Int32Array
  public _multiDrawCount: number = 0
  public _multiDrawInstances: null = null
  public _matricesTexture: THREE.DataTexture

  public readonly manifest: ClusterManifest
  public pixelError: number
  // Levels held back from the finest. Nothing below it is drawn or requested while it is set;
  // finer pages already resident stay and draw again the moment it drops, so it can follow
  // network speed or camera movement
  public detailCap: number
  public frozen: boolean = false
  public debugColour: DebugColour = 0
  public backfaceCull: boolean
  public backfaceMargin: number
  public occlusionCull: boolean
  public occlusionBias: number
  public occlusionInterval: number
  public cullMode: CullMode
  public readonly occlusion: OcclusionPass
  public drawMode: DrawMode
  private ownsMaterial: boolean = false
  private materialPatch: {
    material: THREE.Material
    onBeforeCompile: THREE.Material["onBeforeCompile"]
    customProgramCacheKey: THREE.Material["customProgramCacheKey"] | undefined
  } | null = null

  private baseUrl: string
  // Cluster records live with their page in the slot arena, so nothing is tabled up front
  private slotRecords: Uint32Array
  private slotRecordFloats: Float32Array
  private slotClusterCount: Int32Array
  private slotClusters: number
  // Byte ranges of pages discovered through their parents' records
  private pageRanges: Map<number, PageRange> = new Map()
  private scheduler: PageScheduler
  private protectMs: number
  private centreBias: number

  private slotCount: number
  private slotVertices: number
  private slotIndices: number
  // Each slot's indices, rebased onto its vertices; the source for compact rebuilds
  private slotIndexData: Uint32Array
  private rangeStarts: Int32Array
  private rangeCounts: Int32Array
  // Compact mode: two index buffers alternate so an upload never waits on a draw still reading
  // the other; they grow as the cut needs
  private compactBuffers: THREE.BufferAttribute[]
  private rangesBuffer: THREE.BufferAttribute | null = null
  private lastRangeSignature: number = -1
  private indexRebuilds: number = 0
  private pageSlot: Int32Array
  private slotPage: Int32Array
  private slotLastUsed: Float64Array
  private rootPages: Set<number>
  private multiDrawExtension: boolean | null = null

  private frame: number = 0
  private pass: number = 0
  private drawnPerLevel: number[] = []
  private drawnTriangles: number = 0
  private drawnClusters: number = 0
  private lastWanted: number = 0
  private droppedPages: number = 0
  private culledClusters: number = 0
  private backfaceCulledClusters: number = 0
  private occlusionCulledClusters: number = 0
  private occlusionView: THREE.Matrix4 = new THREE.Matrix4()
  private uniforms = { theiaDebug: { value: 0 } }

  private constructor(baseUrl: string, manifest: ClusterManifest, options: ClusteredMeshOptions) {
    const slots = options.slots ?? 4096
    const slotVertices = manifest.maxPageVertices
    const slotIndices = manifest.maxPageIndices
    const totalVertices = slots * slotVertices
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(totalVertices * 3), 3))
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(totalVertices * 3), 3))
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(totalVertices * 2), 2))
    // level and cluster id per vertex, for the debug colours
    geometry.setAttribute("theiaInfo", new THREE.BufferAttribute(new Float32Array(totalVertices * 2), 2))
    const compactBuffers = [
      new THREE.BufferAttribute(new Uint32Array(1 << 20), 1),
      new THREE.BufferAttribute(new Uint32Array(1 << 20), 1),
    ]
    geometry.setIndex(compactBuffers[0])
    geometry.setDrawRange(0, 0)
    const [cx, cy, cz, r] = manifest.bounds
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r)

    super(geometry, options.material ?? new THREE.MeshStandardMaterial({ roughness: 0.8 }))
    this.baseUrl = baseUrl
    this.manifest = manifest
    this.pixelError = options.pixelError ?? 1.5
    this.detailCap = Math.max(0, Math.floor(options.detailCap ?? 0))
    this.protectMs = options.protectMs ?? 500
    this.centreBias = options.centreBias ?? 1
    this.backfaceCull = options.backfaceCull ?? true
    this.backfaceMargin = options.backfaceMargin ?? 0.1
    this.occlusionCull = options.occlusionCull ?? true
    this.occlusionBias = options.occlusionBias ?? 0.03
    this.occlusionInterval = options.occlusionInterval ?? 2
    this.cullMode = options.cullMode ?? "refine"
    this.occlusion = new OcclusionPass(options.occlusion)
    this.drawMode = "compact"
    if (options.drawMode === "ranges") this.setDrawMode("ranges")
    this.frustumCulled = false

    this.slotClusters = manifest.maxPageClusters
    this.slotRecords = new Uint32Array(slots * this.slotClusters * RECORD_WORDS)
    this.slotRecordFloats = new Float32Array(this.slotRecords.buffer)
    this.slotClusterCount = new Int32Array(slots)
    this.slotCount = slots
    this.slotVertices = slotVertices
    this.slotIndices = slotIndices
    this.compactBuffers = compactBuffers
    this.slotIndexData = new Uint32Array(slots * slotIndices)
    this.pageSlot = new Int32Array(manifest.pageCount).fill(-1)
    this.slotPage = new Int32Array(slots).fill(-1)
    this.slotLastUsed = new Float64Array(slots)
    this.rootPages = new Set(manifest.roots.map((root) => root.id))
    for (const { id, level, offset, length } of manifest.roots) this.pageRanges.set(id, { level, offset, length })

    this.rangeStarts = new Int32Array(slots * this.slotClusters)
    this.rangeCounts = new Int32Array(slots * this.slotClusters)
    this._multiDrawStarts = new Int32Array(slots * this.slotClusters)
    this._multiDrawCounts = new Int32Array(slots * this.slotClusters)
    this._matricesTexture = new THREE.DataTexture(
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      4,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    )
    this._matricesTexture.needsUpdate = true

    this.scheduler = new PageScheduler(
      (id) => this.rangeOf(id),
      (id, buffer) => this.receive(id, buffer),
      { ...options.scheduler, ...(options.pool ? { pool: options.pool } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }
    )
    this.ownsMaterial = !options.material
    this.patchMaterial(this.material as THREE.Material)
  }

  public static async load(baseUrl: string, options: ClusteredMeshOptions = {}): Promise<ClusteredMesh> {
    const base = baseUrl.replace(/\/$/, "")
    const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    const get = async (file: string, init?: RequestInit) => {
      const response = await fetchImpl(`${base}/${file}`, init)
      if (!response.ok) throw new Error(`Theia: ${file} not found at ${base}`)
      return response
    }
    const manifest = (await (await get("manifest.json", { cache: "no-cache" })).json()) as ClusterManifest
    if (manifest.format !== FORMAT || manifest.recordWords !== RECORD_WORDS) {
      throw new Error(`Theia: ${base} is format ${manifest.format}; this build reads ${FORMAT}. Rebuild it with "theia build"`)
    }
    const mesh = new ClusteredMesh(base, manifest, options)
    await mesh.loadRoots()
    return mesh
  }

  //=========================
  // Pages
  //=========================

  private rangeOf(page: number): { url: string; offset: number; length: number } {
    const range = this.pageRanges.get(page)
    if (!range) throw new Error(`Theia: page ${page} has not been reached through a parent`)
    const version = this.manifest.build ? `?v=${this.manifest.build}` : ""
    return { url: `${this.baseUrl}/${this.manifest.levels[range.level].file}${version}`, offset: range.offset, length: range.length }
  }

  // Roots are fetched directly and never evicted, so the mesh is always drawable
  private async loadRoots(): Promise<void> {
    await Promise.all(
      [...this.rootPages].map(async (page) => {
        const { url, offset, length } = this.rangeOf(page)
        const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
        let buffer = await response.arrayBuffer()
        if (response.status !== 206) buffer = buffer.slice(offset, offset + length)
        this.receive(page, buffer)
      })
    )
  }

  private receive(page: number, buffer: ArrayBuffer): void {
    if (this.pageSlot[page] >= 0) return
    const slot = this.allocateSlot()
    if (slot === -1) {
      this.droppedPages++
      this.scheduler.dropped(page, this.frame)
      return
    }
    const expected = this.pageRanges.get(page)?.length ?? 0
    if (buffer.byteLength < expected) {
      throw new Error(`Theia: page ${page} arrived short (${buffer.byteLength} of ${expected} bytes); a cached file from an older build?`)
    }
    const words = new Uint32Array(buffer, 0, buffer.byteLength / 4)
    if (words[H_PAGE] !== page) throw new Error(`Theia: page ${page} payload is headed ${words[H_PAGE]}`)
    const clusterCount = words[H_CLUSTER_COUNT]
    const vertexCount = words[H_VERTEX_COUNT]
    const indexCount = words[H_INDEX_COUNT]
    const recordWords = clusterCount * RECORD_WORDS
    const recordBase = slot * this.slotClusters * RECORD_WORDS
    this.slotRecords.set(words.subarray(HEADER_WORDS, HEADER_WORDS + recordWords), recordBase)
    this.slotClusterCount[slot] = clusterCount
    for (let c = 0; c < clusterCount; c++) {
      const w = recordBase + c * RECORD_WORDS
      const child = this.slotRecords[w + C_CHILD_PAGE]
      if (child !== NONE && !this.pageRanges.has(child)) {
        this.pageRanges.set(child, {
          level: this.slotRecords[w + C_CHILD_LEVEL],
          offset: this.slotRecords[w + C_CHILD_OFFSET],
          length: this.slotRecords[w + C_CHILD_LENGTH],
        })
      }
    }
    const vertexWord = HEADER_WORDS + recordWords
    const vertices = new Float32Array(buffer, vertexWord * 4, vertexCount * FLOATS)
    const indices = words.subarray(vertexWord + vertexCount * FLOATS, vertexWord + vertexCount * FLOATS + indexCount)
    this.writeVertices(slot, vertices)
    this.writeIndices(slot, indices)
    this.pageSlot[page] = slot
    this.slotPage[slot] = page
    this.slotLastUsed[slot] = performance.now()
  }

  // The page's indices, rebased onto its slot's vertices, into the slot's region of the
  // slot index array; in "ranges" mode the GPU buffer mirrors it region for region
  private writeIndices(slot: number, indices: Uint32Array): void {
    const base = slot * this.slotVertices
    const at = slot * this.slotIndices
    const data = this.slotIndexData
    for (let i = 0; i < indices.length; i++) data[at + i] = indices[i] + base
    this.lastRangeSignature = -1
    if (this.rangesBuffer) {
      ;(this.rangesBuffer.array as Uint32Array).set(data.subarray(at, at + indices.length), at)
      this.rangesBuffer.addUpdateRange(at, indices.length)
      this.rangesBuffer.needsUpdate = true
    }
  }

  // three reads this to pick the multi-draw path; only the ranges mode wants it
  public get isBatchedMesh(): boolean {
    return this.drawMode === "ranges"
  }

  // Compact mode: the drawn ranges copied back to back into the other index buffer, which
  // grows when the cut outgrows it, and drawn as one range
  private compactIndex(ranges: number): void {
    let total = 0
    for (let r = 0; r < ranges; r++) total += this.rangeCounts[r]
    if (total > this.compactBuffers[0].count) {
      let capacity = this.compactBuffers[0].count
      while (capacity < total) capacity *= 2
      this.compactBuffers = [
        new THREE.BufferAttribute(new Uint32Array(capacity), 1),
        new THREE.BufferAttribute(new Uint32Array(capacity), 1),
      ]
    }
    const current = this.geometry.getIndex()
    const index = this.compactBuffers[current === this.compactBuffers[0] ? 1 : 0]
    this.geometry.setIndex(index)
    const array = index.array as Uint32Array
    const data = this.slotIndexData
    let at = 0
    for (let r = 0; r < ranges; r++) {
      const start = this.rangeStarts[r] / 4
      const count = this.rangeCounts[r]
      array.set(data.subarray(start, start + count), at)
      at += count
    }
    index.addUpdateRange(0, at)
    index.needsUpdate = true
    this.geometry.setDrawRange(0, at)
    this._multiDrawCount = 0
    this.indexRebuilds++
  }

  // Ranges mode mirrors the whole slot index array on the GPU and needs the batching
  // attribute; both are allocated the first time the mode is switched on
  public setDrawMode(mode: DrawMode): void {
    if (mode === this.drawMode) return
    this.drawMode = mode
    this.lastRangeSignature = -1
    const geometry = this.geometry
    if (mode === "ranges") {
      if (!this.rangesBuffer) {
        this.rangesBuffer = new THREE.BufferAttribute(new Uint32Array(this.slotIndexData.length), 1)
        const vertices = geometry.getAttribute("position").count
        geometry.setAttribute("batchId", new THREE.BufferAttribute(new Float32Array(vertices), 1))
      }
      ;(this.rangesBuffer.array as Uint32Array).set(this.slotIndexData)
      this.rangesBuffer.addUpdateRange(0, this.slotIndexData.length)
      this.rangesBuffer.needsUpdate = true
      geometry.setIndex(this.rangesBuffer)
      geometry.setDrawRange(0, Infinity)
    } else {
      geometry.setIndex(this.compactBuffers[0])
      geometry.setDrawRange(0, 0)
    }
    ;(this.material as THREE.Material).needsUpdate = true
  }

  private allocateSlot(): number {
    let best = -1
    let oldest = Infinity
    const minIdle = performance.now() - this.protectMs
    for (let slot = 0; slot < this.slotCount; slot++) {
      const page = this.slotPage[slot]
      if (page === -1) return slot
      if (this.rootPages.has(page)) continue
      const used = this.slotLastUsed[slot]
      if (used >= minIdle) continue
      if (used < oldest) {
        oldest = used
        best = slot
      }
    }
    if (best !== -1) {
      const evicted = this.slotPage[best]
      this.pageSlot[evicted] = -1
      this.slotPage[best] = -1
    }
    return best
  }

  private availableSlots(): number {
    let count = 0
    const minIdle = performance.now() - this.protectMs
    for (let slot = 0; slot < this.slotCount; slot++) {
      const page = this.slotPage[slot]
      if (page === -1 || (!this.rootPages.has(page) && this.slotLastUsed[slot] < minIdle)) count++
    }
    return count
  }

  private writeVertices(slot: number, vertices: Float32Array): void {
    const geometry = this.geometry
    const position = geometry.getAttribute("position") as THREE.BufferAttribute
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute
    const info = geometry.getAttribute("theiaInfo") as THREE.BufferAttribute
    const base = slot * this.slotVertices
    const count = vertices.length / FLOATS
    for (let v = 0; v < count; v++) {
      const src = v * FLOATS
      position.setXYZ(base + v, vertices[src], vertices[src + 1], vertices[src + 2])
      normal.setXYZ(base + v, vertices[src + 3], vertices[src + 4], vertices[src + 5])
      uv.setXY(base + v, vertices[src + 6], vertices[src + 7])
    }
    const recordBase = slot * this.slotClusters * RECORD_WORDS
    for (let c = 0; c < this.slotClusterCount[slot]; c++) {
      const w = recordBase + c * RECORD_WORDS
      const level = this.slotRecords[w + C_LEVEL]
      const id = this.slotRecords[w + C_ID]
      const from = this.slotRecords[w + C_VERTEX_OFFSET]
      const n = this.slotRecords[w + C_VERTEX_COUNT]
      for (let v = 0; v < n; v++) info.setXY(base + from + v, level, id)
    }
    for (const attribute of [position, normal, uv, info]) {
      attribute.addUpdateRange(base * attribute.itemSize, count * attribute.itemSize)
      attribute.needsUpdate = true
    }
  }

  //=========================
  // Cut selection
  //=========================

  public update(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    this.uniforms.theiaDebug.value = this.debugColour
    if (this.multiDrawExtension === null) this.multiDrawExtension = renderer.extensions.has("WEBGL_multi_draw")
    if (this.frozen) return
    this.frame++
    this.pass++

    // The last cut, drawn from the camera of a frame or two ago, is the occluder set; the
    // readback is collected when its fence signals so the frame never waits on the GPU
    const useOcclusion = this.occlusionCull && this.drawnClusters > 0 && this.occlusion.hasDepth
    if (this.occlusionCull && this.drawnClusters > 0) {
      this.occlusion.collect(renderer)
      const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld)
      const moved = !view.equals(this.occlusionView)
      if ((moved || this.frame % this.occlusionInterval === 0) && this.occlusion.render(renderer, camera, [this], this.matrixWorld)) {
        this.occlusionView.copy(view)
      }
    }

    const size = renderer.getSize(new THREE.Vector2())
    const screenFactor = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
    this.updateMatrixWorld()
    const toLocal = new THREE.Matrix4().copy(this.matrixWorld).invert()
    const local = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal)
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld)
    // Frustum in the mesh's local space, so cluster spheres can be tested as stored
    const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProjection)
    const sphere = new THREE.Sphere()
    // The depth grid is tested from the viewpoint it was rendered at, so a readback that
    // arrives a frame or two late cannot hide the wrong clusters while the camera moves
    const occlusion = this.occlusion
    const modelView = occlusion.gridModelView
    // Sphere radii are stored in local units; the centre goes through the model matrix, so the
    // radius needs the same scale
    const worldScale = this.matrixWorld.getMaxScaleOnAxis()
    const projection = occlusion.gridProjection.elements
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(occlusion.gridFov) / 2)
    const aspect = occlusion.gridAspect
    const viewPoint = new THREE.Vector3()
    const occlusionBias = this.occlusionBias
    const floats = this.slotRecordFloats
    const words = this.slotRecords
    const threshold = this.pixelError
    const detailCap = this.detailCap
    const slotClusters = this.slotClusters

    const project = (error: number, at: number): number => {
      const distance = Math.hypot(local.x - floats[at], local.y - floats[at + 1], local.z - floats[at + 2]) - floats[at + 3]
      if (distance <= 0) return Infinity
      return (error * screenFactor) / distance
    }
    // Sphere hidden behind the depth target: its screen rectangle and the depth of its nearest
    // point, pulled toward the camera by the bias and by the cluster's own error, since the
    // occluder is last frame's cut whose coarser parents deviate from the surface by that much
    const hidden = (at: number, error: number): boolean => {
      viewPoint.set(floats[at], floats[at + 1], floats[at + 2]).applyMatrix4(modelView)
      const radius = floats[at + 3] * worldScale
      const depth = -viewPoint.z
      const near = depth - radius - error * worldScale * 2
      if (near <= camera.near) return false
      const halfHeight = depth * tanHalfFov
      const ndcX = viewPoint.x / (halfHeight * aspect)
      const ndcY = viewPoint.y / halfHeight
      const rx = radius / (halfHeight * aspect)
      const ry = radius / halfHeight
      const zView = -near * (1 - occlusionBias)
      const zNdc = (projection[10] * zView + projection[14]) / -zView
      return this.occlusion.occluded(ndcX - rx, ndcY - ry, ndcX + rx, ndcY + ry, zNdc * 0.5 + 0.5)
    }

    const centreWeight = (at: number): number => {
      if (this.centreBias <= 0) return 1
      const p = new THREE.Vector3(floats[at], floats[at + 1], floats[at + 2]).applyMatrix4(viewProjection)
      const d = Math.min(1, Math.hypot(p.x, p.y) / Math.SQRT2)
      return 1 / (1 + this.centreBias * 0.25 * d * d)
    }

    const now = performance.now()
    const starts = this.rangeStarts
    const counts = this.rangeCounts
    const slotIndices = this.slotIndices
    let signature = 0
    let drawn = 0
    let drawnClusters = 0
    const perLevel = new Array<number>(this.manifest.levels.length).fill(0)
    const wanted = new Map<number, number>()
    const visited = new Set<number>()
    const stack = [...this.rootPages]
    let triangles = 0
    let culled = 0
    let backfaced = 0
    let hiddenCount = 0
    const cull = this.backfaceCull
    const margin = this.backfaceMargin
    const hideCulled = this.cullMode === "hide"

    while (stack.length > 0) {
      const page = stack.pop()!
      if (visited.has(page)) continue
      visited.add(page)
      const slot = this.pageSlot[page]
      if (slot === -1) continue
      this.slotLastUsed[slot] = now

      const recordBase = slot * slotClusters * RECORD_WORDS
      const clusterCount = this.slotClusterCount[slot]
      for (let c = 0; c < clusterCount; c++) {
        const w = recordBase + c * RECORD_WORDS
        // Outside the view: neither drawn nor refined, and its page beneath is never wanted
        sphere.center.set(floats[w + C_SELF_BOUNDS], floats[w + C_SELF_BOUNDS + 1], floats[w + C_SELF_BOUNDS + 2])
        sphere.radius = floats[w + C_SELF_BOUNDS + 3]
        if (!frustum.intersectsSphere(sphere)) {
          culled++
          continue
        }
        if (cull) {
          const k = w + C_CONE
          let dx = floats[k] - local.x, dy = floats[k + 1] - local.y, dz = floats[k + 2] - local.z
          const len = Math.hypot(dx, dy, dz) || 1
          dx /= len; dy /= len; dz /= len
          if (dx * floats[k + 3] + dy * floats[k + 4] + dz * floats[k + 5] >= floats[k + 6] + margin) {
            backfaced++
            continue
          }
        }
        // An occluded cluster stops refining here; in "hide" mode it is not drawn either
        let stop = false
        if (useOcclusion && hidden(w + C_SELF_BOUNDS, floats[w + C_SELF_ERROR])) {
          hiddenCount++
          if (hideCulled) continue
          stop = true
        }
        const child = words[w + C_CHILD_PAGE]
        const selfProjected = stop ? 0 : project(floats[w + C_SELF_ERROR], w + C_SELF_BOUNDS)
        let draw = stop || selfProjected <= threshold || child === NONE || words[w + C_CHILD_LEVEL] < detailCap
        if (!draw) {
          if (this.pageSlot[child] >= 0) {
            stack.push(child)
          } else {
            draw = true
            const priority = selfProjected * centreWeight(w + C_SELF_BOUNDS)
            if ((wanted.get(child) ?? 0) < priority) wanted.set(child, priority)
          }
        }
        if (draw) {
          const count = words[w + C_INDEX_COUNT]
          const start = (slot * slotIndices + words[w + C_INDEX_OFFSET]) * 4
          // Clusters of a page are contiguous in the slot, so adjacent drawn ones merge
          if (drawn > 0 && starts[drawn - 1] + counts[drawn - 1] * 4 === start) {
            counts[drawn - 1] += count
          } else {
            starts[drawn] = start
            counts[drawn] = count
            drawn++
          }
          signature = (Math.imul(signature, 31) + start + count) | 0
          drawnClusters++
          perLevel[words[w + C_LEVEL]]++
          triangles += count / 3
        }
      }
    }

    this.requestPages(wanted)

    if (this.drawMode === "ranges") {
      this._multiDrawStarts.set(starts.subarray(0, drawn))
      this._multiDrawCounts.set(counts.subarray(0, drawn))
      this._multiDrawCount = drawn
    } else if (signature !== this.lastRangeSignature) {
      this.compactIndex(drawn)
    }
    this.lastRangeSignature = signature
    this.drawnClusters = drawnClusters
    this.drawnTriangles = triangles
    this.drawnPerLevel = perLevel
    this.culledClusters = culled
    this.backfaceCulledClusters = backfaced
    this.occlusionCulledClusters = hiddenCount
  }

  // Only as many pages as the arena can take are asked for, highest priority first; the rest
  // keep drawing their parents until slots free up
  private requestPages(wanted: Map<number, number>): void {
    this.lastWanted = wanted.size
    const candidates: Array<{ page: number; priority: number }> = []
    let pending = 0
    for (const [page, priority] of wanted) {
      if (this.scheduler.has(page)) {
        this.scheduler.want(page, priority, this.pass)
        pending++
      } else if (this.scheduler.canRequest(page, this.frame)) {
        candidates.push({ page, priority })
      }
    }
    const budget = this.availableSlots() - pending
    candidates.sort((a, b) => b.priority - a.priority)
    for (const { page, priority } of candidates.slice(0, Math.max(0, budget))) {
      this.scheduler.want(page, priority, this.pass)
    }
    this.scheduler.endPass(this.pass)
  }

  //=========================
  // Debug colours
  //=========================

  // Chains onto whatever already patches the material (Atlas, for one), so the two compose
  private patchMaterial(material: THREE.Material): void {
    const previous = material.onBeforeCompile
    const ownKey = Object.prototype.hasOwnProperty.call(material, "customProgramCacheKey")
    const previousKey = ownKey ? material.customProgramCacheKey : () => ""
    this.materialPatch = { material, onBeforeCompile: previous, customProgramCacheKey: ownKey ? previousKey : undefined }
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      shader.uniforms.theiaDebug = this.uniforms.theiaDebug
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec2 theiaInfo;\nflat varying vec2 vTheiaInfo;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvTheiaInfo = theiaInfo;")
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform float theiaDebug;
flat varying vec2 vTheiaInfo;
vec3 theiaHash( float n ) {
  return fract( sin( vec3( n * 12.9898, n * 78.233, n * 37.719 ) ) * 43758.5453 ) * 0.7 + 0.3;
}`
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
if ( theiaDebug > 0.5 ) {
  float luma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  vec3 tint = theiaDebug > 1.5
    ? mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), clamp( vTheiaInfo.x / 8.0, 0.0, 1.0 ) )
    : theiaHash( vTheiaInfo.y );
  gl_FragColor.rgb = mix( vec3( luma ), tint, 0.75 );
}`
        )
    }
    material.customProgramCacheKey = () => `${previousKey.call(material)}|theia`
    material.needsUpdate = true
  }

  //=========================
  // Readouts
  //=========================

  public get stats(): ClusteredMeshStats {
    let resident = 0
    for (let slot = 0; slot < this.slotCount; slot++) if (this.slotPage[slot] !== -1) resident++
    return {
      drawnClusters: this.drawnClusters,
      drawnTriangles: this.drawnTriangles,
      totalTriangles: this.manifest.triangles,
      perLevel: this.drawnPerLevel,
      culledClusters: this.culledClusters,
      backfaceCulled: this.backfaceCulledClusters,
      occlusionCulled: this.occlusionCulledClusters,
      residentPages: resident,
      slots: this.slotCount,
      wantedPages: this.lastWanted,
      dropped: this.droppedPages,
      network: this.scheduler.stats,
      pixelError: this.pixelError,
      detailCap: this.detailCap,
      memoryBytes:
        this.slotCount * this.slotVertices * (3 + 3 + 2 + 2) * 4 +
        this.slotRecords.byteLength +
        this.compactBuffers[0].count * 4 * 2 +
        (this.rangesBuffer ? this.slotIndexData.length * 4 + this.slotCount * this.slotVertices * 4 : 0),
      drawRanges: this.drawMode === "ranges" ? this._multiDrawCount : this.geometry.drawRange.count > 0 ? 1 : 0,
      drawMode: this.drawMode,
      cullMode: this.cullMode,
      multiDrawExtension: this.multiDrawExtension === true,
      indexRebuilds: this.indexRebuilds,
    }
  }

  // Releases the arena geometry, the occlusion target and its pixel buffers, pending fetches and
  // pool tickets, and takes the shader patch off the material (disposing it if it was made here)
  public dispose(renderer?: THREE.WebGLRenderer): void {
    this.scheduler.dispose()
    this.occlusion.dispose(renderer)
    this.geometry.dispose()
    this._matricesTexture.dispose()
    const patch = this.materialPatch
    if (patch) {
      patch.material.onBeforeCompile = patch.onBeforeCompile
      if (patch.customProgramCacheKey) patch.material.customProgramCacheKey = patch.customProgramCacheKey
      else delete (patch.material as Partial<THREE.Material>).customProgramCacheKey
      patch.material.needsUpdate = true
      this.materialPatch = null
    }
    if (this.ownsMaterial) (this.material as THREE.Material).dispose()
  }
}
