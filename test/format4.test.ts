import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sphere, writeGlb } from "./fixtures.js"
import { codecReady, decodePage, expandRecords, packRecords, RECORD_WORDS, WIRE_RECORD_WORDS } from "../tools/page.mjs"

const cli = join(import.meta.dirname, "..", "tools", "cli.mjs")
const run = (...args: string[]) => spawnSync("node", [cli, ...args], { encoding: "utf8" })
let dir: string
const mesh = sphere({ segments: 64, rings: 32 })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "theia-format4-"))
  writeGlb(join(dir, "sphere.glb"), mesh)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("format 4 records", () => {
  it("pack and expand within the grid's precision, never shrinking a sphere or widening a cone", () => {
    const grid = { origin: [-1, -1, -1] as [number, number, number], step: 2 / 65535 }
    const count = 3
    const records = new Uint32Array(count * RECORD_WORDS)
    const floats = new Float32Array(records.buffer)
    for (let c = 0; c < count; c++) {
      const w = c * RECORD_WORDS
      records[w] = 5 + c; records[w + 1] = 42; records[w + 2] = c === 2 ? 0xffffffff : 1000 + c
      records[w + 3] = 300 * c; records[w + 4] = 372; records[w + 5] = 64 * c; records[w + 6] = 64
      floats[w + 7] = 0.001 * (c + 1); floats.set([0.1 * c, -0.2, 0.3, 0.05], w + 8)
      floats[w + 12] = 0.01 * (c + 1); floats.set([0.1 * c, -0.2, 0.3, 0.09], w + 13)
      floats.set([0.1, 0.2, 0.3, 0, 0.6, 0.8, 0.7071], w + 17)
      records[w + 24] = c === 2 ? 0xffffffff : 3; records[w + 25] = 123456; records[w + 26] = 2048
      floats[w + 27] = 0.25; floats[w + 28] = 0.75; records[w + 29] = 777 + c
    }
    const packed = packRecords(records, count, grid)
    expect(packed.length).toBe(count * WIRE_RECORD_WORDS)
    const back = expandRecords(packed, count, 42, grid)
    const backF = new Float32Array(back.buffer)
    for (let c = 0; c < count; c++) {
      const w = c * RECORD_WORDS
      for (const k of [0, 1, 2, 3, 4, 5, 6, 24, 25, 26, 29]) expect(back[w + k], `word ${k}`).toBe(records[w + k])
      expect(backF[w + 7]).toBe(floats[w + 7])
      expect(backF[w + 12]).toBe(floats[w + 12])
      for (const k of [8, 9, 10, 13, 14, 15, 17, 18, 19]) expect(Math.abs(backF[w + k] - floats[w + k]), `float ${k}`).toBeLessThan(grid.step)
      for (const k of [11, 16]) { expect(backF[w + k]).toBeGreaterThanOrEqual(floats[w + k] + grid.step); expect(backF[w + k] - floats[w + k]).toBeLessThan(3 * grid.step) }
      for (const k of [20, 21, 22]) expect(Math.abs(backF[w + k] - floats[w + k])).toBeLessThan(0.001)
      expect(backF[w + 23]).toBeGreaterThanOrEqual(floats[w + 23])
      expect(backF[w + 23] - floats[w + 23]).toBeLessThan(0.0001)
      expect(Math.abs(backF[w + 27] - 0.25)).toBeLessThan(0.0001)
      expect(Math.abs(backF[w + 28] - 0.75)).toBeLessThan(0.0001)
    }
  })

  it("builds format 4 by default, repacks to a coarser grid, and both pass inspect with the same cut", async () => {
    const out = join(dir, "sphere")
    const built = run("build", join(dir, "sphere.glb"), out)
    expect(built.status, built.stderr).toBe(0)
    const inspected = run("inspect", out)
    expect(inspected.status, inspected.stderr).toBe(0)
    const twenty = join(dir, "sphere20")
    expect(run("build", join(dir, "sphere.glb"), twenty, "--position-bits", "20", "--format", "3").status).toBe(0)
    const repacked = join(dir, "repacked")
    const r = run("repack", twenty, repacked, "--position-bits", "16")
    expect(r.status, r.stderr).toBe(0)
    expect(run("inspect", repacked).status).toBe(0)
    const a = JSON.parse(readFileSync(join(twenty, "manifest.json"), "utf8"))
    const b = JSON.parse(readFileSync(join(repacked, "manifest.json"), "utf8"))
    expect(b.format).toBe(4)
    expect(b.quantisation.positionBits).toBe(16)
    expect(b.clusterCount).toBe(a.clusterCount)
    expect(b.pageCount).toBe(a.pageCount)
    expect(b.roots.map((x: { id: number }) => x.id)).toEqual(a.roots.map((x: { id: number }) => x.id))
    const bytes = (m: { levels: { byteLength: number }[] }) => m.levels.reduce((n, l) => n + l.byteLength, 0)
    expect(bytes(b)).toBeLessThan(bytes(a) * 0.9)
    for (const level of b.levels) expect(statSync(join(repacked, level.file)).size).toBe(level.byteLength)
    // The repacked root decodes to the same records as the original, within the grid.
    await codecReady()
    const rootA = a.roots[0], rootB = b.roots[0]
    const pageA = decodePage(readFileSync(join(twenty, a.levels[rootA.level].file)).subarray(rootA.offset, rootA.offset + rootA.length), a)
    const pageB = decodePage(readFileSync(join(repacked, b.levels[rootB.level].file)).subarray(rootB.offset, rootB.offset + rootB.length), b)
    expect(pageB.clusterCount).toBe(pageA.clusterCount)
    expect(pageB.vertexCount).toBe(pageA.vertexCount)
    expect(pageB.indexCount).toBe(pageA.indexCount)
    const fa = new Float32Array(pageA.records.buffer, pageA.records.byteOffset, pageA.records.length)
    const fb = new Float32Array(pageB.records.buffer, pageB.records.byteOffset, pageB.records.length)
    for (let c = 0; c < pageA.clusterCount; c++) {
      const w = c * RECORD_WORDS
      expect(pageB.records[w + 2]).toBe(pageA.records[w + 2])
      expect(fb[w + 7]).toBe(fa[w + 7])
      expect(Math.abs(fb[w + 8] - fa[w + 8])).toBeLessThan(b.recordGrid.step)
    }
    for (let v = 0; v < pageA.vertexCount * 8; v += 8) expect(Math.abs(pageB.vertices[v] - pageA.vertices[v])).toBeLessThan(b.quantisation.step)
  })
})
