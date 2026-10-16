import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Page } from "playwright"
import { sphere, writeGlb } from "../fixtures.js"
import { openPreview, smokeCli } from "./browser.js"

const cli = smokeCli(import.meta.dirname)
let dir: string
let page: Page
let errors: string[]
let close: () => Promise<void>

// Renders once more and counts the viewport pixels that still show the magenta background
const magentaPixels = () => page.evaluate(() => {
  const { renderer, scene, camera } = window.theiaPreview
  renderer.render(scene, camera)
  const canvas = document.createElement("canvas")
  const { width, height } = renderer.domElement
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(renderer.domElement, 0, 0)
  const { data } = ctx.getImageData(0, 0, width, height)
  let count = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) count++
  return { count, total: width * height }
})
// Lets the page's own loop run a few frames so a moved camera has been traversed and rendered
const frames = (n: number) => page.evaluate((count) => new Promise<void>((done) => {
  let seen = 0
  const tick = () => (++seen >= count ? done() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}), n)
const idle = () => page.waitForFunction(() => {
  const s = window.theia.stats
  return s.network.queued === 0 && s.network.inFlight === 0 && s.wantedPages === 0
}, undefined, { timeout: 60_000 })

declare global {
  interface Window {
    theia: import("../../index.js").ClusteredMesh
    theiaPreview: { renderer: import("three").WebGLRenderer; scene: import("three").Scene; camera: import("three").PerspectiveCamera; THREE: typeof import("three") }
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "theia-smoke-"))
  writeGlb(join(dir, "sphere.glb"), sphere({ segments: 96, rings: 48 }))
  const built = spawnSync("node", [cli, "build", join(dir, "sphere.glb"), join(dir, "out")], { encoding: "utf8" })
  if (built.status !== 0) throw new Error(built.stderr)
  ;({ page, errors, close } = await openPreview(cli, [join(dir, "out")]))
  await page.waitForFunction(() => window.theia && window.theia.stats.residentPages > 0, undefined, { timeout: 60_000 })
})
afterAll(async () => {
  await close?.()
  rmSync(dir, { recursive: true, force: true })
})

describe("theia in a browser", () => {
  it("streams and draws the hierarchy with no failures", async () => {
    await idle()
    const stats = await page.evaluate(() => window.theia.stats)
    expect(stats.drawnTriangles).toBeGreaterThan(0)
    expect(stats.network.failures).toBe(0)
    expect(stats.residentPages).toBeGreaterThan(stats.slots > 1 ? 1 : 0)
    expect(errors).toEqual([])
  })

  it("shows no cracks through a cut that mixes levels", async () => {
    // The preview normalises by the manifest's conservative root sphere; undo that so the unit
    // sphere sits at the origin and a camera at 1.3 sees nothing but its surface
    await page.evaluate(() => {
      const { scene, camera, THREE } = window.theiaPreview
      window.theia.scale.setScalar(1)
      window.theia.position.set(0, 0, 0)
      scene.background = new THREE.Color(1, 0, 1)
      camera.position.set(0, 0, 1.3)
      camera.lookAt(0, 0, 0)
      window.theia.pixelError = 6
    })
    await frames(4)
    await idle()
    await frames(4)
    const perLevel = await page.evaluate(() => window.theia.stats.perLevel.filter((n) => n > 0).length)
    expect(perLevel).toBeGreaterThan(1)
    const { count } = await magentaPixels()
    expect(count).toBe(0)
  })

  it("leaves no holes while the camera whips around with occlusion culling on", async () => {
    await page.evaluate(() => { window.theia.pixelError = 1.5; window.theia.occlusionCull = true })
    await frames(4)
    await idle()
    await frames(4)
    const worst = await page.evaluate(async () => {
      const { renderer, scene, camera } = window.theiaPreview
      const canvas = document.createElement("canvas")
      const { width, height } = renderer.domElement
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")!
      let worst = 0
      for (let frame = 0; frame < 24; frame++) {
        const angle = frame * 0.35
        camera.position.set(Math.sin(angle) * 1.3, Math.sin(angle * 0.5) * 0.4, Math.cos(angle) * 1.3)
        camera.lookAt(0, 0, 0)
        await new Promise((r) => requestAnimationFrame(r))
        renderer.render(scene, camera)
        ctx.drawImage(renderer.domElement, 0, 0)
        const { data } = ctx.getImageData(0, 0, width, height)
        let count = 0
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) count++
        worst = Math.max(worst, count)
      }
      return worst
    })
    expect(worst).toBe(0)
    expect(errors).toEqual([])
  })
})
