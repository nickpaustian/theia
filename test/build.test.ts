import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, statSync, openSync, ftruncateSync, closeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sphere, writeGlb } from "./fixtures.js"

const cli = join(import.meta.dirname, "..", "tools", "cli.mjs")
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" })
let dir: string
const mesh = sphere({ segments: 64, rings: 32 })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "theia-test-"))
  writeGlb(join(dir, "sphere.glb"), mesh)
  writeGlb(join(dir, "flat.glb"), mesh, { indexed: false })
  writeGlb(join(dir, "nouv.glb"), mesh, { uv: false })
  writeGlb(join(dir, "two.glb"), mesh, { meshes: 2 })
  writeGlb(join(dir, "nonormals.glb"), mesh, { normals: false })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("theia build", () => {
  it("builds a hierarchy whose manifest and pages pass inspect", () => {
    const out = join(dir, "sphere")
    const result = run("build", join(dir, "sphere.glb"), out)
    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))
    expect(manifest.format).toBe(2)
    expect(manifest.triangles).toBe(mesh.indices.length / 3)
    expect(manifest.levels.length).toBeGreaterThan(3)
    expect(manifest.roots.length).toBeGreaterThan(0)
    expect(manifest.maxPageVertices).toBeLessThanOrEqual(8 * 64)
    for (const level of manifest.levels) expect(statSync(join(out, level.file)).size).toBe(level.byteLength)
    const inspected = run("inspect", out)
    expect(inspected.status, inspected.stderr).toBe(0)
    expect(inspected.stdout).toMatch(/\bok\b/)
    // A closed sphere has no open edges at level 0
    const level0 = inspected.stdout.split("\n").find((line) => /│\s*0\s*│\s*0\s*│/.test(line))!
    expect(level0.trim().split("│").map((c) => c.trim()).filter(Boolean).slice(-2)[0]).toBe("0")
  })
  it("computes normals when the source has none and refuses the inputs it cannot use", () => {
    expect(run("build", join(dir, "nonormals.glb"), join(dir, "nonormals")).status).toBe(0)
    expect(run("build", join(dir, "flat.glb"), join(dir, "x1")).stderr).toMatch(/not indexed/)
    expect(run("build", join(dir, "nouv.glb"), join(dir, "x2")).stderr).toMatch(/TEXCOORD_0/)
    const two = run("build", join(dir, "two.glb"), join(dir, "x3"))
    expect(two.status).toBe(1)
    expect(two.stderr).toMatch(/pick one with --mesh/)
    expect(run("build", join(dir, "two.glb"), join(dir, "two"), "--mesh", "fixture1").status).toBe(0)
    expect(run("build", join(dir, "nope.glb"), join(dir, "x4")).stderr).toMatch(/is not a file/)
  })
  it("refuses a non-empty output folder unless forced", () => {
    const out = join(dir, "sphere")
    expect(run("build", join(dir, "sphere.glb"), out).stderr).toMatch(/not empty/)
    expect(run("build", join(dir, "sphere.glb"), out, "--force").status).toBe(0)
  })
  it("inspect reports a truncated level file", () => {
    const out = join(dir, "two")
    const path = join(out, "level-0.bin")
    const fd = openSync(path, "r+")
    ftruncateSync(fd, statSync(path).size - 64)
    closeSync(fd)
    const result = run("inspect", out, "--no-scan")
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/runs past level 0/)
  })
})
