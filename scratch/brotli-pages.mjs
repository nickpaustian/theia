// Brotli and gzip over individual pages (what a range-fetched page could carry), not whole files.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { brotliCompressSync, gzipSync, constants } from "node:zlib"
const dir = process.argv[2]
const maxPages = Number(process.argv[3] ?? 3000)
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
const levels = manifest.levels.map((l) => readFileSync(join(dir, l.file)))
const RW = 32, NONE = 0xffffffff
const queue = manifest.roots.map((r) => ({ id: r.id, level: r.level, offset: r.offset, length: r.length }))
const seen = new Set()
let pages = 0, raw = 0, br11 = 0, br5 = 0, gz = 0, records = 0, vertexBytes = 0, indexBytes = 0
while (queue.length && pages < maxPages) {
  const p = queue.shift()
  if (seen.has(p.id)) continue
  seen.add(p.id)
  const bytes = levels[p.level].subarray(p.offset, p.offset + p.length)
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, 6)
  const clusterCount = words[1]
  pages++
  raw += p.length
  records += clusterCount * RW * 4
  vertexBytes += words[4]
  indexBytes += words[5]
  br11 += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: p.length } }).length
  br5 += brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length
  gz += gzipSync(bytes, { level: 9 }).length
  const recs = new Uint32Array(bytes.buffer, bytes.byteOffset + 24, clusterCount * RW)
  for (let c = 0; c < clusterCount; c++) {
    const w = c * RW
    const child = recs[w + 2]
    if (child !== NONE && !seen.has(child)) queue.push({ id: child, level: recs[w + 24], offset: recs[w + 25], length: recs[w + 26] })
  }
}
console.log(`${dir.split("/").pop()}: ${pages} pages, mean ${(raw / pages).toFixed(0)} B (records ${(100 * records / raw).toFixed(0)}%, vertices ${(100 * vertexBytes / raw).toFixed(0)}%, indices ${(100 * indexBytes / raw).toFixed(0)}%)`)
console.log(`  per page: gzip ${(100 * gz / raw).toFixed(0)}% · brotli q5 ${(100 * br5 / raw).toFixed(0)}% · brotli q11 ${(100 * br11 / raw).toFixed(0)}%`)
