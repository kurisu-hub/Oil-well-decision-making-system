"""
render_pumpjack.py · 从导出的 glb 回读渲染验收图（3 机位）

这是「导出的东西到底对不对」的第二道验证：不渲染建模时的场景，
而是重新 import glb，用导出后的几何 + 材质渲染。

用法：
    blender --background --factory-startup --python render_pumpjack.py -- \
        --glb D:/tools/pa_out/pumpjack_lod0.glb \
        --outdir D:/tools/pa_out/shots --samples 48 --res 1600 1200
"""
import bpy
import json
import math
import os
import sys
from mathutils import Vector

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []

opts = {"glb": None, "outdir": "./shots", "samples": 48, "res": (1600, 1200), "tag": ""}
i = 0
while i < len(argv):
    k = argv[i].lstrip("-")
    if k == "res":
        opts["res"] = (int(argv[i + 1]), int(argv[i + 2]))
        i += 3
        continue
    if k in ("glb", "outdir", "tag"):
        opts[k] = argv[i + 1]
    elif k == "samples":
        opts[k] = int(argv[i + 1])
    i += 2


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def scene_bbox(objs):
    mn = Vector((1e18, 1e18, 1e18))
    mx = Vector((-1e18, -1e18, -1e18))
    for ob in objs:
        mw = ob.matrix_world
        for c in ob.bound_box:
            w = mw @ Vector(c)
            for k in range(3):
                mn[k] = min(mn[k], w[k])
                mx[k] = max(mx[k], w[k])
    return mn, mx


def add_ground(z=0.0, size=120.0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    g = bpy.context.active_object
    g.name = "ground"
    m = bpy.data.materials.new("ground_mat")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.055, 0.053, 0.048, 1.0)
    b.inputs["Roughness"].default_value = 0.94
    b.inputs["Metallic"].default_value = 0.0
    g.data.materials.append(m)
    return g


def add_world():
    """
    天空环境：金属件在 Cycles 里全靠环境反射，纯色世界会把不锈钢渲成塑料。
    用 Nishita 天空给一个真实的天空梯度 + 低角度太阳。
    """
    w = bpy.data.worlds.new("W")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(17.0)
    sky.sun_rotation = math.radians(138.0)
    sky.sun_intensity = 0.32
    sky.altitude = 200.0
    sky.air_density = 1.4
    sky.dust_density = 3.2
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.12


def add_lights():
    # key：低角度暖阳（跟天空太阳方位对齐，避免双影）
    sun_d = bpy.data.lights.new("key", type="SUN")
    sun_d.energy = 2.5
    sun_d.angle = math.radians(1.6)
    sun_d.color = (1.0, 0.88, 0.72)
    sun = bpy.data.objects.new("key", sun_d)
    bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(73), 0, math.radians(132))

    # fill：冷色大面积补光，压暗部不死黑
    fill_d = bpy.data.lights.new("fill", type="AREA")
    fill_d.energy = 420.0
    fill_d.size = 18.0
    fill_d.color = (0.55, 0.70, 1.0)
    fill = bpy.data.objects.new("fill", fill_d)
    bpy.context.scene.collection.objects.link(fill)
    fill.location = (-18, -14, 11)
    fill.rotation_euler = (math.radians(62), 0, math.radians(-52))

    # rim：逆光勾边，把抽油机轮廓从背景里拔出来
    rim_d = bpy.data.lights.new("rim", type="AREA")
    rim_d.energy = 620.0
    rim_d.size = 7.0
    rim_d.color = (1.0, 0.74, 0.48)
    rim = bpy.data.objects.new("rim", rim_d)
    bpy.context.scene.collection.objects.link(rim)
    rim.location = (15, 15, 13)
    rim.rotation_euler = (math.radians(48), 0, math.radians(140))


def add_camera(name, pos, target, lens=50.0):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector(pos)
    d = Vector(target) - Vector(pos)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return cam


def setup_render(res, samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.render.resolution_x = res[0]
    sc.render.resolution_y = res[1]
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = -0.9


def main():
    clear()
    objs = import_glb(opts["glb"])
    mn, mx = scene_bbox(objs)
    size = mx - mn
    center = (mn + mx) * 0.5
    print(f"[render] imported {len(objs)} meshes, bbox={[round(v,4) for v in size]}")

    add_ground(mn.z)
    add_world()
    add_lights()
    setup_render(opts["res"], opts["samples"])

    c = center
    # 机位按包围盒自适应：抽油机 9 m 高、采油树 2.6 m 高、储罐 9 m 直径，同一套机位参数不能通用
    S = max(size.x, size.y, size.z)
    shots = [
        ("01_front", (c.x + S * 1.55, c.y - S * 1.95, c.z + S * 0.55), (c.x, c.y, c.z), 44),
        ("02_drive", (c.x - S * 1.05, c.y - S * 2.30, c.z + S * 0.42), (c.x - S * 0.14, c.y, c.z * 0.96), 46),
        ("03_detail", (c.x + S * 0.95, c.y - S * 0.95, c.z + S * 1.05), (c.x + S * 0.20, c.y, c.z * 1.02), 58),
    ]

    os.makedirs(opts["outdir"], exist_ok=True)
    tag = opts["tag"]
    for name, pos, tgt, lens in shots:
        cam = add_camera(f"cam_{name}", pos, tgt, lens)
        bpy.context.scene.camera = cam
        out = os.path.join(opts["outdir"], f"{tag}{name}.png")
        bpy.context.scene.render.filepath = out
        bpy.ops.render.render(write_still=True)
        print(f"[render] wrote {out}")

    report = {
        "glb": opts["glb"],
        "meshes": len(objs),
        "bbox": [round(v, 4) for v in size],
        "bbox_min": [round(v, 4) for v in mn],
        "bbox_max": [round(v, 4) for v in mx],
        "shots": [s[0] for s in shots],
    }
    print("===== PA_RENDER_REPORT =====")
    print(json.dumps(report, ensure_ascii=False))
    print("===== END =====")


if __name__ == "__main__":
    main()
