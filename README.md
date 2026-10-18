# Theia

Cluster-hierarchy level of detail for three.js, within what WebGL 2 allows. A source mesh is cut into small clusters, simplified group by group into a hierarchy, and at runtime a crack-free cut through that hierarchy is chosen every frame by screen-space error, with finer levels streamed as the camera needs them. The approach follows the one Unreal Engine's Nanite made familiar (Karis, *A Deep Dive into Nanite Virtualized Geometry*, SIGGRAPH 2021); Theia is an independent implementation and not affiliated with Epic Games.

Use it for a single dense mesh, scans of a few million triangles and up, that must look sharp close up and stay cheap from afar without discrete LOD switches. For meshes that already draw comfortably in one piece, a plain `Mesh` is simpler.

Theia is the Titaness of sight, and level of detail is a question of what the eye can resolve: the runtime is driven entirely by screen-space error. Its sibling [Atlas](https://github.com/nickpaustian/atlas) streams texture detail by the same measure, and [Tethys](https://github.com/nickpaustian/tethys) shares a connection budget between them.

## Install

```
npm install @nickpaustian/theia three
```

`three` is a peer dependency, tested from r159 to r169. The build tool needs Node 18 or later and `meshoptimizer`.

## Usage

```ts
import { ClusteredMesh } from "@nickpaustian/theia"

const mesh = await ClusteredMesh.load("/clusters/statue", { pixelError: 1.5, slots: 4096 })
scene.add(mesh)

function render() {
  mesh.update(camera, renderer)   // pick the cut, request finer levels
  renderer.render(scene, camera)
}
```

The mesh carries position, normal and uv per vertex, so it textures like any other, with a texture of your own or through Atlas's `attach(mesh)` (without `triangleTint`, which flattens the index buffer). Both modules patch the material through `onBeforeCompile` and each chains whatever patch was there before, so the order does not matter. Call `mesh.dispose(renderer)` to release the arena, index buffers and occlusion target, abort pending fetches and take the shader patch off the material.

`pixelError`, `detailCap`, the culling switches and `debugColour` are public fields and can be changed at any time. `detailCap` holds levels back from the finest (1 halves the triangles): pages below it are neither drawn nor requested while it is set, and finer pages already resident draw again the moment it drops, so it can follow network speed or camera movement where `pixelError` would change the whole cut. Atlas has the same knob.

## Options

`ClusteredMesh.load(url, options)`:

| option | default | meaning |
| --- | --- | --- |
| `material` | `MeshStandardMaterial` | the material to draw with |
| `pixelError` | 1.5 | largest screen-space error, in pixels, a drawn cluster may have |
| `detailCap` | 0 | levels held back from the finest; see above |
| `slots` | 4096 | pages the arena can hold at once; each slot holds `maxPageVertices` vertices from the manifest, so memory is `slots × maxPageVertices × 32` bytes plus indices |
| `protectMs` | 500 | milliseconds a page stays safe from eviction after it was last part of the cut |
| `centreBias` | 1 | how much closeness to the screen centre counts when pages compete for slots |
| `backfaceCull` | true | skip clusters whose normal cone faces away from the camera. Right for opaque, single-sided surfaces; turn off for double-sided or transparent materials |
| `backfaceMargin` | 0.1 | margin on the cone cutoff; larger culls less, protecting silhouettes where a simplified parent's cone can disagree slightly with its children |
| `occlusionCull` | true | hold clusters hidden behind what was drawn last frame, tested against a small depth render of this mesh. Right for meshes that write depth; off for transparent ones |
| `occlusionBias` | 0.03 | fraction of a sphere's distance it is pulled toward the camera before the depth test, so coarse occluder geometry cannot hide a cluster it only just covers |
| `occlusionInterval` | 2 | frames between depth renders while the camera is still; any camera movement re-renders as soon as the previous readback has landed |
| `occlusion.scale` | 8 | the depth target is the viewport divided by this in each axis |
| `occlusion.cell` | 4 | pixels per cell of the max-depth grid spheres are tested against |
| `occlusion.sync` | false | read the depth back synchronously (stalls; for comparison only) |
| `cullMode` | `"refine"` | what occlusion culling does to a cluster it catches. `"refine"` draws it at the level reached but never descends or requests beneath it; `"hide"` skips it outright (see below) |
| `drawMode` | `"compact"` | `"compact"` copies the cut's index ranges into one buffer and draws it once. `"ranges"` is experimental: it submits them through `WEBGL_multi_draw` and needs three r164 to r169 |
| `scheduler.concurrency` | 12 | page fetches in flight at once; ignored when `pool` is set |
| `scheduler.coalesceGap` | 16384 | queued pages in the same file within this many bytes of each other travel in one request (the gap is fetched too) |
| `scheduler.maxBatchBytes` | 1 MiB | largest single request |
| `scheduler.graceMs` | 250 | milliseconds a page may go unwanted before an in-flight fetch is aborted |
| `scheduler.abortBelow` | 0.5 | fetches past this fraction downloaded are left to finish |
| `scheduler.cooldownFrames` | 30 | frames before re-requesting a page the arena could not take |
| `pool` | none | a client of a shared fetch pool ([Tethys](https://github.com/nickpaustian/tethys)); the pool then owns the connection budget |
| `fetch` | global `fetch` | a fetch-shaped function used for the manifest and every page request, so a host can add headers, sign URLs or route through a proxy |

Occlusion culling holds rather than hides. The depth grid is read back a frame or two late, so on a fast turn it lags the silhouette, and hiding on its word left holes along the edge for a frame or two. Held coarse they are invisible, and the saving that matters, not streaming or drawing the finer levels of hidden areas, is kept. Backface culling always hides, since its cone test is made against the current camera and cannot lag.

## Building a hierarchy

```
theia build source.glb out/dir [--max-tris 124] [--max-verts 64] [--group 4] [--max-group 8] [--target-tris N] [--mesh name|index] [--permissive] [--force]
```

The input is a glTF binary holding the mesh as one indexed primitive with positions and a UV set and no compression extensions; anything else is refused with a message and a non-zero exit. A file with several meshes needs `--mesh` to pick one (the refusal lists them). Normals are used when present and computed from the faces otherwise. The output folder must be empty unless `--force` is given, which replaces its contents, so a rebuild never leaves stale level files behind. `--target-tris` pre-simplifies the input with meshoptimizer, which copes with a few million triangles; above that, decimate in a DCC tool first. Expect to raise Node's heap for large inputs (`node --max-old-space-size=24000` handled 29 million triangles in about two and a half minutes). The output folder holds `manifest.json` and one binary file per level; serve it as static files from a host that honours HTTP `Range` requests and does not compress the binaries. The layout is written down in [formats.md](docs/formats.md).

| flag | default | meaning |
| --- | --- | --- |
| `--max-tris` | 124 | triangles per cluster |
| `--max-verts` | 64 | vertices per cluster |
| `--group` | 4 | clusters merged per group at the finest levels |
| `--max-group` | 8 | ceiling on the group size as it grows at coarse levels. The largest group sets `maxPageVertices` and with it every arena slot |
| `--target-tris` | none | pre-simplify the input to this many triangles before clustering |
| `--mesh` | the only one | which mesh to build when the file has several, by name or index |
| `--permissive` | off | for UV layouts broken into many small islands (photogrammetry): group clusters by position, and once a level carries up more than a quarter of its clusters, simplify every later group across UV seams. Closes the hierarchy at the price of texture stretched across the seams those levels crossed |
| `--force` | off | replace the contents of a non-empty output folder |

The build ends with a table of pages, clusters, triangles and bytes per level. Two details worth knowing: after each level is simplified every vertex normal is recomputed from the level's own faces, area weighted and shared across UV seams and cluster copies, because normals carried through the simplifier as attributes end up pointing away from the faces they sit on and show as dark wedges. Level 0 keeps the source normals unless `--target-tris` pre-simplified it. And the manifest carries a `build` token that the runtime appends to the binary file URLs: the files are byte-range fetched, so a rebuilt hierarchy served from a cache of the old one would arrive short. The manifest itself is fetched with `cache: "no-cache"`.

The simplifier never collapses across a UV seam, so a mesh whose UV layout is thousands of tiny islands, as photogrammetry exports often are, stalls: each island stays nearly rigid, clusters on either side of a seam never count as neighbours, and the levels stop shrinking at the islands' outlines, leaving a coarsest level of millions of triangles. `--permissive` trades texture accuracy at the coarse levels for a hierarchy that closes. The level where it starts crossing seams is printed; levels below it keep their UVs exact. A Smithsonian scan of 10 million triangles in 116 thousand islands stalled at 2.3 million triangles without it and closed to under 3 thousand with it, crossing seams from level 9. The better fix is a new UV layout of large charts, baked from the old texture, before building.

For sources that arrive in an unhelpful frame (an FBX at a thousandth of the intended size, rotated, or far from the origin), `theia normalise` runs Blender headless to bake the importer's transform into the vertices, optionally rescale, and move the origin, writing a glTF binary ready for `theia build`:

```
theia normalise source.fbx source.glb [--reference other.glb] [--size N] [--origin surface|bounds|match|keep] [--blender path]
```

`--size` sets the largest extent; `--reference` matches it to another glTF's mesh instead, and `--origin match` also puts the bounds centre where that reference's is. By default the origin goes to the surface centre of mass, which suits a camera that orbits the object; `bounds` uses the bounding-box centre and `keep` leaves it. Blender is found on the PATH, in the usual install locations, or from `--blender` or the `BLENDER` environment variable. It is the only command that needs it.

The `theia` command runs from the package (`npx theia`, or on the path after a global install). `theia --help` lists the commands.

## Inspecting and previewing a build

```
theia inspect out/dir [--no-scan]
theia preview out/dir [--port 4180] [--no-open] [--error 1.5] [--slots 4096]
```

`inspect` reads the manifest and walks every page from the roots, checking headers against byte ranges, records against their page, errors for monotonicity, cluster ids for uniqueness and the counts against the manifest, then prints a table per level of pages, clusters, triangles and bytes. Unless `--no-scan` is given it also scans each level's geometry for degenerate triangles, inverted normals (a vertex normal against its face), folded triangles (a face normal against its edge neighbours) and, at level 0, open edges. It exits non-zero on any structural issue, which is what a build step or CI should check; the geometry counts are informational, since a few folds per level are normal simplifier output.

`preview` serves the folder with HTTP Range support, alongside this package's build and the three.js installed next to it, and opens a viewer: orbit controls, a stats line, and the runtime knobs on keys (H lists them). It needs the package built (`npm run build` in the package, already done for a published copy).

## Stats and debugging

`mesh.stats` reports what is drawn (clusters, triangles, per level), how much culling removed (frustum, backface, occlusion), pages resident and wanted against the slot count, GPU memory, the current `pixelError` and `detailCap`, the draw and cull modes, index rebuilds, and the network counters (queued, in flight, completed, requests, aborted, failures, bytes).

- `mesh.debugColour = 1` colours by cluster, `2` by level.
- `mesh.frozen = true` stops the cut updating so it can be inspected while moving the camera.

## How it works

1. **Build** (offline). Level 0 is the source mesh cut into meshlets of at most 124 triangles and 64 vertices. For each further level, adjacent clusters are grouped (four at a time to start, more as the hierarchy narrows), the group is merged, simplified to half its triangles with its boundary locked, and cut into new meshlets. Because every group's boundary is locked, neighbouring groups still meet exactly whatever level each is drawn at. A group that cannot simplify is carried up whole and regrouped with more neighbours, so the hierarchy always closes to a few roots. Each cluster records the error of the group that produced it and the error of the group it feeds, both monotonic up the hierarchy, with the spheres those errors apply to. Errors are geometric (a position-only simplification to the same target) and relative to the group. Vertices are duplicated per cluster so every vertex has one owner.
2. **Pages.** A group's member clusters form one page, the unit of streaming: the clusters a group produced all share its error and bounds, so when any of them is too coarse, the whole page beneath is what the renderer needs. Pages are byte ranges inside per-level files and each one is self-describing: a header, one 32-word record per cluster (level, error and bounds, normal cone, index and vertex ranges within the page, the byte range of the page beneath it, a UV centroid and a cluster id), then the vertices and indices. A parent's record is how the page beneath it is found, so nothing is read up front but `manifest.json`, which carries the counts, file list, root pages with their byte ranges and arena sizing. The up-front cost does not grow with the mesh, and one hosted hierarchy can serve several manifests, each choosing its roots and caps.
3. **Cut** (per frame, `update`). The traversal starts at the root pages and skips clusters whose sphere is outside the view frustum or whose normal cone faces away from the camera. It then tests each remaining cluster's own error projected to pixels at the camera's distance from its sphere. A cluster small enough is drawn. One too coarse hands over to the page beneath it if that page is resident, otherwise it is drawn anyway and the page is requested. Because a page is only reached through a parent that failed exactly the test its clusters would pass, every part of the surface is covered once, and adjacent clusters at different levels share locked boundaries, so there are no cracks. Only the clusters along the cut are visited, so the frame cost follows what is drawn, not the size of the hierarchy.
4. **Occlusion.** The current cut is rendered into a small packed-depth target, read back through a pixel pack buffer behind a fence so the frame never waits on the GPU, and reduced to the farthest depth per cell. A sphere is held when its nearest point, pulled toward the camera by `occlusionBias` and by the cluster's own error, is behind every cell its screen rectangle touches; any open cell at a silhouette keeps it refining. Because the grid arrives late, spheres are tested from the viewpoint the grid was rendered at.
5. **Stream.** Pages land in a fixed arena of slots and are evicted least-recently-used once they have been out of the cut for `protectMs`; root pages never are. Requests carry a priority of projected error weighted toward the screen centre, neighbouring pages in the same file are coalesced into one range request, and in-flight requests are aborted once every page in them has gone unwanted past a grace period unless mostly downloaded. Only as many pages as the arena can take are asked for; the rest keep drawing their parents.
6. **Draw.** Every slot owns a fixed region of a CPU-side index array, filled when its page lands, so a change of cut never touches vertex data: the traversal writes the cut as a list of index ranges with adjacent clusters of a page merged, those ranges are copied back to back into a growable index buffer only when the cut changes, and the mesh draws like any other through `drawRange`. Two buffers alternate so an upload never waits on the previous draw.

## Limitations

- WebGL 2 only. One primitive, one material and one UV set per mesh; no skinning or morph targets.
- Errors include the attribute terms from the simplifier, so they are conservative.
- Slots are sized for the largest page while most pages are much smaller, so the arena is over-allocated; a page spanning a run of small fixed slots is the planned fix.
- The occlusion test only sees fine clusters: coarse clusters on the far side have spheres too large to sit behind the front surface, so they are refined until their children can be held. A cluster disoccluded at a silhouette appears a frame or two late.
- A few folded triangles per level can remain from the simplifier.
- `ranges` draw mode relies on private `BatchedMesh` fields and is slower on ANGLE's Metal backend, where multi-draw is a loop of draw calls. It is experimental.
- The hierarchy format may change before 1.0; the manifest's `format` field guards it.

## Development

```
npm ci
npm test            # vitest: the page scheduler against an in-memory host, the builder and inspect on a generated sphere, the runtime loading and refining that build in Node
npm run typecheck
npm run build       # dist/
npm run smoke       # headless Chromium through Playwright: the preview on a generated sphere, no failures, no cracks in a mixed cut, no holes on a camera whip
```

CI runs typecheck, tests and build against three r159, r164 and r169, and the smoke suite once in Chromium, on every push and pull request, and publishes to npm with provenance on a `v*` tag. Blender is not available in CI, so `theia normalise` is exercised by hand.

## Licence

MIT.
