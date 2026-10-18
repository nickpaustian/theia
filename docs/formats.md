# Theia hierarchy format

The layouts the build tools write and the runtimes read. The hierarchy carries a version field that the loader checks, and it may change before 1.0.

All multi-byte values are little-endian. "Word" means a 32-bit unsigned integer unless marked `f32`.

## Format 3

Format 2 with the geometry packed: each vertex is quantised to 20 bytes and the vertices and indices of a page go through [meshoptimizer](https://github.com/zeux/meshoptimizer)'s vertex and index codecs. On scans this is three to four times smaller than format 2 (a 10 KB page becomes 2.5 to 3 KB), and the records, unchanged, become about a fifth of a page. Everything else (manifest, roots, records, byte ranges) is as in format 2; the runtimes read both.

### manifest.json

As format 2, with `format` 3 and:

| field | meaning |
| --- | --- |
| `floatsPerVertex` | 8, the *decoded* vertex layout |
| `vertexBytes` | 20, bytes per packed vertex before the codec |
| `maxClusterVertices` | the largest cluster's vertex count (64 with the default `--max-verts`); a runtime that gives every cluster its own block of this size holds pages without waste at the finest level |
| `quantisation` | `{ origin: [x, y, z], step, positionBits }`: a position is `origin + q × step` for an integer `q` of `positionBits` bits. One grid for the whole hierarchy, so a vertex shared by two pages or two levels quantises to the same point and the cut stays crack-free. `theia build --position-bits` sets the bits (default 20: a step under a micron on a metre-sized object) |

### Level files

| part | size | content |
| --- | --- | --- |
| header | 6 words | page id, cluster count `C`, vertex count `V`, index count `I`, encoded vertex bytes `VB`, encoded index bytes `IB` |
| records | `C` × 32 words | as format 2 |
| vertices | `VB` bytes, padded to a word | `V` packed vertices through `meshopt_encodeVertexBuffer` with a 20-byte stride |
| indices | `IB` bytes, padded to a word | `I` uint16 indices through `meshopt_encodeIndexBuffer` (the codec may rotate a triangle's vertices; winding is kept) |

A page's byte length is `(6 + 32C) × 4 + pad4(VB) + pad4(IB)`.

### Packed vertex (20 bytes)

| bytes | type | meaning |
| --- | --- | --- |
| 0–11 | 3 × u32 | position on the grid: `q` per axis |
| 12–15 | 2 × i16 | normal, octahedral: `(u, v)` in snorm16, the lower hemisphere folded over the upper one's edge; decode `z = 1 − |u| − |v|`, if `z < 0` then `(u, v) ← ((1 − |v|)·sign u, (1 − |u|)·sign v)`, then normalise. Zero takes the positive sign |
| 16–19 | 2 × u16 | UV in unorm16; UVs are clamped to [0, 1] at build (the build warns how many were) |

A decoded vertex is within half a grid step of the source position, within about 0.01° in normal and within 1/131070 in UV.

## Format 2

A folder holding `manifest.json` and one binary file per level. Nothing is read up front but the manifest; everything else is reached by following byte ranges from the root pages.

### manifest.json

| field | meaning |
| --- | --- |
| `format` | 2 |
| `name` | the source mesh's name |
| `build` | per-build token; the runtime appends it to each level file URL as `?v=<build>` |
| `recordWords` | words per cluster record, 32 |
| `floatsPerVertex` | 8 |
| `clusterCount`, `pageCount`, `triangles` | totals; `triangles` is the level-0 count |
| `levels[]` | `{ file, byteLength }` per level, index = level number |
| `roots[]` | `{ id, level, offset, length }` of each root page |
| `maxPageVertices`, `maxPageIndices`, `maxPageClusters` | the largest page, which sizes every arena slot |
| `bounds` | `[cx, cy, cz, radius]` of the whole mesh |

### Level files

Pages back to back. A page is self-describing: once its bytes are in hand, every cluster in it and the location of every page beneath it are known.

| part | size | content |
| --- | --- | --- |
| header | 4 words | page id, cluster count `C`, vertex count `V`, index count `I` |
| records | `C` × 32 words | one record per cluster (below) |
| vertices | `V` × 8 `f32` | `px py pz nx ny nz u v`, duplicated per cluster so each vertex has one owner |
| indices | `I` words | triangle list, indices into this page's vertices |

A page's byte length is therefore `(4 + 32C + 8V + I) × 4`. A cluster's indices all fall inside its own vertex range.

### Cluster record (32 words)

| word | type | meaning |
| --- | --- | --- |
| 0 | u32 | level |
| 1 | u32 | page id (this page) |
| 2 | u32 | child page id, or `0xFFFFFFFF` at level 0 |
| 3, 4 | u32 | index offset and count within the page |
| 5, 6 | u32 | vertex offset and count within the page |
| 7 | f32 | self error: the simplification error of the group that produced this cluster |
| 8–11 | f32 | self bounds `cx cy cz r`, the sphere the self error applies to |
| 12 | f32 | parent error: the error of the group this cluster feeds (`3e38` for a root) |
| 13–16 | f32 | parent bounds `cx cy cz r` |
| 17–23 | f32 | normal cone: apex `xyz`, axis `xyz`, cutoff. The cluster is wholly back-facing when `dot(normalize(apex − eye), axis) ≥ cutoff` |
| 24–26 | u32 | child page: level, byte offset within that level's file, byte length |
| 27, 28 | f32 | UV centroid, for per-cluster lookups into a texture-space map |
| 29 | u32 | cluster id, unique across the hierarchy |
| 30, 31 | | reserved, zero |

Errors are monotone: a cluster's parent error is at least its self error, and a child page's clusters carry a parent error equal to this cluster's self error. The runtime draws a cluster when its self error projects below the pixel threshold and descends to the child page otherwise.

The sibling Atlas tile format is documented in [the Atlas repository](https://github.com/nickpaustian/atlas/blob/main/docs/formats.md).
