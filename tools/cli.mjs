#!/usr/bin/env node
const commands = {
  normalise: ["./normalise.mjs", "normalise <in.fbx|glb> <out.glb> [options]  bake transforms and centre a mesh with Blender"],
  build: ["./build-clusters.mjs", "build <mesh.glb> <outDir> [options]         cut a mesh into a streamable cluster hierarchy"],
  inspect: ["./inspect.mjs", "inspect <dir> [--no-scan]                    check a built hierarchy and summarise it per level"],
  preview: ["./preview.mjs", "preview <dir> [--port N] [--no-open]         serve a hierarchy and view it in the browser"],
}
const command = process.argv.splice(2, 1)[0]
if (!commands[command]) {
  console.error(`usage: theia <command> [arguments]\n\n${Object.values(commands).map(([, help]) => "  " + help).join("\n")}`)
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1)
}
await import(commands[command][0])
