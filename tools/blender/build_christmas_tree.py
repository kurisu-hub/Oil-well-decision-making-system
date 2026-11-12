"""
build_christmas_tree.py · 采油树（井口装置）参数化建模

型号：7-1/16" 法兰，350 型（API 6A）
    - 通径 7-1/16" = 179.4 mm
    - 额定工作压力 350 型 = 35 MPa (5,000 psi)
    - 法兰：API 6B 7-1/16" 35MPa，外径约 φ380，8 颗螺栓

包围盒目标：1.2 × 1.0 × 2.6 m（X 翼展 / Y 进深 / Z 高），P11 §2
坐标系：Blender Z-up，米制，底面贴地 Z=0，X/Y 居中

层序（自下而上，这是真实井口装置的装配顺序，不可打乱）：
    底座法兰 → 套管头 → 套管四通 → 油管头 → 下主阀 → 上主阀 → 四通 → 双翼(翼阀+节流) → 树帽+压力表
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import bmesh_kit as K

BBOX_TARGET = (1.20, 1.00, 2.60)

# ---- 轴向关键标高（米）----
Z_BASE_FLANGE = 0.08     # 底座法兰顶
Z_CASING_TOP = 0.42      # 套管头顶
Z_SPOOL_TOP = 0.78       # 套管四通顶
Z_TUBING_TOP = 1.14      # 油管头顶
Z_MV1_TOP = 1.58         # 下主阀顶
Z_MV2_TOP = 2.02         # 上主阀顶
Z_CROSS_TOP = 2.40       # 四通顶
Z_TOP = 2.60             # 树帽顶 = Z 边界

R_BODY = 0.26            # 主体半径（φ0.52）
WING_X = 0.60            # 翼端面 = X 边界（±0.60）
BORE_Y = 0.50            # Y 边界（侧出口法兰外缘）

FLANGE_T = 0.055
BOLT_R = 0.021
_WSEG = 28               # 手轮轮缘段数，由 build() 按 LOD 改写


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    out = {"lod": 0, "out": None, "report": None, "id": "XT-WELD-A-001"}
    i = 0
    while i < len(argv):
        k = argv[i].lstrip("-")
        v = argv[i + 1] if i + 1 < len(argv) else ""
        if k in out:
            out[k] = int(v) if k == "lod" else v
        i += 2
    return out


def mats():
    return {
        "body": K.pbr("XT_body", (0.145, 0.155, 0.168), metallic=0.55, roughness=0.42),
        "flange": K.pbr("XT_flange", (0.190, 0.198, 0.208), metallic=0.70, roughness=0.38),
        "valve": K.pbr("XT_valve", (0.105, 0.115, 0.125), metallic=0.60, roughness=0.45),
        "wheel": K.pbr("XT_wheel", (0.520, 0.130, 0.105), metallic=0.20, roughness=0.52),
        "gauge": K.pbr("XT_gauge", (0.820, 0.820, 0.800), metallic=0.05, roughness=0.30),
        "bolt": K.pbr("XT_bolt", (0.093, 0.100, 0.108), metallic=0.80, roughness=0.35),
    }


def flange(M, objs, name, z, r_out=0.30, seg=32, group="static", bolts=8):
    """
    API 法兰：圆盘 + 一圈螺栓。
    螺栓只朝上露头 —— 首版让螺栓以法兰中面为中心，底座法兰的螺栓直接钻到地面以下 6 mm。
    """
    objs.append(K.cyl(name, (0, 0, z), (0, 0, z + FLANGE_T), r_out, seg, M["flange"], group))
    if bolts:
        bz = z + FLANGE_T * 0.60 + 0.003
        objs += K.bolt_ring(f"{name}_bolt", (0, 0, bz), "Z",
                            radius=r_out - 0.045, bolt_r=BOLT_R, bolt_h=FLANGE_T + 0.010,
                            count=bolts, mat=M["bolt"], group=group)


def handwheel(M, objs, name, center, axis, r=0.13, group="wheel", seg=None):
    """
    阀门手轮：轮缘 + 3 根辐条 + 轮毂。
    段数必须随 LOD 降 —— 首版固定 28 段，一台采油树挂 8 个手轮，
    LOD2 光轮缘就占了 3000+ 三角，LOD 等于没做。
    """
    c = Vector(center)
    seg = max(6, seg if seg is not None else _WSEG)
    if axis == "Y":
        a0, a1 = c - Vector((0, 0.012, 0)), c + Vector((0, 0.012, 0))
        ring = [(r * math.cos(t), 0.0, r * math.sin(t)) for t in [i * math.tau / seg for i in range(seg)]]
    elif axis == "X":
        a0, a1 = c - Vector((0.012, 0, 0)), c + Vector((0.012, 0, 0))
        ring = [(0.0, r * math.cos(t), r * math.sin(t)) for t in [i * math.tau / seg for i in range(seg)]]
    else:
        a0, a1 = c - Vector((0, 0, 0.012)), c + Vector((0, 0, 0.012))
        ring = [(r * math.cos(t), r * math.sin(t), 0.0) for t in [i * math.tau / seg for i in range(seg)]]
    objs.append(K.cyl(f"{name}_hub", a0, a1, 0.026, 12, M["valve"], group))
    # 轮缘：小段圆柱首尾相连
    for i in range(len(ring)):
        p0 = c + Vector(ring[i])
        p1 = c + Vector(ring[(i + 1) % len(ring)])
        objs.append(K.cyl(f"{name}_rim{i:02d}", p0, p1, 0.011, 6, M["wheel"], group))
    # 辐条
    for k in range(3):
        t = k * math.tau / 3
        if axis == "Y":
            p1 = c + Vector((r * 0.94 * math.cos(t), 0.0, r * 0.94 * math.sin(t)))
        elif axis == "X":
            p1 = c + Vector((0.0, r * 0.94 * math.cos(t), r * 0.94 * math.sin(t)))
        else:
            p1 = c + Vector((r * 0.94 * math.cos(t), r * 0.94 * math.sin(t), 0.0))
        objs.append(K.cyl(f"{name}_spoke{k}", c, p1, 0.009, 5, M["wheel"], group))


def gate_valve(M, objs, name, z0, z1, lod, wheel_side="Y", wheel_r=0.13):
    """闸阀：阀体（略方的箱体）+ 上阀盖 + 阀杆 + 手轮。"""
    h = z1 - z0
    objs.append(K.box(f"{name}_body", (0, 0, (z0 + z1) * 0.5), (0.42, 0.30, h * 0.62),
                      M["valve"], group="static"))
    # 上下法兰
    flange(M, objs, f"{name}_fl", z0 - 0.005, r_out=0.29, bolts=8)
    # 阀盖
    objs.append(K.cyl(f"{name}_bonnet", (0, 0, (z0 + z1) * 0.5 + h * 0.31),
                      (0, 0, z1 - 0.03), 0.10, 20, M["valve"], group="static"))
    # 阀杆
    if wheel_side == "Y":
        objs.append(K.cyl(f"{name}_stem", (0, 0, z1 - 0.05), (0, -0.30, z1 - 0.02),
                          0.022, 10, M["body"], group="static"))
        handwheel(M, objs, f"{name}_wh", (0, -0.32, z1 - 0.02), "Y", wheel_r)
    else:
        objs.append(K.cyl(f"{name}_stem", (0, 0, z1 - 0.05), (0.30, 0, z1 - 0.02),
                          0.022, 10, M["body"], group="static"))
        handwheel(M, objs, f"{name}_wh", (0.32, 0, z1 - 0.02), "X", wheel_r)


def wing(M, objs, name, z, side, lod, choke=False):
    """
    翼：从四通沿 ±X 伸出。装配顺序：短节 → 翼阀 →（节流阀）→ 盲法兰。
    X 方向严格排布，末端正好落在 ±WING_X：
        四通边 ±0.18 | 短节 →0.30 | 翼阀 0.30–0.46 | 节流阀 0.46–0.58 | 盲法兰 0.58–0.60
    注意所有偏移都乘 sgn —— 首版写死 `x1 - 0.16`，左翼变成朝外延伸，手轮被顶到 −0.89。
    """
    sgn = 1.0 if side == "r" else -1.0

    def X(v):
        return sgn * v

    # 短节
    objs.append(K.cyl(f"{name}_nipple", (X(0.18), 0, z), (X(0.30), 0, z), 0.062, 16,
                      M["body"], group="static"))
    # 翼阀体
    objs.append(K.box(f"{name}_valve", (X(0.38), 0, z), (0.16, 0.20, 0.20),
                      M["valve"], group="static"))
    objs.append(K.cyl(f"{name}_bonnet", (X(0.38), 0, z + 0.10), (X(0.38), 0, z + 0.17),
                      0.045, 12, M["valve"], group="static"))
    handwheel(M, objs, f"{name}_wh", (X(0.38), 0, z + 0.19), "Z", 0.10)

    if choke:
        # 节流阀（可调，带刻度手轮）
        objs.append(K.box(f"{name}_choke", (X(0.52), 0, z), (0.12, 0.17, 0.17),
                          M["valve"], group="static"))
        objs.append(K.cyl(f"{name}_choke_stem", (X(0.52), 0, z + 0.08),
                          (X(0.52), 0, z + 0.15), 0.020, 8, M["body"], group="static"))
        handwheel(M, objs, f"{name}_choke_wh", (X(0.515), 0, z + 0.16), "Z", 0.068)

    # 端部盲法兰（0.58–0.60，末端即 X 边界）
    objs.append(K.cyl(f"{name}_blind", (X(0.58), 0, z), (X(0.60), 0, z), 0.085, 16,
                      M["flange"], group="static"))


def build(M, objs, lod):
    global _WSEG
    _WSEG = 28 if lod == 0 else (12 if lod == 1 else 7)
    seg = 32 if lod == 0 else (20 if lod == 1 else 10)

    # ---------- 1. 底座法兰（坐在井口套管头上） ----------
    flange(M, objs, "ct_base_fl", 0.0, r_out=0.30, seg=seg, bolts=8 if lod == 0 else 0)
    objs.append(K.cyl("ct_base_neck", (0, 0, 0.0), (0, 0, Z_BASE_FLANGE), 0.24, seg,
                      M["body"], group="static"))

    # ---------- 2. 套管头 ----------
    objs.append(K.cyl("ct_casing", (0, 0, Z_BASE_FLANGE), (0, 0, Z_CASING_TOP), R_BODY, seg,
                      M["body"], group="static"))
    # 套管头两侧出口（φ0.15 短管 + 法兰），Y 边界由它的法兰外缘决定
    for side, sgn in (("l", -1.0), ("r", 1.0)):
        objs.append(K.cyl(f"ct_casing_outlet_{side}", (0, sgn * 0.18, 0.22),
                          (0, sgn * (BORE_Y - FLANGE_T), 0.22), 0.065, 14,
                          M["body"], group="static"))
        objs.append(K.cyl(f"ct_casing_outlet_fl_{side}", (0, sgn * (BORE_Y - FLANGE_T), 0.22),
                          (0, sgn * BORE_Y, 0.22), 0.105, 18, M["flange"], group="static"))
        if lod == 0:
            objs += K.bolt_ring(f"ct_co_bolt_{side}", (0, sgn * (BORE_Y - FLANGE_T * 0.5), 0.22), "Y",
                                radius=0.072, bolt_r=0.013, bolt_h=FLANGE_T - 0.006, count=6,
                                mat=M["bolt"], group="static")

    # ---------- 3. 套管四通 ----------
    flange(M, objs, "ct_spool_fl", Z_CASING_TOP, r_out=0.29, seg=seg, bolts=8 if lod == 0 else 0)
    objs.append(K.cyl("ct_spool", (0, 0, Z_CASING_TOP + FLANGE_T), (0, 0, Z_SPOOL_TOP),
                      0.235, seg, M["body"], group="static"))

    # ---------- 4. 油管头 ----------
    flange(M, objs, "ct_tbg_fl", Z_SPOOL_TOP, r_out=0.28, seg=seg, bolts=8 if lod == 0 else 0)
    objs.append(K.cyl("ct_tubing", (0, 0, Z_SPOOL_TOP + FLANGE_T), (0, 0, Z_TUBING_TOP),
                      0.225, seg, M["body"], group="static"))
    # 油管头挂环 + 侧阀（手轮外缘必须留在 ±BORE_Y 内）
    for side, sgn in (("l", -1.0), ("r", 1.0)):
        objs.append(K.cyl(f"ct_th_side_{side}", (0, sgn * 0.16, 0.96), (0, sgn * 0.34, 0.96),
                          0.048, 12, M["body"], group="static"))
        objs.append(K.box(f"ct_th_valve_{side}", (0, sgn * 0.38, 0.96), (0.16, 0.10, 0.16),
                          M["valve"], group="static"))
        handwheel(M, objs, f"ct_th_wh_{side}", (0, sgn * 0.46, 0.96), "Y", 0.072)

    # ---------- 5. 下主阀 / 上主阀 ----------
    gate_valve(M, objs, "ct_mv1", Z_TUBING_TOP, Z_MV1_TOP, lod, "Y", 0.14)
    gate_valve(M, objs, "ct_mv2", Z_MV1_TOP, Z_MV2_TOP, lod, "Y", 0.14)

    # ---------- 6. 四通 ----------
    flange(M, objs, "ct_cross_fl", Z_MV2_TOP, r_out=0.27, seg=seg, bolts=8 if lod == 0 else 0)
    objs.append(K.box("ct_cross", (0, 0, (Z_MV2_TOP + FLANGE_T + Z_CROSS_TOP) * 0.5),
                      (0.40, 0.34, Z_CROSS_TOP - Z_MV2_TOP - FLANGE_T),
                      M["body"], group="static"))

    # ---------- 7. 双翼：左翼带节流阀 ----------
    zw = (Z_MV2_TOP + FLANGE_T + Z_CROSS_TOP) * 0.5
    wing(M, objs, "ct_wing_l", zw, "l", lod, choke=True)
    wing(M, objs, "ct_wing_r", zw, "r", lod, choke=False)

    # ---------- 8. 树帽 + 压力表 ----------
    objs.append(K.cyl("ct_top_nipple", (0, 0, Z_CROSS_TOP), (0, 0, Z_TOP - 0.09), 0.075, 16,
                      M["body"], group="static"))
    objs.append(K.cyl("ct_cap", (0, 0, Z_TOP - 0.09), (0, 0, Z_TOP), 0.115, 20,
                      M["flange"], group="static"))
    # 压力表（表盘朝 +Y）
    objs.append(K.cyl("ct_gauge_stem", (0, 0.05, 2.28), (0, 0.14, 2.30), 0.016, 8,
                      M["body"], group="static"))
    objs.append(K.cyl("ct_gauge_body", (0, 0.14, 2.30), (0, 0.185, 2.30), 0.062, 20,
                      M["gauge"], group="static"))
    objs.append(K.cyl("ct_gauge_ring", (0, 0.185, 2.30), (0, 0.20, 2.30), 0.068, 20,
                      M["flange"], group="static"))
    # 表阀手轮
    handwheel(M, objs, "ct_gauge_wh", (0, 0.10, 2.36), "Z", 0.045)

    # ---------- 9. 铭牌 ----------
    if lod == 0:
        objs.append(K.box("ct_nameplate", (0.20, -0.10, 0.62), (0.008, 0.13, 0.09),
                          M["gauge"], group="static"))


def join_by_group(objs, groups):
    name_group = {o.name: o.get("pa_group") for o in objs if o.name in bpy.data.objects}
    out = {}
    for g in groups:
        names = [n for n, gg in name_group.items() if gg == g]
        members = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
        if not members:
            continue
        if len(members) == 1:
            members[0].name = f"ct_{g}"
            members[0]["pa_group"] = g
            out[g] = members[0]
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = f"ct_{g}"
        merged["pa_group"] = g
        out[g] = merged
    return out


def main():
    a = parse_args()
    lod = a["lod"]
    out = a["out"] or f"christmas_tree_lod{lod}.glb"

    K.reset_scene()
    M = mats()
    objs = []
    build(M, objs, lod)

    mn, mx = K.world_bbox(objs)
    design = tuple(mx[i] - mn[i] for i in range(3))

    # 越界定位：找出把 X / Y 撑开的构件（别靠脑补算哪块伸出去）
    rows = []
    for ob in objs:
        bmn, bmx = K.world_bbox([ob])
        rows.append((ob.name, bmx[0], bmn[0], bmx[1], bmn[1]))
    rows.sort(key=lambda r: -max(abs(r[1]), abs(r[2])))
    print("[x-edge top6]", [(n, round(a, 3), round(b, 3)) for n, a, b, _, _ in rows[:6]])
    rows.sort(key=lambda r: -max(abs(r[3]), abs(r[4])))
    print("[y-edge top6]", [(n, round(a, 3), round(b, 3)) for n, _, _, a, b in rows[:6]])
    zrows = []
    for ob in objs:
        bmn, bmx = K.world_bbox([ob])
        zrows.append((ob.name, bmx[2], bmn[2]))
    zrows.sort(key=lambda r: -r[1])
    print("[z-top6]", [(n, round(a, 4)) for n, a, _ in zrows[:6]])
    zrows.sort(key=lambda r: r[2])
    print("[z-bot4]", [(n, round(b, 4)) for n, _, b in zrows[:4]])

    sx = BBOX_TARGET[0] / design[0]
    sy = BBOX_TARGET[1] / design[1]
    sz = BBOX_TARGET[2] / design[2]
    K.apply_offset_and_scale(
        objs, (sx, sy, sz),
        (-(mn[0] * sx + mx[0] * sx) * 0.5, -(mn[1] * sy + mx[1] * sy) * 0.5, -mn[2] * sz))

    mn2, mx2 = K.world_bbox(objs)
    final = [round(mx2[i] - mn2[i], 5) for i in range(3)]

    joined = join_by_group(objs, ["static", "wheel"])
    for g, ob in joined.items():
        ob["pa_id"] = a["id"] + ("" if g == "static" else f":{g}")
        ob["pa_type"] = "christmas_tree"
        ob["pa_spec"] = '7-1/16" 350'
        ob["pa_group"] = g

    tr, vt, ms = K.mesh_stats(list(joined.values()))

    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(out):
        try:
            os.remove(out)
        except OSError:
            pass
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False,
                              export_apply=True, export_extras=True, export_yup=True,
                              export_cameras=False, export_lights=False)

    errs = [abs(final[i] - BBOX_TARGET[i]) / BBOX_TARGET[i] * 100 for i in range(3)]
    rep = {
        "asset": "christmas_tree", "spec": '7-1/16" 350', "lod": lod, "id": a["id"],
        "bbox_target_m": list(BBOX_TARGET),
        "bbox_design_m": [round(v, 4) for v in design],
        "bbox_final_m": final,
        "bbox_min_m": [round(v, 5) for v in mn2],
        "bbox_max_m": [round(v, 5) for v in mx2],
        "calibration_scale": [round(sx, 6), round(sy, 6), round(sz, 6)],
        "error_pct": [round(e, 4) for e in errs],
        "triangles": tr, "vertices": vt, "materials": sorted(ms),
        "groups": sorted(joined.keys()),
        "file": out, "file_bytes": os.path.getsize(out) if os.path.exists(out) else 0,
    }
    txt = json.dumps(rep, ensure_ascii=False, indent=2)
    print("\n===== PA_REPORT_BEGIN =====")
    print(txt)
    print("===== PA_REPORT_END =====\n")
    if a["report"]:
        os.makedirs(os.path.dirname(a["report"]), exist_ok=True)
        with open(a["report"], "w", encoding="utf-8") as f:
            f.write(txt)


if __name__ == "__main__":
    main()
