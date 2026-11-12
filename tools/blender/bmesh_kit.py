"""
bmesh_kit.py · 参数化建模基础库（headless bpy）

设计原则：
1. 全部用 bmesh 直接构造顶点，不用 bpy.ops.mesh.primitive_*（headless 下 ops 上下文不稳，
   且 ops 创建的 object.dimensions 在导出时不一定烘焙 —— P11 §5 记的"导出 1×1×1"就是这个坑）。
2. 所有函数接收"世界坐标下的尺寸/端点"，内部把变换烘进顶点，object 的 matrix_world 恒为单位阵。
3. 单位：米；轴向：Blender Z-up（X 长 / Y 宽 / Z 高）。
"""
import bpy
import bmesh
import math
from mathutils import Vector, Matrix, Euler

TAU = math.pi * 2


# ---------------------------------------------------------------- 场景

def reset_scene():
    """清空场景（含孤儿数据），保证每次重建结果一致。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(coll):
            try:
                coll.remove(item)
            except Exception:
                pass


def collection(name="PA"):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(col)
    return col


# ---------------------------------------------------------------- 材质

def pbr(name, color, metallic=0.8, roughness=0.55, emission=None, alpha=None):
    """标准 PBR 材质。color 为 sRGB 0-1 三元组。
    alpha 给定时导出 glTF alphaMode=BLEND（如罐内液位柱，需从罐外看见液面）。"""
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if out:
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 1.2
    if alpha is not None:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
    return m


# ---------------------------------------------------------------- 基本体

def _finish(name, bm, mat, group=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.validate(verbose=False)
    if smooth:
        # 回转体必须开平滑：否则 96 段圆柱每段一个独立法线，
        # 渲染出来是竖条纹（储罐首版就是这样，看着像"有条纹的桶"）。
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    collection().objects.link(ob)
    if mat is not None:
        ob.data.materials.append(mat)
    ob["pa_group"] = group or "static"
    return ob


def box(name, center, size, mat=None, rot=(0.0, 0.0, 0.0), group="static"):
    """轴对齐（或绕 XYZ 旋转）矩形体。center/size 为世界坐标米。"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if any(abs(a) > 1e-9 for a in rot):
        R = Euler((rot[0], rot[1], rot[2]), "XYZ").to_matrix()
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=R, verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return _finish(name, bm, mat, group)


def beam(name, p0, p1, w, h, mat=None, group="static", up=None):
    """
    沿 p0→p1 的矩形梁。w = 截面在"局部 X"的宽度，h = 截面在"局部 Y"的高度。
    自动解算朝向：默认让局部 Y 尽量贴近世界 +Z（型钢立起来）。
    """
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = p1 - p0
    L = d.length
    if L < 1e-9:
        raise ValueError(f"{name}: 零长度")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(w, h, L), verts=bm.verts)

    zdir = d.normalized()
    ref = Vector(up) if up else Vector((0.0, 0.0, 1.0))
    if abs(zdir.dot(ref)) > 0.985:
        ref = Vector((1.0, 0.0, 0.0))
    xdir = ref.cross(zdir).normalized()
    ydir = zdir.cross(xdir).normalized()
    R = Matrix((
        (xdir.x, ydir.x, zdir.x),
        (xdir.y, ydir.y, zdir.y),
        (xdir.z, ydir.z, zdir.z),
    ))
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=R, verts=bm.verts)
    bmesh.ops.translate(bm, vec=(p0 + p1) * 0.5, verts=bm.verts)
    return _finish(name, bm, mat, group)


def cyl(name, p0, p1, r, seg=24, mat=None, group="static", cap=True, r2=None):
    """沿 p0→p1 的圆柱 / 圆台。"""
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = p1 - p0
    L = d.length
    if L < 1e-9:
        raise ValueError(f"{name}: 零长度")
    bm = bmesh.new()
    r2 = r if r2 is None else r2
    try:
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg,
                              radius1=r, radius2=r2, depth=L)
    except TypeError:
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=seg,
                              diameter1=r * 2, diameter2=r2 * 2, depth=L)
    q = Vector((0.0, 0.0, 1.0)).rotation_difference(d.normalized())
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=q.to_matrix(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(p0 + p1) * 0.5, verts=bm.verts)
    return _finish(name, bm, mat, group, smooth=True)


def arc_band(name, center, r_out, r_in, a0, a1, width, segs=48, mat=None, group="static"):
    """
    XZ 平面内的一段环形带（扇环），沿 Y 方向挤出 width。
    角 a 从 +X 轴逆时针（朝 +Z 为正）。用于抽油机驴头弧面。
    """
    bm = bmesh.new()
    cx, cy, cz = center
    y0, y1 = cy - width * 0.5, cy + width * 0.5
    outer_top, outer_bot, inner_top, inner_bot = [], [], [], []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * (i / segs)
        ca, sa = math.cos(a), math.sin(a)
        outer_top.append(bm.verts.new((cx + r_out * ca, y0, cz + r_out * sa)))
        outer_bot.append(bm.verts.new((cx + r_out * ca, y1, cz + r_out * sa)))
        inner_top.append(bm.verts.new((cx + r_in * ca, y0, cz + r_in * sa)))
        inner_bot.append(bm.verts.new((cx + r_in * ca, y1, cz + r_in * sa)))
    for i in range(segs):
        # 外弧面
        bm.faces.new((outer_top[i], outer_top[i + 1], outer_bot[i + 1], outer_bot[i]))
        # 内弧面（反序保证法线朝内）
        bm.faces.new((inner_bot[i], inner_bot[i + 1], inner_top[i + 1], inner_top[i]))
        # 两侧端面（Y 向侧面）
        bm.faces.new((outer_top[i], inner_top[i], inner_top[i + 1], outer_top[i + 1]))
        bm.faces.new((outer_bot[i + 1], inner_bot[i + 1], inner_bot[i], outer_bot[i]))
    # 首尾封口
    bm.faces.new((outer_top[0], outer_bot[0], inner_bot[0], inner_top[0]))
    bm.faces.new((inner_top[-1], inner_bot[-1], outer_bot[-1], outer_top[-1]))
    bm.normal_update()
    return _finish(name, bm, mat, group, smooth=True)


def hex_prism(name, center, r, h, mat=None, axis="Z", group="static", rot_z=0.0):
    """六角螺栓头（6 段柱）。axis 指定轴向。"""
    c = Vector(center)
    if axis == "Z":
        return cyl(name, c - Vector((0, 0, h / 2)), c + Vector((0, 0, h / 2)), r, 6, mat, group)
    if axis == "Y":
        return cyl(name, c - Vector((0, h / 2, 0)), c + Vector((0, h / 2, 0)), r, 6, mat, group)
    return cyl(name, c - Vector((h / 2, 0, 0)), c + Vector((h / 2, 0, 0)), r, 6, mat, group)


def bolt_ring(prefix, center, axis, radius, bolt_r, bolt_h, count, mat, group="static"):
    """在垂直于 axis 的圆周上排一圈螺栓。"""
    out = []
    c = Vector(center)
    for i in range(count):
        a = TAU * i / count
        if axis == "Y":
            off = Vector((radius * math.cos(a), 0.0, radius * math.sin(a)))
        elif axis == "Z":
            off = Vector((radius * math.cos(a), radius * math.sin(a), 0.0))
        else:
            off = Vector((0.0, radius * math.cos(a), radius * math.sin(a)))
        out.append(hex_prism(f"{prefix}_b{i:02d}", c + off, bolt_r, bolt_h, mat, axis, group))
    return out


def i_beam(name, p0, p1, width, height, web_t, flange_t, mat=None, group="static", up=None):
    """工字钢：上下翼缘 + 腹板，三块 box 沿梁轴拼。"""
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = (p1 - p0)
    L = d.length
    zdir = d.normalized()
    ref = Vector(up) if up else Vector((0.0, 0.0, 1.0))
    if abs(zdir.dot(ref)) > 0.985:
        ref = Vector((1.0, 0.0, 0.0))
    xdir = ref.cross(zdir).normalized()
    ydir = zdir.cross(xdir).normalized()
    mid = (p0 + p1) * 0.5
    parts = []
    offs = [
        ("flange_a", ydir * (height * 0.5 - flange_t * 0.5), (width, flange_t, L)),
        ("flange_b", ydir * (-height * 0.5 + flange_t * 0.5), (width, flange_t, L)),
        ("web", Vector((0, 0, 0)), (web_t, height - 2 * flange_t, L)),
    ]
    for tag, off, (sx, sy, sz) in offs:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
        R = Matrix((
            (xdir.x, ydir.x, zdir.x),
            (xdir.y, ydir.y, zdir.y),
            (xdir.z, ydir.z, zdir.z),
        ))
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=R, verts=bm.verts)
        bmesh.ops.translate(bm, vec=mid + off, verts=bm.verts)
        parts.append(_finish(f"{name}_{tag}", bm, mat, group))
    return parts


# ---------------------------------------------------------------- 统计

def mesh_stats(objs):
    """返回 (三角数, 顶点数, 材质名集合)。"""
    tris = 0
    verts = 0
    mats = set()
    for ob in objs:
        if ob.type != "MESH":
            continue
        me = ob.data
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        verts += len(me.vertices)
        for m in me.materials:
            if m:
                mats.add(m.name)
    return tris, verts, mats


def world_bbox(objs):
    """遍历顶点算精确世界包围盒（不用 bound_box 的 8 角，避免旋转体保守估计）。"""
    mn = [1e18, 1e18, 1e18]
    mx = [-1e18, -1e18, -1e18]
    for ob in objs:
        if ob.type != "MESH":
            continue
        mw = ob.matrix_world
        for v in ob.data.vertices:
            w = mw @ v.co
            for i in range(3):
                if w[i] < mn[i]:
                    mn[i] = w[i]
                if w[i] > mx[i]:
                    mx[i] = w[i]
    return mn, mx


def apply_offset_and_scale(objs, scale, offset):
    """
    把整体变换烘到顶点里（headless 导出必须，否则 glb 里 transform 未应用）。
    scale: 三轴各自缩放；offset: 平移。
    """
    for ob in objs:
        if ob.type != "MESH":
            continue
        me = ob.data
        for v in me.vertices:
            v.co = Vector((
                v.co.x * scale[0] + offset[0],
                v.co.y * scale[1] + offset[1],
                v.co.z * scale[2] + offset[2],
            ))
        me.update()
    return objs
