import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright"

// Starts the package's preview server on an ephemeral port and a headless Chromium with
// software WebGL; returns the page with the preview loaded
export const openPreview = async (cli: string, args: string[], query = "") => {
  const server: ChildProcess = spawn("node", [cli, "preview", ...args, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] })
  const url = await new Promise<string>((resolve, reject) => {
    let out = ""
    server.stdout!.on("data", (chunk) => {
      out += chunk
      const match = /preview at (http:\/\/[^ ]+)/.exec(out)
      if (match) resolve(match[1])
    })
    server.stderr!.on("data", (chunk) => reject(new Error(String(chunk))))
    server.on("exit", (code) => reject(new Error(`preview exited with ${code}: ${out}`)))
  })
  const browser: Browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
  const page: Page = await browser.newPage({ viewport: { width: 640, height: 480 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  await page.goto(url + query)
  return { page, errors, close: async () => { await browser.close(); server.kill() } }
}

export const smokeCli = (dir: string) => join(dir, "..", "..", "tools", "cli.mjs")
