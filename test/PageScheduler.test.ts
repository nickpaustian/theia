import { describe, it, expect } from "vitest"
import { PageScheduler } from "../index.js"
import type { PoolClient, PoolTicket } from "../index.js"

const file = new Uint8Array(100_000)
for (let i = 0; i < file.length; i++) file[i] = i & 255

// A static host for one file, with optional Range support and a per-request gate
const host = ({ honourRange = true } = {}) => {
  const requests: Array<{ range: string | null; aborted: boolean }> = []
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string>)?.Range ?? null
    const entry = { range, aborted: false }
    requests.push(entry)
    init?.signal?.addEventListener("abort", () => { entry.aborted = true })
    if (url.includes("missing")) return Promise.resolve(new Response("", { status: 404 }))
    if (range && honourRange) {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!
      return Promise.resolve(new Response(file.slice(Number(from), Number(to) + 1), { status: 206 }))
    }
    return Promise.resolve(new Response(file, { status: 200 }))
  }
  return { fetch, requests }
}
const pages = (list: Array<[number, number, number]>) => (id: number) => { const [offset, length] = list[id].slice(1) as [number, number]; return { url: `/level-${list[id][0]}.bin`, offset, length } }
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const loaded = () => { const got = new Map<number, ArrayBuffer>(); return { got, onLoaded: (id: number, buffer: ArrayBuffer) => got.set(id, buffer) } }

describe("PageScheduler", () => {
  it("coalesces neighbouring pages of one file into a single range request and slices them back out", async () => {
    const { fetch, requests } = host()
    const { got, onLoaded } = loaded()
    const scheduler = new PageScheduler(pages([[0, 1000, 500], [0, 1600, 400], [0, 50_000, 300], [1, 0, 100]]), onLoaded, { fetch, coalesceGap: 1024 })
    for (const id of [0, 1, 2, 3]) scheduler.want(id, 1, 1)
    scheduler.endPass(1)
    await settle()
    expect(requests.map((r) => r.range).sort()).toEqual(["bytes=0-99", "bytes=1000-1999", "bytes=50000-50299"])
    expect(got.size).toBe(4)
    expect(new Uint8Array(got.get(1)!)[0]).toBe(1600 & 255)
    expect(new Uint8Array(got.get(1)!).length).toBe(400)
    expect(scheduler.stats).toMatchObject({ completed: 4, requests: 3, failures: 0, bytes: 1400 })
  })

  it("splits a run of pages that would exceed the batch size", async () => {
    const { fetch, requests } = host()
    const scheduler = new PageScheduler(pages([[0, 0, 600], [0, 600, 600], [0, 1200, 600]]), () => {}, { fetch, coalesceGap: 100, maxBatchBytes: 1300 })
    for (const id of [0, 1, 2]) scheduler.want(id, 3 - id, 1)
    scheduler.endPass(1)
    await settle()
    expect(requests.length).toBe(2)
  })

  it("takes the right span from a server that ignores Range", async () => {
    const { fetch } = host({ honourRange: false })
    const { got, onLoaded } = loaded()
    const scheduler = new PageScheduler(pages([[0, 777, 10]]), onLoaded, { fetch })
    scheduler.want(0, 1, 1)
    scheduler.endPass(1)
    await settle()
    expect(Array.from(new Uint8Array(got.get(0)!))).toEqual(Array.from(file.slice(777, 787)))
  })

  it("drops pages that are not restated and aborts a batch only when every page in it is stale", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const aborted: boolean[] = []
    const fetch = (_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const entry = { aborted: false }
      aborted.push(false)
      const index = aborted.length - 1
      init?.signal?.addEventListener("abort", () => { aborted[index] = true; entry.aborted = true; reject(new DOMException("aborted", "AbortError")) })
      gate.then(() => { if (!entry.aborted) resolve(new Response(file.slice(0, 200), { status: 206 })) })
    })
    const scheduler = new PageScheduler(pages([[0, 0, 100], [0, 100, 100], [0, 5000, 100], [0, 9000, 100]]), () => {}, { fetch, concurrency: 2, graceMs: 0, coalesceGap: 50 })
    for (const id of [0, 1, 2, 3]) scheduler.want(id, 1, 1)
    scheduler.endPass(1)
    expect(aborted.length).toBe(2)
    expect(scheduler.stats.queued).toBe(1)
    scheduler.want(1, 1, 2)
    scheduler.endPass(2)
    expect(aborted).toEqual([false, true])
    expect(scheduler.has(3)).toBe(false)
    release()
    await settle()
    expect(scheduler.stats).toMatchObject({ aborted: 1, completed: 2 })
  })

  it("remembers failed pages and cools down dropped ones", async () => {
    const { fetch } = host()
    const scheduler = new PageScheduler((id) => ({ url: id === 0 ? "/missing.bin" : "/level-0.bin", offset: 0, length: 10 }), () => {}, { fetch, cooldownFrames: 5 })
    scheduler.want(0, 1, 1)
    scheduler.endPass(1)
    await settle()
    expect(scheduler.stats.failures).toBe(1)
    expect(scheduler.canRequest(0, 99)).toBe(false)
    scheduler.dropped(1, 10)
    expect(scheduler.canRequest(1, 14)).toBe(false)
    expect(scheduler.canRequest(1, 15)).toBe(true)
  })

  it("holds a pool ticket per page and gathers the batch when the pool starts one", async () => {
    type Entry = { priority: number; run: (c: { progress: (n: number) => void }) => Promise<void>; cancelled: boolean }
    const waiting: Entry[] = []
    const client: PoolClient = { submit(priority, run, onCancel): PoolTicket { const e: Entry = { priority, run, cancelled: false }; waiting.push(e); return { setPriority: (p) => { e.priority = p }, cancel: () => { e.cancelled = true; onCancel?.() }, started: false } } }
    const { fetch, requests } = host()
    const { got, onLoaded } = loaded()
    const scheduler = new PageScheduler(pages([[0, 0, 100], [0, 100, 100], [0, 40_000, 100]]), onLoaded, { fetch, pool: client, coalesceGap: 50 })
    scheduler.want(0, 4, 1)
    scheduler.want(1, 2, 1)
    scheduler.want(2, 1, 1)
    scheduler.endPass(1)
    expect(waiting.map((e) => e.priority)).toEqual([1, 0.5, 0.25])
    expect(requests.length).toBe(0)
    await waiting[0].run({ progress: () => {} })
    expect(requests.map((r) => r.range)).toEqual(["bytes=0-199"])
    expect(waiting[1].cancelled).toBe(true)
    expect([...got.keys()].sort()).toEqual([0, 1])
    expect(scheduler.has(2)).toBe(true)
  })

  it("ranks pooled pages by priority per byte when asked", () => {
    const waiting: number[] = []
    const client: PoolClient = { submit(priority): PoolTicket { waiting.push(priority); return { setPriority: () => {}, cancel: () => {}, started: false } } }
    const { fetch } = host()
    const scheduler = new PageScheduler(pages([[0, 0, 100], [0, 40_000, 400]]), () => {}, { fetch, pool: client, valuePerByte: true })
    scheduler.want(0, 2, 1)
    scheduler.want(1, 2, 1)
    scheduler.endPass(1)
    expect(waiting).toEqual([0.02, 0.005])
  })
})
