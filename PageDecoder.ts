// Decodes fetched pages off the main thread: a small pool of workers, each running preparePage
// (meshoptimizer, dequantise, deinterleave), with the page's bytes transferred in and the
// prepared buffers transferred out. With no workers, where Worker is missing, or when the
// worker script cannot be loaded (a page served without a bundler), it decodes inline, so a
// mesh can treat the two alike. Pages are held with their bytes until a worker reports ready,
// so nothing is lost if none ever does. Several meshes may share one.
import type { PageManifestFields } from "./pageCodec.js"
import { preparePage, type PreparedPage } from "./pageDecode.js"
import type { DecodeReply, DecodeRequest } from "./pageWorker.js"

export interface PageDecoderOptions {
  // Workers to decode in; 0 decodes on the main thread. Default: one fewer than the cores, at most 4
  workers?: number
  // Makes one worker; by default the package's own pageWorker.js next to the library
  createWorker?: () => Worker
}

interface Pending {
  request: DecodeRequest
  resolve(prepared: PreparedPage): void
  reject(error: Error): void
  worker: number
}

export const defaultDecodeWorkers = (): number => {
  if (typeof Worker === "undefined") return 0
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.max(1, Math.min(4, cores - 1))
}

const defaultCreateWorker = (): Worker => new Worker(new URL("./pageWorker.js", import.meta.url), { type: "module" })

export default class PageDecoder {
  private workers: Worker[] = []
  private busy: number[] = []
  private ready: boolean[] = []
  private anyReady: boolean = false
  // Decodes asked for before a worker was ready, their buffers still whole
  private waiting: Pending[] = []
  private pending: Map<number, Pending> = new Map()
  private nextId: number = 0
  private disposed: boolean = false

  constructor({ workers = defaultDecodeWorkers(), createWorker = defaultCreateWorker }: PageDecoderOptions = {}) {
    const count = typeof Worker === "undefined" ? 0 : Math.max(0, Math.floor(workers))
    for (let i = 0; i < count; i++) {
      let worker: Worker
      try {
        worker = createWorker()
      } catch {
        break
      }
      worker.onmessage = (e: MessageEvent<DecodeReply>) => ("ready" in e.data ? this.wake(i) : this.settle(e.data))
      worker.onerror = () => this.fallBack()
      this.workers.push(worker)
      this.busy.push(0)
      this.ready.push(false)
    }
  }

  // Workers in the pool; 0 means pages decode on the main thread
  public get workerCount(): number {
    return this.workers.length
  }

  // Pages handed to workers and not yet back, or held until one is ready
  public get inFlight(): number {
    return this.pending.size + this.waiting.length
  }

  // Decodes `buffer` (which the decoder takes over) into a page ready for the arena
  public decode(buffer: ArrayBuffer, manifest: PageManifestFields): Promise<PreparedPage> {
    if (this.disposed) return Promise.reject(new Error("Theia: page decoder disposed"))
    if (this.workers.length === 0) {
      try {
        return Promise.resolve(preparePage(buffer, manifest))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const request: DecodeRequest = { id: this.nextId++, buffer, manifest }
    return new Promise<PreparedPage>((resolve, reject) => {
      const p: Pending = { request, resolve, reject, worker: -1 }
      if (this.anyReady) this.dispatch(p)
      else this.waiting.push(p)
    })
  }

  private dispatch(p: Pending): void {
    let worker = -1
    for (let i = 0; i < this.workers.length; i++) if (this.ready[i] && (worker === -1 || this.busy[i] < this.busy[worker])) worker = i
    p.worker = worker
    this.pending.set(p.request.id, p)
    this.busy[worker]++
    this.workers[worker].postMessage(p.request, [p.request.buffer])
  }

  private wake(worker: number): void {
    if (worker >= this.workers.length) return
    this.ready[worker] = true
    this.anyReady = true
    const held = this.waiting
    this.waiting = []
    for (const p of held) this.dispatch(p)
  }

  private settle(reply: Exclude<DecodeReply, { ready: true }>): void {
    const p = this.pending.get(reply.id)
    if (!p) return
    this.pending.delete(reply.id)
    this.busy[p.worker]--
    if ("error" in reply) p.reject(new Error(reply.error))
    else p.resolve(reply.prepared)
  }

  // A worker that fails to load (its script unreachable, as without a bundler) takes the pool
  // with it: the pages held back are decoded here, and every later page too. A page already
  // transferred to a worker is lost with it and is fetched again after its cooldown
  private fallBack(): void {
    if (this.workers.length === 0) return
    console.info("[theia] page decode workers unavailable; decoding on the main thread")
    for (const worker of this.workers) worker.terminate()
    this.workers = []
    this.busy = []
    this.ready = []
    this.anyReady = false
    const transferred = [...this.pending.values()]
    this.pending.clear()
    for (const p of transferred) p.reject(new Error("Theia: page decode worker failed"))
    const held = this.waiting
    this.waiting = []
    for (const p of held) {
      try {
        p.resolve(preparePage(p.request.buffer, p.request.manifest))
      } catch (error) {
        p.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  public dispose(): void {
    this.disposed = true
    for (const worker of this.workers) worker.terminate()
    this.workers = []
    for (const p of this.pending.values()) p.reject(new Error("Theia: page decoder disposed"))
    for (const p of this.waiting) p.reject(new Error("Theia: page decoder disposed"))
    this.pending.clear()
    this.waiting = []
  }
}
