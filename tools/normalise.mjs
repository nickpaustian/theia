#!/usr/bin/env node
// Runs normalise-mesh.py under a headless Blender: bakes the importer's transform into the
// vertices, optionally rescales, and moves the origin, writing a glTF binary for `theia build`.
//
//   theia normalise <input.fbx|glb> <output.glb> [--reference ref.glb] [--size N] [--origin surface|bounds|match|keep] [--blender path]
//
// Blender is found from --blender, the BLENDER environment variable, the PATH, or the usual
// install locations.

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "./serve.mjs"

const { positional, option } = parseArgs(process.argv.slice(2))
const [input, output] = positional
const fail = (message) => {
  console.error(`normalise: ${message}`)
  process.exit(1)
}
if (!input || !output) fail("usage: theia normalise <input.fbx|glb> <output.glb> [--reference ref.glb] [--size N] [--origin surface|bounds|match|keep] [--blender path]")
if (!existsSync(input) || !statSync(input).isFile()) fail(`${input} is not a file`)
const reference = option("reference", null)
if (reference && !existsSync(reference)) fail(`${reference} is not a file`)
const origin = option("origin", "surface")
if (!["surface", "bounds", "match", "keep"].includes(origin)) fail(`unknown origin mode ${origin}`)
if (origin === "match" && !reference) fail("--origin match needs --reference")
const size = option("size", null)
if (size !== null && !(Number(size) > 0)) fail(`--size must be a positive number, got ${size}`)

const runs = (path) => spawnSync(path, ["--version"], { stdio: "ignore" }).status === 0
const given = option("blender", null) ?? process.env.BLENDER
const candidates = [
  "blender",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/snap/bin/blender",
  "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
]
const blender = given ? (runs(given) ? given : fail(`${given} does not run as Blender`)) : candidates.find(runs)
if (!blender) fail("Blender was not found; pass --blender <path to the executable> or set BLENDER")

const script = join(dirname(fileURLToPath(import.meta.url)), "normalise-mesh.py")
const args = ["-b", "--factory-startup", "--python", script, "--", input, output, "--origin", origin]
if (reference) args.push("--reference", reference)
if (size !== null) args.push("--size", size)
console.log(`${blender} ${args.slice(0, 5).join(" ")} ...`)
const result = spawnSync(blender, args, { stdio: "inherit" })
if (result.status !== 0) fail(`Blender exited with status ${result.status}`)
if (!existsSync(output)) fail(`Blender finished but ${output} was not written`)
console.log(`wrote ${output} (${(statSync(output).size / 1048576).toFixed(1)} MB)`)
