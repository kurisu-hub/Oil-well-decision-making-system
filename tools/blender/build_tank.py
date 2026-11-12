"""
build_tank.py · 拱顶储罐参数化建模

规格：500 m³，Φ9.0 × H9.0（P11 §2）
    容积核算：π × 4.5² × 7.86 = 500.0 m³（直筒段），加拱顶（矢高 1.14）总高 9.00 m
    拱顶曲率半径：R = (r² + h²) / (2h) = (4.5² + 1.14²) / (2 × 1.14) = 9.45 m

包围盒目标：9.0 × 9.0 × 9.0（Φ × Φ × H），底面贴地，XY 居中

**包围盒取舍（重要）**：实物 500 m³ 拱顶罐都带外挂盘梯（外伸 0.9–1.2 m）。
若照做，X/Y 会到 10.2 m，与 P11 §2 的 Φ9.0 直接冲突，尺寸断言必挂。
本模型按 spec 优先：**不做外挂盘梯**，改为罐顶人孔 + 罐内爬梯。
这是已知偏差，写进报告 limitations，不是漏做。

构件分组：
    static  —— 罐壁 / 底板 / 拱顶 / 加强圈 / 接管 / 栏杆
    liquid  —— 液位柱（T08 按液位 % 缩放，材质半透明）
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

BBOX_TARGET = (9.0, 9.0, 9.0)

R_OUT = 4.455            # 罐壁**外**半径；加强圈外凸 0.045 → 外缘 4.500 = Φ9.0 边界
SHELL_T = 0.020          # 壁厚（可视厚度）
R_IN = R_OUT - SHELL_T
STIFF_OUT = 0.045        # 加强圈外凸量，正好把外缘顶到 4.50
Z_BOTTOM = 0.0
Z_PLATE_T = 0.030        # 底板厚
Z_SHELL_TOP = 7.860      # 直筒顶（π×R_IN²×7.86 ≈ 490 m³，公称 500 m³）
DOME_H = 9.00 - Z_SHELL_TOP     # 拱顶矢高 1.14
DOME_R = (R_OUT ** 2 + DOME_H ** 2) / (2 * DOME_H)   # 9.40
FLOOR_EXT = 0.22         # 底板外伸量（实物值，但会让 Φ 变 9.44 → 本模型不采用）

RAIL_H = 1.116           # 栏杆高：横杆中心 7.86+1.116=8.976，加杆半径 0.022 → 顶 8.998 ≈ 9.00
LIQ_TOP = 7.60           # 液位柱满液高度

# ---------- D-054：外挂磁翻板液位计（R-013 裁 B）----------
GA_ANG = 0.0             # 立管方位角（+X 正面，默认机位可见）
GA_R = 4.40              # 立管中心半径：外缘 4.40+0.09=4.49，守住 Φ9.0 边界
GA_PIPE_R = 0.09
GA_Z0 = 0.42             # 下接管中心高（贴罐底）
GA_Z1 = 7.50             # 上接管中心高（近直筒顶）
GA_LIQ_R = 0.062         # 液柱半径（比立管内缩 0.028，防 z-fighting）


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    out = {"lod": 0, "out": None, "report": None, "id": "TK-WELD-A-001"}
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
        "shell": K.pbr("TK_shell", (0.395, 0.400, 0.398), metallic=0.28, roughness=0.55),
        "shell2": K.pbr("TK_shell_dark", (0.300, 0.310, 0.318), metallic=0.35, roughness=0.55),
        "rail": K.pbr("TK_rail", (0.620, 0.470, 0.070), metallic=0.06, roughness=0.58),
        "pipe": K.pbr("TK_pipe", (0.330, 0.350, 0.365), metallic=0.72, roughness=0.38),
        "floor": K.pbr("TK_floor", (0.190, 0.190, 0.185), metallic=0.15, roughness=0.78),
        # 注释承诺半透明、实现漏了 alpha —— 罐壁不透明时液位从外面看不见（接线验收时发现）
        "liquid": K.pbr("TK_liquid", (0.075, 0.052, 0.030), metallic=0.10, roughness=0.18, alpha=0.55),
        # D-054：立管视窗半透明（看得到管内液柱），液柱用磁翻板红、不透明
        "gauge_pipe": K.pbr("TK_gauge_pipe", (0.235, 0.248, 0.262), metallic=0.55, roughness=0.35, alpha=0.42),
        "gauge_liq": K.pbr("TK_gauge_liq", (0.62, 0.085, 0.045), metallic=0.05, roughness=0.35),
    }


def tube_shell(name, z0, z1, r_out, r_in, seg, mat, group="static"):
    """空心圆筒（外壁 + 内壁 + 顶底环），法线朝外。"""
    bm = bmesh.new()
    ob, ot, ib, it = [], [], [], []
    for i in range(seg):
        a = math.tau * i / seg
        ca, sa = math.cos(a), math.sin(a)
        ob.append(bm.verts.new((r_out * ca, r_out * sa, z0)))
        ot.append(bm.verts.new((r_out * ca, r_out * sa, z1)))
        ib.append(bm.verts.new((r_in * ca, r_in * sa, z0)))
        it.append(bm.verts.new((r_in * ca, r_in * sa, z1)))
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((ob[i], ob[j], ot[j], ot[i]))     # 外壁
        bm.faces.new((ib[j], ib[i], it[i], it[j]))     # 内壁
        bm.faces.new((ob[j], ob[i], ib[i], ib[j]))     # 底环
        bm.faces.new((it[i], it[j], ot[j], ot[i]))     # 顶环
    bm.normal_update()
    return K._finish(name, bm, mat, group, smooth=True)


def dome(name, z_base, r_base, rise, thickness, seg, rings, mat, group="static"):
    """球冠（拱顶）：外表面 + 内表面 + 边缘环。"""
    R = (r_base ** 2 + rise ** 2) / (2 * rise)
    zc = z_base + rise - R          # 球心（在罐顶下方）
    bm = bmesh.new()
    outer, inner = [], []
    for k in range(rings + 1):
        t = k / rings
        r = r_base * math.cos(t * math.pi / 2)
        z = z_base + rise * math.sin(t * math.pi / 2)
        ro, ri = [], []
        rr_in = max(r - thickness, 0.0)
        z_in = z - thickness * 0.5 if 0 < k < rings else z
        for i in range(seg):
            a = math.tau * i / seg
            ro.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
            ri.append(bm.verts.new((rr_in * math.cos(a), rr_in * math.sin(a), z_in)))
        outer.append(ro)
        inner.append(ri)
    for k in range(rings):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((outer[k][i], outer[k][j], outer[k + 1][j], outer[k + 1][i]))
            bm.faces.new((inner[k][j], inner[k][i], inner[k + 1][i], inner[k + 1][j]))
    # 边缘环（拱顶与外壁的交界）
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((outer[0][j], outer[0][i], inner[0][i], inner[0][j]))
    bm.normal_update()
    return K._finish(name, bm, mat, group, smooth=True)


def ring_band(name, z, r, height, out, seg, mat, group="static"):
    """
    加强圈：贴在罐壁外侧的环形带，梯形截面（下斜面 + 外立面 + 上斜面）。
    首版只连了一层斜面，渲染出来是一条暗线，看着像罐壁上的刻痕而不是加强圈。
    """
    bm = bmesh.new()
    ib, ob_, ot, it = [], [], [], []
    chamfer = min(0.012, height * 0.25)
    for i in range(seg):
        a = math.tau * i / seg
        ca, sa = math.cos(a), math.sin(a)
        ib.append(bm.verts.new((r * ca, r * sa, z - height * 0.5)))
        ob_.append(bm.verts.new(((r + out) * ca, (r + out) * sa, z - height * 0.5 + chamfer)))
        ot.append(bm.verts.new(((r + out) * ca, (r + out) * sa, z + height * 0.5 - chamfer)))
        it.append(bm.verts.new((r * ca, r * sa, z + height * 0.5)))
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((ib[i], ib[j], ob_[j], ob_[i]))
        bm.faces.new((ob_[i], ob_[j], ot[j], ot[i]))
        bm.faces.new((ot[i], ot[j], it[j], it[i]))
    bm.normal_update()
    # 加强圈必须保留硬边（flat）：开了平滑会把梯形截面磨圆，
    # 渲染出来是一条"凹槽"，跟实物凸起的角钢圈正好相反。
    return K._finish(name, bm, mat, group, smooth=False)


def build(M, objs, lod):
    seg = 96 if lod == 0 else (48 if lod == 1 else 24)
    rings = 14 if lod == 0 else (7 if lod == 1 else 4)

    # ---------- 底板 ----------
    # 实物底板外伸 0.22 m，但那会让 Φ 变成 9.44 —— 收回到 R_OUT，保 Φ9.0
    objs.append(K.cyl("tk_bottom", (0, 0, 0.0), (0, 0, Z_PLATE_T), R_OUT, seg,
                      M["floor"], group="static"))

    # ---------- 罐壁 ----------
    objs.append(tube_shell("tk_shell", Z_PLATE_T, Z_SHELL_TOP,
                           R_OUT, R_IN, seg, M["shell"]))

    # ---------- 拱顶 ----------
    objs.append(dome("tk_dome", Z_SHELL_TOP, R_OUT, DOME_H, SHELL_T, seg, rings, M["shell"]))

    # ---------- 加强圈（3 道）----------
    # 三档都保留：外缘 4.50 是 Y=9.0 边界的唯一来源，LOD2 砍圈会让校准缩放 1.0101 静默兜底（存量坑，本轮发现）
    for i, z in enumerate((2.0, 4.0, 6.0)):
        objs.append(ring_band(f"tk_stiff_{i}", z, R_OUT, 0.10, STIFF_OUT, seg, M["shell2"]))

    # ---------- 罐顶栏杆（挂在罐壁顶圆周，顶标高 = 9.00）----------
    if lod == 0:
        n_post = 24
        for i in range(n_post):
            a = math.tau * i / n_post
            x, y = (R_OUT - 0.08) * math.cos(a), (R_OUT - 0.08) * math.sin(a)
            objs.append(K.cyl(f"tk_rail_post_{i}", (x, y, Z_SHELL_TOP),
                              (x, y, Z_SHELL_TOP + RAIL_H), 0.030, 8, M["rail"],
                              group="static"))
        for k, h in enumerate((0.36, 0.72, RAIL_H)):
            for i in range(n_post):
                a0 = math.tau * i / n_post
                a1 = math.tau * (i + 1) / n_post
                r = R_OUT - 0.08
                p0 = (r * math.cos(a0), r * math.sin(a0), Z_SHELL_TOP + h)
                p1 = (r * math.cos(a1), r * math.sin(a1), Z_SHELL_TOP + h)
                objs.append(K.cyl(f"tk_rail_bar_{k}_{i}", p0, p1, 0.022, 6, M["rail"],
                                  group="static"))

    # ---------- 罐壁人孔 ----------
    manhole_z = 1.30
    objs.append(K.cyl("tk_manhole_neck", (R_OUT - 0.06, 0, manhole_z),
                      (R_OUT + 0.02, 0, manhole_z), 0.30, 24, M["shell2"], group="static"))
    objs.append(K.cyl("tk_manhole_cover", (R_OUT + 0.02, 0, manhole_z),
                      (R_OUT + 0.035, 0, manhole_z), 0.34, 24, M["pipe"], group="static"))
    if lod == 0:
        objs += K.bolt_ring("tk_mh_bolt", (R_OUT + 0.012, 0, manhole_z), "X",
                            radius=0.29, bolt_r=0.018, bolt_h=0.028, count=12,
                            mat=M["shell2"], group="static")

    # ---------- 接管（进油 / 出油 / 排污 / 呼吸阀）----------
    # 说明：实物接管外伸 0.3 m，但 Φ9.0 是硬约束 → 压成贴壁凸台（外缘 4.495）
    for tag, z, ang, r in (("in", 2.60, 0.0, 0.16), ("out", 0.90, 0.0, 0.13),
                           ("drain", 0.16, math.pi, 0.075)):
        cx, cy = R_OUT * math.cos(ang), R_OUT * math.sin(ang)
        sx, sy = math.cos(ang), math.sin(ang)
        objs.append(K.cyl(f"tk_nozzle_{tag}", (cx - 0.06 * sx, cy - 0.06 * sy, z),
                          (cx + 0.005 * sx, cy + 0.005 * sy, z), r, 18, M["pipe"], group="static"))
        objs.append(K.cyl(f"tk_nozzle_fl_{tag}", (cx + 0.005 * sx, cy + 0.005 * sy, z),
                          (cx + 0.038 * sx, cy + 0.038 * sy, z), r + 0.05, 18, M["pipe"],
                          group="static"))
    # 呼吸阀（罐顶）
    objs.append(K.cyl("tk_breather", (1.55, 0, Z_SHELL_TOP + 0.92),
                      (1.55, 0, Z_SHELL_TOP + 1.10), 0.10, 16, M["pipe"], group="static"))
    objs.append(K.cyl("tk_breather_base", (1.55, 0, Z_SHELL_TOP + 0.80),
                      (1.55, 0, Z_SHELL_TOP + 0.92), 0.07, 12, M["shell2"], group="static"))

    # ---------- 罐顶附件：量油孔 / 透光孔 ----------
    if lod == 0:
        for tag, x, y in (("gauge", -1.40, 0.9), ("light1", 2.2, -1.6), ("light2", -2.2, -1.6)):
            objs.append(K.cyl(f"tk_top_{tag}", (x, y, Z_SHELL_TOP + 0.55),
                              (x, y, Z_SHELL_TOP + 0.68), 0.14, 14, M["shell2"], group="static"))

    # ---------- 液位（内层圆柱，T08 按 % 缩放）----------
    # 半径略小于内壁，避免 z-fighting；顶面留 0.02 缝隙给液面法线
    objs.append(K.cyl("tk_liquid", (0, 0, Z_PLATE_T + 0.005), (0, 0, LIQ_TOP),
                      R_IN - 0.02, seg, M["liquid"], group="liquid"))

    # ---------- D-054：外挂磁翻板液位计 ----------
    gx, gy = GA_R * math.cos(GA_ANG), GA_R * math.sin(GA_ANG)
    # 立管（半透明视窗；管内液柱独立成节点）
    objs.append(K.cyl("tk_gauge_pipe", (gx, gy, GA_Z0), (gx, gy, GA_Z1),
                      GA_PIPE_R, seg, M["gauge_pipe"], group="static"))
    # 上下接管（罐壁 ↔ 立管，贴壁走，不越边界）
    for tag, z in (("bot", GA_Z0), ("top", GA_Z1)):
        objs.append(K.cyl(f"tk_gauge_tube_{tag}", (4.34, gy, z), (4.455, gy, z),
                          0.055, 12, M["pipe"], group="static"))
        # 截止阀（短粗节 + 阀盖）
        objs.append(K.cyl(f"tk_gauge_valve_{tag}", (4.395, gy, z), (4.43, gy, z),
                          0.085, 12, M["shell2"], group="static"))
    # 刻度：每 1 m 一道（立管侧向 +Y，x 不外伸，守住 4.50 边界），lod≥2 省略
    if lod <= 1:
        for i in range(7):
            z = 1.0 + i
            objs.append(K.box(f"tk_gauge_tick_{i}", (gx, gy + 0.13, z), (0.014, 0.06, 0.012),
                              M["rail"], group="static"))
    # 顶排气小帽
    objs.append(K.cyl("tk_gauge_vent", (gx, gy, GA_Z1), (gx, gy, GA_Z1 + 0.10),
                      0.03, 10, M["pipe"], group="static"))
    # 液柱（独立节点，tankLevel 用同一 pct 驱动；底边钉在 GA_Z0）
    objs.append(K.cyl("tk_gauge_liquid", (gx, gy, GA_Z0), (gx, gy, GA_Z1),
                      GA_LIQ_R, max(8, seg // 4), M["gauge_liq"], group="gauge_liquid"))


def join_by_group(objs, groups):
    name_group = {o.name: o.get("pa_group") for o in objs if o.name in bpy.data.objects}
    out = {}
    for g in groups:
        names = [n for n, gg in name_group.items() if gg == g]
        members = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
        if not members:
            continue
        if len(members) == 1:
            members[0].name = f"tk_{g}"
            members[0]["pa_group"] = g
            out[g] = members[0]
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = f"tk_{g}"
        merged["pa_group"] = g
        out[g] = merged
    return out


def main():
    a = parse_args()
    lod = a["lod"]
    out = a["out"] or f"tank_lod{lod}.glb"

    K.reset_scene()
    M = mats()
    objs = []
    build(M, objs, lod)

    mn, mx = K.world_bbox(objs)
    design = tuple(mx[i] - mn[i] for i in range(3))

    rows = []
    for ob in objs:
        bmn, bmx = K.world_bbox([ob])
        rows.append((ob.name, bmx[0], bmn[0]))
    rows.sort(key=lambda r: -max(abs(r[1]), abs(r[2])))
    print("[x-edge top5]", [(n, round(a1, 3), round(b1, 3)) for n, a1, b1 in rows[:5]])
    zr = sorted(((n, bmx[2]) for n, bmx in [(o.name, K.world_bbox([o])[1]) for o in objs]),
                key=lambda t: -t[1])
    print("[z-top5]", [(n, round(v, 3)) for n, v in zr[:5]])

    sx = BBOX_TARGET[0] / design[0]
    sy = BBOX_TARGET[1] / design[1]
    sz = BBOX_TARGET[2] / design[2]
    K.apply_offset_and_scale(
        objs, (sx, sy, sz),
        (-(mn[0] * sx + mx[0] * sx) * 0.5, -(mn[1] * sy + mx[1] * sy) * 0.5, -mn[2] * sz))

    mn2, mx2 = K.world_bbox(objs)
    final = [round(mx2[i] - mn2[i], 5) for i in range(3)]

    joined = join_by_group(objs, ["static", "liquid", "gauge_liquid"])
    for g, ob in joined.items():
        ob["pa_id"] = a["id"] + ("" if g == "static" else f":{g}")
        ob["pa_type"] = "tank"
        ob["pa_spec"] = "500m3 D9.0 H9.0"
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
        "asset": "tank", "spec": "500m3 D9.0 H9.0", "lod": lod, "id": a["id"],
        "bbox_target_m": list(BBOX_TARGET),
        "bbox_design_m": [round(v, 4) for v in design],
        "bbox_final_m": final,
        "bbox_min_m": [round(v, 5) for v in mn2],
        "bbox_max_m": [round(v, 5) for v in mx2],
        "calibration_scale": [round(sx, 6), round(sy, 6), round(sz, 6)],
        "error_pct": [round(e, 4) for e in errs],
        "triangles": tr, "vertices": vt, "materials": sorted(ms),
        "groups": sorted(joined.keys()),
        "volume_m3": round(math.pi * (R_IN ** 2) * (Z_SHELL_TOP - Z_PLATE_T), 1),
        "limitations": "按 Φ9.0 包围盒约束，未做外挂盘梯（实物外伸 0.9–1.2 m，会与 spec 冲突）",
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
