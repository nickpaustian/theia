// A small static server for the preview pages: the page itself, the package's dist, the host
// project's three, and one or more asset folders with HTTP Range support so the runtime can
// fetch pages by byte range exactly as it would from a CDN.

import { createServer } from "node:http"
import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, resolve, sep } from "node:path"
import { execFile } from "node:child_process"

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".map": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm",
}

const sendFile = (req, res, path) => {
  const size = statSync(path).size
  const headers = {
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Cache-Control": path.endsWith("manifest.json") ? "no-cache" : "no-store",
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    let end = match[1] && match[2] ? Number(match[2]) : size - 1
    end = Math.min(end, size - 1)
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 })
    createReadStream(path, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, "Content-Length": size })
  createReadStream(path).pipe(res)
}

// mounts: [{ prefix: "/asset", dir }] served longest prefix first; pages: { "/": html }
export const serve = ({ mounts, pages, port, open }) => {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length)
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    const pathname = decodeURIComponent(url.pathname)
    if (pages[pathname]) {
      const body = pages[pathname]
      res.writeHead(200, { "Content-Type": types[".html"], "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" })
      res.end(body)
      return
    }
    for (const { prefix, dir } of sorted) {
      if (pathname !== prefix && !pathname.startsWith(prefix + "/")) continue
      const root = resolve(dir)
      const path = resolve(root, "." + pathname.slice(prefix.length))
      if (path !== root && !path.startsWith(root + sep)) break
      if (!existsSync(path) || !statSync(path).isFile()) break
      sendFile(req, res, path)
      return
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end(`not found: ${pathname}`)
  })
  return new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(port, "127.0.0.1", () => {
      const address = `http://localhost:${server.address().port}/`
      console.log(`preview at ${address} (ctrl-c to stop)`)
      if (open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
        execFile(opener, [address], () => {})
      }
      done({ server, address })
    })
  })
}

export const parseArgs = (argv) => {
  const positional = argv.filter((a) => !a.startsWith("--"))
  const option = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : argv[i + 1]
  }
  return { positional, option, flag: (name) => argv.includes(`--${name}`) }
}
