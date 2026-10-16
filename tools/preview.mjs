#!/usr/bin/env node
// Serves a built hierarchy together with this package's dist and the host project's three,
// and opens a viewer page: orbit controls, stats, and the runtime knobs on keys.
//
//   theia preview <dir> [--port 4180] [--no-open] [--error 1.5] [--slots 4096]

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { serve, parseArgs } from "./serve.mjs"

const { positional, option, flag } = parseArgs(process.argv.slice(2))
const [dir] = positional
const fail = (message) => {
  console.error(`preview: ${message}`)
  process.exit(1)
}
if (!dir) fail("usage: theia preview <dir> [--port 4180] [--no-open] [--error 1.5] [--slots 4096]")
if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} has no manifest.json`)

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, "..", "dist")
if (!existsSync(join(dist, "index.js"))) fail(`${dist} has no build; run "npm run build" in the package first`)
// three's exports map hides its package.json, so resolve the entry point and walk up to the folder
let threeDir
try {
  threeDir = dirname(createRequire(import.meta.url).resolve("three"))
  while (!existsSync(join(threeDir, "package.json")) || JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")).name !== "three") {
    const parent = dirname(threeDir)
    if (parent === threeDir) throw new Error("no package root")
    threeDir = parent
  }
} catch {
  fail("three is not installed next to this package")
}

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Theia preview: ${dir}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1c1c1e; overflow: hidden; }
  canvas { display: block; }
  #hud, #help { position: fixed; left: 12px; padding: 10px 12px; background: rgba(0,0,0,.72); color: #fff;
    font: 12px/1.5 ui-monospace, Menlo, monospace; border-radius: 6px; white-space: pre; pointer-events: none; }
  #hud { top: 12px; }
  #help { bottom: 12px; display: none; }
  #hint { position: fixed; right: 12px; bottom: 12px; color: #fff; background: rgba(0,0,0,.72); padding: 8px 12px;
    border-radius: 6px; font: 12px ui-monospace, Menlo, monospace; }
</style>
<script type="importmap">
{ "imports": { "three": "/three/build/three.module.js", "three/addons/": "/three/examples/jsm/", "@nickpaustian/theia": "/dist/index.js" } }
</script>
</head>
<body>
<div id="hud">loading…</div>
<div id="help">H  this help
C  colour by cluster / level / off
F  freeze the cut
W  wireframe
B  backface culling
O  occlusion culling
[ ]  pixel error down / up
, .  detail cap down / up</div>
<div id="hint">H help</div>
<script type="module">
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { ClusteredMesh } from "@nickpaustian/theia"

const params = new URLSearchParams(location.search)
const hud = document.getElementById("hud")
const help = document.getElementById("help")
const hint = document.getElementById("hint")

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1c1c1e)
scene.add(new THREE.GridHelper(40, 40, 0x3a3a3c, 0x2c2c2e).translateY(-1.2))
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2))
const key = new THREE.DirectionalLight(0xffffff, 1.5)
key.position.set(2, 3, 4)
scene.add(key)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100)
camera.position.set(0, 0, 3)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 0.02
controls.maxDistance = 20

const mesh = await ClusteredMesh.load("/asset", {
  pixelError: Number(params.get("error")) || ${Number(option("error", 1.5))},
  slots: Number(params.get("slots")) || ${Number(option("slots", 4096))},
  material: new THREE.MeshStandardMaterial({ color: 0xcfc6b8, roughness: 0.8, metalness: 0 }),
})
window.theia = mesh
window.theiaPreview = { renderer, scene, camera, controls, THREE }
const sphere = mesh.geometry.boundingSphere
mesh.position.copy(sphere.center).multiplyScalar(-1 / sphere.radius)
mesh.scale.setScalar(1 / sphere.radius)
scene.add(mesh)

window.addEventListener("keydown", (event) => {
  switch (event.code) {
    case "KeyH": { const open = help.style.display === "block"; help.style.display = open ? "" : "block"; hint.style.display = open ? "" : "none"; break }
    case "KeyC": mesh.debugColour = (mesh.debugColour + 1) % 3; break
    case "KeyF": mesh.frozen = !mesh.frozen; break
    case "KeyW": mesh.material.wireframe = !mesh.material.wireframe; break
    case "KeyB": mesh.backfaceCull = !mesh.backfaceCull; break
    case "KeyO": mesh.occlusionCull = !mesh.occlusionCull; break
    case "Comma": mesh.detailCap = Math.max(0, mesh.detailCap - 1); break
    case "Period": mesh.detailCap = Math.min(mesh.manifest.levels.length - 1, mesh.detailCap + 1); break
    case "BracketLeft": mesh.pixelError = Math.max(0.25, mesh.pixelError / 1.5); break
    case "BracketRight": mesh.pixelError = Math.min(64, mesh.pixelError * 1.5); break
  }
})
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

let frames = 0, lastFps = performance.now(), fps = 0
const render = () => {
  requestAnimationFrame(render)
  controls.update()
  mesh.update(camera, renderer)
  renderer.render(scene, camera)
  frames++
  const now = performance.now()
  if (now - lastFps > 500) { fps = Math.round((frames * 1000) / (now - lastFps)); frames = 0; lastFps = now }
  const s = mesh.stats
  const m = mesh.manifest
  hud.textContent = [
    \`\${m.name}  \${m.clusterCount} clusters in \${m.pageCount} pages  \${m.levels.length} levels  \${m.triangles} tris at full detail\`,
    \`drawn \${s.drawnTriangles} tris in \${s.drawnClusters} clusters  culled: backface \${s.backfaceCulled}  occluded \${s.occlusionCulled}  per level \${s.perLevel.join(" ")}\`,
    \`pages \${s.residentPages}/\${s.slots} resident  wanted \${s.wantedPages}  dropped \${s.dropped}  arena \${(s.memoryBytes / 1048576).toFixed(0)} MB  index rebuilds \${s.indexRebuilds}\`,
    \`network queued \${s.network.queued}  in flight \${s.network.inFlight}  pages \${s.network.completed} in \${s.network.requests} requests  aborted \${s.network.aborted}  failed \${s.network.failures}  \${(s.network.bytes / 1048576).toFixed(1)} MB\`,
    \`pixel error \${s.pixelError.toFixed(2)}  detail cap \${s.detailCap}  colour \${["off", "cluster", "level"][mesh.debugColour]}  backface \${mesh.backfaceCull ? "on" : "off"}  occlusion \${mesh.occlusionCull ? "on" : "off"}\${mesh.frozen ? "  FROZEN" : ""}\`,
    \`\${fps} fps  distance \${camera.position.length().toFixed(3)}\`,
  ].join("\\n")
}
render()
</script>
</body>
</html>`

await serve({
  mounts: [
    { prefix: "/asset", dir },
    { prefix: "/dist", dir: dist },
    { prefix: "/three", dir: threeDir },
  ],
  pages: { "/": page },
  port: Number(option("port", 4180)),
  open: !flag("no-open"),
}).catch((error) => fail(error.message))
