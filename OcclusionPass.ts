import * as THREE from "three"

export interface OcclusionPassOptions {
  // Depth is rendered at 1/scale of the viewport in each axis
  scale?: number
  // Pixels per cell of the max-depth grid the spheres are tested against
  cell?: number
  // Read the pixels back synchronously (stalls; for comparison only)
  sync?: boolean
}

// Renders the occluders into a small target with packed depth, reads it back without stalling
// (pixel pack buffer behind a fence, collected a frame or two later), and keeps a coarse grid
// of the farthest depth per cell together with the viewpoint it was rendered from. A sphere
// whose nearest point is farther than everything drawn over its screen rectangle, as seen from
// that viewpoint, is hidden.
export default class OcclusionPass {
  public readonly target: THREE.WebGLRenderTarget
  public readonly material: THREE.MeshDepthMaterial
  public scale: number
  public cell: number
  public sync: boolean
  // The viewpoint the current grid was rendered from: model-view and projection
  public readonly gridModelView: THREE.Matrix4 = new THREE.Matrix4()
  public readonly gridProjection: THREE.Matrix4 = new THREE.Matrix4()
  public gridAspect: number = 1
  public gridFov: number = 45

  private buffer: Uint8Array = new Uint8Array(0)
  private width: number = 0
  private height: number = 0
  private cols: number = 0
  private rows: number = 0
  private grid: Float32Array = new Float32Array(0)
  private ready: boolean = false
  private pending: {
    pbo: WebGLBuffer
    sync: WebGLSync
    modelView: THREE.Matrix4
    projection: THREE.Matrix4
    aspect: number
    fov: number
  } | null = null
  private pbos: WebGLBuffer[] = []
  private pboSize: number = 0
  private renders: number = 0
  private collected: number = 0

  constructor({ scale = 8, cell = 4, sync = false }: OcclusionPassOptions = {}) {
    this.scale = scale
    this.cell = cell
    this.sync = sync
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })
    this.material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  }

  public get hasDepth(): boolean {
    return this.ready
  }

  public get inFlight(): boolean {
    return this.pending !== null
  }

  public get stats(): { renders: number; collected: number } {
    return { renders: this.renders, collected: this.collected }
  }

  private setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width / this.scale))
    const h = Math.max(1, Math.round(height / this.scale))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.target.setSize(w, h)
    this.buffer = new Uint8Array(w * h * 4)
    this.cols = Math.ceil(w / this.cell)
    this.rows = Math.ceil(h / this.cell)
    this.grid = new Float32Array(this.cols * this.rows)
    this.ready = false
  }

  // Collects a finished readback if one is waiting. Returns true when the grid changed.
  public collect(renderer: THREE.WebGLRenderer): boolean {
    const pending = this.pending
    if (!pending) return false
    const gl = renderer.getContext() as WebGL2RenderingContext
    if (gl.getSyncParameter(pending.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return false
    gl.deleteSync(pending.sync)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pending.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.buffer)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.pending = null
    this.adopt(pending.modelView, pending.projection, pending.aspect, pending.fov)
    return true
  }

  private adopt(modelView: THREE.Matrix4, projection: THREE.Matrix4, aspect: number, fov: number): void {
    this.reduce()
    this.gridModelView.copy(modelView)
    this.gridProjection.copy(projection)
    this.gridAspect = aspect
    this.gridFov = fov
    this.ready = true
    this.collected++
  }

  // Draws the occluders with the depth material and starts a readback. With a readback still
  // in flight nothing is started, so at most one is pending.
  public render(
    renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    occluders: THREE.Mesh[],
    modelMatrix: THREE.Matrix4
  ): boolean {
    if (this.pending) return false
    const size = renderer.getSize(new THREE.Vector2())
    this.setSize(size.x, size.y)
    const modelView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, modelMatrix)
    const projection = camera.projectionMatrix.clone()

    const swapped = occluders.map((mesh) => ({ mesh, material: mesh.material }))
    for (const { mesh } of swapped) mesh.material = this.material

    const previousTarget = renderer.getRenderTarget()
    const previousClear = renderer.getClearColor(new THREE.Color())
    const previousAlpha = renderer.getClearAlpha()
    const previousAutoClear = renderer.autoClear

    renderer.setRenderTarget(this.target)
    // Packed depth of 1.0 is (0, 0, 0, 1); cells left at it count as open
    renderer.setClearColor(0x000000, 1)
    renderer.autoClear = true
    renderer.clear()
    for (const { mesh } of swapped) renderer.render(mesh, camera)
    this.renders++

    if (this.sync) {
      renderer.readRenderTargetPixels(this.target, 0, 0, this.width, this.height, this.buffer)
      this.adopt(modelView, projection, camera.aspect, camera.fov)
    } else {
      // The target's framebuffer is bound: read into a pixel pack buffer and fence it
      const gl = renderer.getContext() as WebGL2RenderingContext
      const pbo = this.acquirePbo(gl)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!
      gl.flush()
      this.pending = { pbo, sync, modelView, projection, aspect: camera.aspect, fov: camera.fov }
    }

    renderer.setRenderTarget(previousTarget)
    renderer.setClearColor(previousClear, previousAlpha)
    renderer.autoClear = previousAutoClear
    for (const { mesh, material } of swapped) mesh.material = material
    return true
  }

  private acquirePbo(gl: WebGL2RenderingContext): WebGLBuffer {
    const bytes = this.width * this.height * 4
    if (this.pbos.length === 0 || this.pboSize !== bytes) {
      for (const pbo of this.pbos) gl.deleteBuffer(pbo)
      this.pbos = []
      for (let i = 0; i < 2; i++) {
        const pbo = gl.createBuffer()!
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
        this.pbos.push(pbo)
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      this.pboSize = bytes
    }
    return this.pbos[this.renders % 2]
  }

  // Farthest depth per cell, with the readback's bottom-up rows flipped to top-down
  private reduce(): void {
    const { buffer, width, height, cell, cols, grid } = this
    grid.fill(0)
    for (let y = 0; y < height; y++) {
      const row = Math.floor((height - 1 - y) / cell)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const depth = (buffer[i + 3] + buffer[i + 2] / 256 + buffer[i + 1] / 65536 + buffer[i] / 16777216) / 256
        const at = row * cols + Math.floor(x / cell)
        if (depth > grid[at]) grid[at] = depth
      }
    }
  }

  // Whether a screen rectangle in NDC (-1..1, y up) is entirely covered by nearer depth
  public occluded(minX: number, minY: number, maxX: number, maxY: number, depth01: number): boolean {
    if (!this.ready) return false
    const c0 = Math.max(0, Math.floor(((minX + 1) / 2) * this.cols))
    const c1 = Math.min(this.cols - 1, Math.floor(((maxX + 1) / 2) * this.cols))
    const r0 = Math.max(0, Math.floor(((1 - maxY) / 2) * this.rows))
    const r1 = Math.min(this.rows - 1, Math.floor(((1 - minY) / 2) * this.rows))
    if (c1 < c0 || r1 < r0) return false
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const far = this.grid[r * this.cols + c]
        // Open cell (nothing drawn, or the packed clear value) cannot hide anything
        if (far >= 0.995 || depth01 <= far) return false
      }
    }
    return true
  }

  public dispose(renderer?: THREE.WebGLRenderer): void {
    if (renderer) {
      const gl = renderer.getContext() as WebGL2RenderingContext
      for (const pbo of this.pbos) gl.deleteBuffer(pbo)
      if (this.pending) gl.deleteSync(this.pending.sync)
    }
    this.pbos = []
    this.pending = null
    this.target.dispose()
    this.material.dispose()
  }
}
