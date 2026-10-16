# Converts an FBX or glTF mesh to a glTF binary ready for `theia build`: the importer's object
# transform baked into the vertices, an optional uniform rescale, and the origin moved to a
# chosen point. Run by `theia normalise`, or directly:
#
#   blender -b --factory-startup --python normalise-mesh.py -- <input.fbx|glb> <output.glb> [--reference ref.glb] [--size N] [--origin surface|bounds|match|keep]
#
# --reference matches the largest extent to that file's mesh (and, with --origin match, its
# bounds centre); --size sets the largest extent directly. The origin goes to the surface
# centre of mass by default, the bounds centre with "bounds", or stays put with "keep".
import bpy, sys
from mathutils import Vector, Matrix

params = sys.argv[sys.argv.index("--") + 1:]
def option(name, fallback=None):
    flag = "--" + name
    return params[params.index(flag) + 1] if flag in params else fallback
positional = [p for i, p in enumerate(params) if not p.startswith("--") and (i == 0 or not params[i - 1].startswith("--"))]
src, dst = positional[:2]
ref = option("reference")
size_target = float(option("size")) if option("size") else None
mode = option("origin", "surface")
if mode not in ("surface", "bounds", "match", "keep"):
    sys.exit(f"normalise: unknown origin mode {mode}")
if mode == "match" and not ref:
    sys.exit("normalise: --origin match needs --reference")

def bounds(o):
    # From the vertices, not bound_box, which stays stale after mesh.transform()
    mn = Vector((float("inf"),) * 3)
    mx = Vector((float("-inf"),) * 3)
    for v in o.data.vertices:
        c = o.matrix_world @ v.co
        for i in range(3):
            if c[i] < mn[i]: mn[i] = c[i]
            if c[i] > mx[i]: mx[i] = c[i]
    return mn, mx
def mesh_object():
    return next(o for o in bpy.data.objects if o.type == "MESH")
def surface_centre_of_mass(o):
    total = 0.0
    com = Vector((0, 0, 0))
    for p in o.data.polygons:
        total += p.area
        com += (o.matrix_world @ p.center) * p.area
    return com / total
def fmt(v):
    return [round(x, 4) for x in v]

ref_size = ref_centre = None
if ref:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=ref)
    ref_min, ref_max = bounds(mesh_object())
    ref_size = ref_max - ref_min
    ref_centre = (ref_min + ref_max) / 2
    print("reference", ref.split("/")[-1], "size", fmt(ref_size), "bounds centre", fmt(ref_centre), flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
if src.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=src, bake_space_transform=True)
else:
    bpy.ops.import_scene.gltf(filepath=src)
obj = mesh_object()
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
# Bake whatever transform the importer left on the object, then do every further move on the
# mesh data itself: object-level applies on multi-million-face meshes were leaving residuals
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh = obj.data
mn, mx = bounds(obj)
size = mx - mn
target = size_target if size_target else (max(ref_size) if ref_size else None)
scale = target / max(size) if target else 1.0
print("input", src.split("/")[-1], len(mesh.polygons), "faces, size", fmt(size), "-> scale", round(scale, 6), flush=True)
if scale != 1.0:
    mesh.transform(Matrix.Scale(scale, 4))
    mesh.update()
mn, mx = bounds(obj)
if mode == "match":
    mesh.transform(Matrix.Translation(ref_centre - (mn + mx) / 2))
elif mode == "bounds":
    mesh.transform(Matrix.Translation(-(mn + mx) / 2))
elif mode == "surface":
    for _ in range(3):
        com = surface_centre_of_mass(obj)
        mesh.transform(Matrix.Translation(-com))
        mesh.update()
        if com.length < 1e-4:
            break
mesh.update()
mn, mx = bounds(obj)
print("result size", fmt(mx - mn), "bounds centre", fmt((mn + mx) / 2), "surface centre of mass", fmt(surface_centre_of_mass(obj)), "| origin", mode, flush=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True, export_materials="NONE", export_normals=True, export_texcoords=True, export_yup=True, export_animations=False, export_skins=False, export_morph=False)
print("exported", dst, flush=True)
