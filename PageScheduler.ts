import type { PoolClient, PoolTicket, PoolRunContext } from "./pool.js"

// A fetch-shaped function: hosts wrap the global one to add headers or sign URLs
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface PageSchedulerOptions {
  // Used for page requests; the global fetch by default
  fetch?: FetchLike
  // Fetches in flight at once (each may carry several pages; ignored when a pool sets the budget)
  concurrency?: number
  // A shared fetch pool client (see @nickpaustian/tethys): every queued page holds a ticket, and when the
  // pool starts one the batch is gathered around it then, so coalescing still sees the latest queue
  pool?: PoolClient
  // Queued pages in the same file within this many bytes of each other travel in one request
  // (the gap is fetched too, so keep it near a page in size)
  coalesceGap?: number
  // Largest single request, in bytes
  maxBatchBytes?: number
  // Milliseconds a page may go unwanted before an in-flight fetch is aborted
  graceMs?: number
  // In-flight fetches past this fraction of their bytes are left to finish
  abortBelow?: number
  // Frames to wait before re-requesting a page the arena could not take
  cooldownFrames?: number
  // With a pool: rank pages by priority per byte of the page rather than by priority alone, so
  // a small page that removes as much error as a large one goes first and a pool shared with
  // Atlas can weigh pages against tiles by the same measure
  valuePerByte?: boolean
}

export interface PageSchedulerStats {
  queued: number
  inFlight: number
  completed: number
  requests: number
  aborted: number
  failures: number
  bytes: number
}

export interface PageRange {
  url: string
  offset: number
  length: number
}

interface Scheduled {
  id: number
  priority: number
  pass: number
  wantedAt: number
  range: PageRange
  ticket: PoolTicket | null
}

interface Batch {
  url: string
  offset: number
  length: number
  items: Scheduled[]
  controller: AbortController
  received: number
}

// A prioritised queue of byte-range fetches with the same contract as Atlas's tile scheduler:
// every pass restates what is wanted; anything not restated is dropped from the queue, and
// in-flight fetches that stay unwanted past a grace period are aborted unless they are mostly
// downloaded already.
export default class PageScheduler {
  private concurrency: number
  private graceMs: number
  private abortBelow: number
  private cooldownFrames: number
  private valuePerByte: boolean
  private pool: PoolClient | null
  private range: (id: number) => PageRange
  private onLoaded: (id: number, buffer: ArrayBuffer) => void

  private coalesceGap: number
  private maxBatchBytes: number
  private fetch: FetchLike

  private queue: Map<number, Scheduled> = new Map()
  private inFlight: Map<number, Scheduled> = new Map()
  private batches: Set<Batch> = new Set()
  private failed: Set<number> = new Set()
  private cooldown: Map<number, number> = new Map()
  private disposed: boolean = false

  private completed: number = 0
  private requests: number = 0
  private aborted: number = 0
  private failures: number = 0
  private bytes: number = 0

  constructor(
    range: (id: number) => PageRange,
    onLoaded: (id: number, buffer: ArrayBuffer) => void,
    {
      concurrency = 12,
      graceMs = 250,
      abortBelow = 0.5,
      cooldownFrames = 30,
      valuePerByte = false,
      coalesceGap = 16384,
      maxBatchBytes = 1 << 20,
      pool = null,
      fetch: fetchImpl = (url, init) => fetch(url, init),
    }: PageSchedulerOptions = {}
  ) {
    this.pool = pool
    this.fetch = fetchImpl
    this.range = range
    this.onLoaded = onLoaded
    this.concurrency = concurrency
    this.coalesceGap = coalesceGap
    this.maxBatchBytes = maxBatchBytes
    this.graceMs = graceMs
    this.abortBelow = abortBelow
    this.cooldownFrames = cooldownFrames
    this.valuePerByte = valuePerByte
  }

  public has(id: number): boolean {
    return this.queue.has(id) || this.inFlight.has(id)
  }

  public canRequest(id: number, frame: number): boolean {
    if (this.failed.has(id)) return false
    const until = this.cooldown.get(id)
    if (until !== undefined) {
      if (frame < until) return false
      this.cooldown.delete(id)
    }
    return true
  }

  public want(id: number, priority: number, pass: number): void {
    const existing = this.queue.get(id) ?? this.inFlight.get(id)
    if (existing) {
      existing.priority = priority
      existing.pass = pass
      existing.wantedAt = performance.now()
      return
    }
    this.queue.set(id, { id, priority, pass, wantedAt: performance.now(), range: this.range(id), ticket: null })
  }

  // A batch is aborted only when every page in it has gone stale
  public endPass(pass: number): void {
    for (const [id, item] of this.queue) {
      if (item.pass < pass) {
        item.ticket?.cancel()
        this.queue.delete(id)
      }
    }
    const now = performance.now()
    for (const batch of this.batches) {
      const stillWanted = batch.items.some((item) => item.pass >= pass || now - item.wantedAt < this.graceMs)
      if (stillWanted) continue
      if (batch.received / batch.length >= this.abortBelow) continue
      batch.controller.abort()
    }
    this.pump()
  }

  public dropped(id: number, frame: number): void {
    this.cooldown.set(id, frame + this.cooldownFrames)
  }

  private pump(): void {
    if (this.disposed) return
    if (this.pool) {
      this.pumpPooled(this.pool)
      return
    }
    while (this.batches.size < this.concurrency && this.queue.size > 0) {
      let best: Scheduled | null = null
      for (const item of this.queue.values()) if (!best || item.priority > best.priority) best = item
      if (!best) break
      const batch = this.gather(best)
      for (const item of batch.items) {
        this.queue.delete(item.id)
        this.inFlight.set(item.id, item)
      }
      this.batches.add(batch)
      this.load(batch).finally(() => {
        this.batches.delete(batch)
        for (const item of batch.items) this.inFlight.delete(item.id)
        this.pump()
      })
    }
  }

  private pumpPooled(pool: PoolClient): void {
    let max = 0
    for (const item of this.queue.values()) max = Math.max(max, item.priority)
    for (const item of this.queue.values()) {
      const priority = this.valuePerByte ? Math.min(item.priority, Number.MAX_VALUE) / Math.max(1, item.range.length) : max > 0 ? item.priority / max : 1
      if (item.ticket) {
        item.ticket.setPriority(priority)
        continue
      }
      item.ticket = pool.submit(
        priority,
        async (context) => {
          if (!this.queue.has(item.id)) return
          const batch = this.gather(item)
          for (const member of batch.items) {
            if (member !== item) member.ticket?.cancel()
            member.ticket = null
            this.queue.delete(member.id)
            this.inFlight.set(member.id, member)
          }
          this.batches.add(batch)
          try {
            await this.load(batch, context)
          } finally {
            this.batches.delete(batch)
            for (const member of batch.items) this.inFlight.delete(member.id)
          }
        },
        () => {
          item.ticket = null
        }
      )
    }
  }

  // Pulls queued pages from the same file that lie close to the chosen one into its request,
  // so one round trip carries a run of neighbouring pages instead of one page each
  private gather(seed: Scheduled): Batch {
    const near = [seed]
    for (const item of this.queue.values()) {
      if (item === seed || item.range.url !== seed.range.url) continue
      near.push(item)
    }
    near.sort((a, b) => a.range.offset - b.range.offset)
    const at = near.indexOf(seed)
    const items = [seed]
    let start = seed.range.offset
    let end = seed.range.offset + seed.range.length
    for (let i = at - 1; i >= 0; i--) {
      const item = near[i]
      const itemEnd = item.range.offset + item.range.length
      if (start - itemEnd > this.coalesceGap || end - item.range.offset > this.maxBatchBytes) break
      items.push(item)
      start = item.range.offset
    }
    for (let i = at + 1; i < near.length; i++) {
      const item = near[i]
      if (item.range.offset - end > this.coalesceGap || item.range.offset + item.range.length - start > this.maxBatchBytes) break
      items.push(item)
      end = item.range.offset + item.range.length
    }
    return { url: seed.range.url, offset: start, length: end - start, items, controller: new AbortController(), received: 0 }
  }

  private async load(batch: Batch, context?: PoolRunContext): Promise<void> {
    try {
      const response = await this.fetch(batch.url, {
        signal: batch.controller.signal,
        headers: { Range: `bytes=${batch.offset}-${batch.offset + batch.length - 1}` },
      })
      if (!response.ok) throw new Error(`${response.status} ${batch.url}`)
      let buffer = await this.readBody(response, batch, context)
      // A server that ignores Range sends the whole file; take the span we asked for
      if (response.status !== 206) buffer = buffer.slice(batch.offset, batch.offset + batch.length)
      if (this.disposed) return
      this.requests++
      this.bytes += batch.length
      for (const item of batch.items) {
        const from = item.range.offset - batch.offset
        this.completed++
        this.onLoaded(item.id, buffer.slice(from, from + item.range.length))
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        this.aborted += batch.items.length
        return
      }
      this.failures += batch.items.length
      for (const item of batch.items) this.failed.add(item.id)
      console.warn("[theia] page batch failed", batch.url, batch.offset, error)
    }
  }

  private async readBody(response: Response, batch: Batch, context?: PoolRunContext): Promise<ArrayBuffer> {
    const reader = response.body?.getReader()
    if (!reader) return response.arrayBuffer()
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      batch.received = received
      context?.progress(value.byteLength)
    }
    const out = new Uint8Array(received)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return out.buffer
  }

  public get stats(): PageSchedulerStats {
    return {
      queued: this.queue.size,
      inFlight: this.inFlight.size,
      completed: this.completed,
      requests: this.requests,
      aborted: this.aborted,
      failures: this.failures,
      bytes: this.bytes,
    }
  }

  public dispose(): void {
    this.disposed = true
    for (const batch of this.batches) batch.controller.abort()
    for (const item of this.queue.values()) item.ticket?.cancel()
    this.queue.clear()
  }
}
