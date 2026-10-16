import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as THREE from "three"
import { ClusteredMesh } from "../index.js"
import { sphere, writeGlb } from "./fixtures.js"

const cli = join(import.meta.dirname, "..", "tools", "cli.mjs")
let dir: string
const mesh = sphere({ segments: 64, rings: 32 })
const requests: string[] = []

// Serves the built folder from disk with Range support, as a static host would
const fetchFromDisk = async (url: string, init?: RequestInit): Promise<Response> => {
  const path = url.replace(/^file:/, "").split("?")[0]
  const data = readFileSync(path)
  const range = (init?.headers as Record<string, string> | undefined)?.Range
  requests.push(url)
  if (!range) return new Response(data, { status: 200 })
  const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!
  return new Response(data.subarray(Number(from), Number(to) + 1), { status: 206 })
}
const renderer = { extensions: { has: () => false }, getSize: (v: THREE.Vector2) => v.set(1920, 1080) } as unknown as THREE.WebGLRenderer
const camera = (distance: number) => {
  const cam = new THREE.PerspectiveCamera(45, 1920 / 1080, 0.01, 100)
  cam.position.set(0, 0, distance)
  cam.updateMatrixWorld()
  cam.updateProjectionMatrix()
  return cam
}
const settled = async (m: ClusteredMesh, cam: THREE.PerspectiveCamera) => {
  for (let i = 0; i < 60; i++) {
    m.update(cam, renderer)
    await new Promise((r) => setTimeout(r, 5))
    const n = m.stats.network
    if (n.queued === 0 && n.inFlight === 0 && m.stats.wantedPages === 0) break
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "theia-mesh-"))
  writeGlb(join(dir, "sphere.glb"), mesh)
  const built = spawnSync("node", [cli, "build", join(dir, "sphere.glb"), join(dir, "out")], { encoding: "utf8" })
  if (built.status !== 0) throw new Error(built.stderr)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("ClusteredMesh", () => {
  it("loads the manifest and root pages through the fetch hook", async () => {
    const m = await ClusteredMesh.load(`file:${dir}/out`, { fetch: fetchFromDisk, occlusionCull: false })
    expect(m.stats.residentPages).toBe(m.manifest.roots.length)
    expect(requests[0]).toMatch(/manifest\.json$/)
    expect(requests.slice(1).every((u) => u.includes("?v=" + m.manifest.build))).toBe(true)
    m.dispose()
  })

  it("refines to the full mesh when the error threshold is tiny and holds levels back under a detail cap", async () => {
    const m = await ClusteredMesh.load(`file:${dir}/out`, { fetch: fetchFromDisk, occlusionCull: false, backfaceCull: false, pixelError: 1e-4 })
    const far = camera(6)
    m.update(far, renderer)
    const coarse = m.stats.drawnTriangles
    expect(coarse).toBeGreaterThan(0)
    expect(coarse).toBeLessThan(m.manifest.triangles)
    expect(m.stats.wantedPages).toBeGreaterThan(0)
    await settled(m, far)
    expect(m.stats.drawnTriangles).toBe(m.manifest.triangles)
    expect(m.stats.perLevel[0]).toBeGreaterThan(0)
    expect(m.stats.network.failures).toBe(0)
    m.detailCap = 1
    m.update(far, renderer)
    expect(m.stats.perLevel[0]).toBe(0)
    expect(m.stats.drawnTriangles).toBeLessThan(m.manifest.triangles)
    m.detailCap = 0
    m.update(far, renderer)
    expect(m.stats.drawnTriangles).toBe(m.manifest.triangles)
    m.dispose()
  })

  it("draws coarser with a larger error threshold and culls the back of the sphere with its cones", async () => {
    const m = await ClusteredMesh.load(`file:${dir}/out`, { fetch: fetchFromDisk, occlusionCull: false, pixelError: 1e-4 })
    const far = camera(6)
    await settled(m, far)
    const culled = m.stats
    expect(culled.backfaceCulled).toBeGreaterThan(0)
    expect(culled.drawnTriangles).toBeLessThan(m.manifest.triangles)
    m.pixelError = 50
    m.update(far, renderer)
    expect(m.stats.drawnTriangles).toBeLessThan(culled.drawnTriangles)
    m.frozen = true
    m.pixelError = 1e-4
    m.update(far, renderer)
    expect(m.stats.drawnTriangles).toBeLessThan(culled.drawnTriangles)
    m.dispose()
  })

  it("refuses a manifest of another format", async () => {
    const badFetch = async () => new Response(JSON.stringify({ format: 3, recordWords: 32 }), { status: 200 })
    await expect(ClusteredMesh.load("/x", { fetch: badFetch })).rejects.toThrow(/format 3/)
  })
})
