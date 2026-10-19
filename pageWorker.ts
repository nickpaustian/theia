// The page decoder's worker: receives a page's bytes and the manifest fields the codec needs,
// and sends back the prepared page with its buffers transferred. Built to dist/pageWorker.js
// beside the library; PageDecoder loads it by URL, which bundlers resolve and copy.
import { codecReady, type PageManifestFields } from "./pageCodec.js"
import { preparePage, transferablesOf, type PreparedPage } from "./pageDecode.js"

export interface DecodeRequest {
  id: number
  buffer: ArrayBuffer
  manifest: PageManifestFields
}

export type DecodeReply = { ready: true } | { id: number; prepared: PreparedPage } | { id: number; error: string }

const scope = self as unknown as { onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null; postMessage(message: DecodeReply, transfer?: Transferable[]): void }

scope.onmessage = async (e) => {
  const { id, buffer, manifest } = e.data
  try {
    await codecReady(manifest.format)
    const prepared = preparePage(buffer, manifest)
    scope.postMessage({ id, prepared }, transferablesOf(prepared))
  } catch (error) {
    scope.postMessage({ id, error: String(error) })
  }
}

// Pages are held back with their bytes until this arrives, so a worker that never loads loses nothing
scope.postMessage({ ready: true })
