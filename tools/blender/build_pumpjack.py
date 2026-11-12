"""
build_pumpjack.py · 游梁式抽油机参数化建模（API C-456-305-144）

用法（headless）：
    blender --background --factory-startup --python build_pumpjack.py -- \
        --lod 0 --out D:/pa/out/pumpjack_lod0.glb --report D:/pa/out/report.json

型号含义（API Spec 11E 命名法）：
    C    = 曲柄平衡（Crank-balanced）
    456  = 减速器额定扭矩 456,000 in·lbf = 51.5 kN·m
    305  = 最大光杆载荷 30,500 lbf = 135.7 kN
    144  = 最大冲程 144 in = 3.66 m

坐标系：Blender Z-up，米制。X = 机身长度，Y = 宽度，Z = 高度。
         包围盒目标 9.0 × 2.5 × 8.6 m，Z 贴地（min Z = 0），X/Y 居中。

构件分组（导出后供 three.js 做四连杆运动学）：
    static  —— 底座 / 支架 / 减速箱 / 电机 / 井口 / 护栏
    beam    —— 游梁 + 驴头 + 悬绳器（绕支架轴承摆动）
    crank_l / crank_r —— 曲柄臂 + 平衡块 + 曲柄销（绕曲柄轴回转）
    pitman_l / pitman_r —— 连杆（两端铰接）
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

# ============================================================ 参数

def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    out = {"lod": 0, "out": None, "report": None, "id": "PM-WELD-A-001"}
    i = 0
    while i < len(argv):
        k = argv[i].lstrip("-")
        v = argv[i + 1] if i + 1 < len(argv) else ""
        if k in out:
            out[k] = int(v) if k == "lod" else v
        i += 2
    return out


# ---- 总体（米）----------------------------------------------------
BBOX_TARGET = (9.00, 2.50, 8.60)   # X / Y / Z，P11 §2

BASE_HALF_X = 4.50      # 底座半长 → X 边界
RAIL_Y = 0.95           # 纵梁中心线
BASE_TOP = 0.32         # 底座顶面

SADDLE = Vector((-1.20, 0.0, 7.70))    # 支架轴承中心（游梁支点）
BEAM_Z = 8.00                          # 游梁中心线
BEAM_BACK_X = -3.10                    # 游梁后端（后臂 1.90 m）
BEAM_FRONT_X = 2.85                    # 游梁前端（前臂 4.05 m，臂比 ≈ 1:2.1）

CRANK = Vector((-3.30, 0.0, 1.05))     # 曲柄轴中心（减速箱箱体中心）
# 曲柄半径由冲程反解，不是拍脑袋：
#   游梁式抽油机冲程 S ≈ 2R × (游梁前臂 / 后臂)
#   前臂 4.153、后臂 1.845（比 2.251），S = 144 in = 3.66 m
#   → R = 3.66 / (2 × 2.251) = 0.813
# 取 0.824：四连杆解算与建模几何互相校验后回填的值，实测冲程 3.662 m（见 kinematics_check.mjs）。
# 首版曾误取 1.55（直接当 S/2），曲柄销会转到 x=−4.85 甩出 −4.50 的底座边界。
CRANK_R = 0.824
CRANK_ARM_Y = 0.80                     # 曲柄臂中心 y
CW_Y = 1.05                            # 平衡块中心 y（外缘 1.25 = Y 边界）
PITMAN_Y = 0.80

# 静态姿态：曲柄停在 130°（指向左上）。
# 为什么不是 90°：θ=90° 时曲柄臂、连杆、游梁后臂共线，侧视图里整台机器只剩一根"柱子"，
# 四连杆的运动关系完全看不出来。停在 130° 让曲柄臂、连杆、游梁形成可读的三角形。
CRANK_THETA = math.radians(130.0)
PIN_X = CRANK.x + CRANK_R * math.cos(CRANK_THETA)
PIN_Z = CRANK.z + CRANK_R * math.sin(CRANK_THETA)

GB_HALF_X = 0.70                       # 减速箱半长 → x ∈ [-4.00, -2.60]
GB_HALF_Y = 0.60
GB_Z = 0.94                            # 箱体中心高
PULLEY_X = -3.80                       # 大小带轮共同的 X 平面（皮带在 YZ 面内）
MOTOR_Y = 0.96
MOTOR_Z = 0.76
MOTOR_R = 0.26

HH_C = Vector((2.95, 0.0, 7.55))       # 驴头弧心
HH_R_OUT = 1.05                        # → 弧顶 z = 8.60 = Z 边界
HH_R_IN = 0.93                         # 弧板厚 0.12（实物 8–12 mm 板 + 内外双面加强筋的等效厚度）
HH_W = 0.72                            # 弧面宽度（比游梁宽，实物驴头是整机最宽的单件之一）
HH_A0 = math.radians(-88.0)
HH_A1 = math.radians(88.0)

POLISHED_ROD_X = HH_C.x


# ============================================================ 材质

def build_materials():
    """
    工业涂装件，不是裸金属。
    教训：钢结构给 metallic 0.85 会在天空反射下整台变成浅灰白 —— 实际现场是
    深灰醇酸漆 / 铸铁机件 / 蓝灰电机漆，metallic 都在 0.1–0.3，靠 roughness 出层次。
    """
    return {
        "steel": K.pbr("PA_steel", (0.148, 0.163, 0.176), metallic=0.18, roughness=0.58),
        "cast": K.pbr("PA_cast_iron", (0.088, 0.098, 0.108), metallic=0.28, roughness=0.70),
        "motor": K.pbr("PA_motor", (0.075, 0.175, 0.310), metallic=0.12, roughness=0.52),
        "rail": K.pbr("PA_rail", (0.620, 0.470, 0.070), metallic=0.06, roughness=0.58),
        "rubber": K.pbr("PA_rubber", (0.035, 0.040, 0.045), metallic=0.00, roughness=0.90),
        "pipe": K.pbr("PA_pipe", (0.330, 0.350, 0.365), metallic=0.72, roughness=0.38),
    }


# ============================================================ 构件

def build_base(M, objs, lod):
    """底橇：两根工字钢纵梁 + 横梁 + 地脚板。X 边界由纵梁决定 = ±4.50。"""
    for side, sy in (("l", -RAIL_Y), ("r", RAIL_Y)):
        objs += K.i_beam(f"pq_base_rail_{side}", (-BASE_HALF_X, sy, BASE_TOP * 0.5),
                         (BASE_HALF_X, sy, BASE_TOP * 0.5),
                         width=0.30, height=BASE_TOP, web_t=0.030, flange_t=0.032,
                         mat=M["steel"])
    xs = (-4.30, -2.20, -0.62, 1.80, 4.30) if lod <= 1 else (-4.30, -0.62, 4.30)
    for i, x in enumerate(xs):
        objs.append(K.beam(f"pq_base_cross_{i}", (x, -RAIL_Y - 0.10, 0.20),
                           (x, RAIL_Y + 0.10, 0.20), w=0.16, h=0.20, mat=M["steel"]))
    # 地脚板（内收 0.01，不抢纵梁的 X 边界）
    for i, x in enumerate((-4.32, 4.32)):
        objs.append(K.box(f"pq_base_pad_{i}", (x, 0.0, 0.018), (0.34, 2.26, 0.036), M["steel"]))
    # 底座斜撑（纵梁内侧，防扭）
    for side, sy in (("l", -RAIL_Y), ("r", RAIL_Y)):
        objs.append(K.beam(f"pq_base_brace_{side}", (-3.30, sy, 0.30), (1.90, sy, 0.30),
                           w=0.10, h=0.14, mat=M["steel"]))


def build_samson_post(M, objs, lod):
    """A 字支架：4 条斜腿 → 顶板 → 轴承座。轴承中心 = SADDLE。"""
    leg_top_z = 7.45
    LEG_FRONT_X, LEG_BACK_X = -2.10, -0.30
    feet = [("fl", LEG_FRONT_X, -1.05), ("fr", LEG_FRONT_X, 1.05),
            ("bl", LEG_BACK_X, -1.05), ("br", LEG_BACK_X, 1.05)]
    for tag, fx, fy in feet:
        p0 = (fx, fy, BASE_TOP)
        p1 = (SADDLE.x, math.copysign(0.24, fy), leg_top_z)
        objs.append(K.beam(f"pq_post_leg_{tag}", p0, p1, w=0.22, h=0.22, mat=M["steel"]))
        # 腿脚底板
        objs.append(K.box(f"pq_post_foot_{tag}", (fx, fy, BASE_TOP + 0.02),
                          (0.40, 0.40, 0.04), M["steel"]))

    # 横向拉杆（3 道）
    for i, z in enumerate((2.60, 4.60, 6.20)):
        t = (z - BASE_TOP) / (leg_top_z - BASE_TOP)
        fx = LEG_FRONT_X + t * (SADDLE.x - LEG_FRONT_X)
        fy = 1.05 + t * (0.24 - 1.05)
        bx = LEG_BACK_X + t * (SADDLE.x - LEG_BACK_X)
        by = 1.05 + t * (0.24 - 1.05)
        objs.append(K.beam(f"pq_post_tie_f{i}", (fx, -fy, z), (fx, fy, z),
                           w=0.12, h=0.12, mat=M["steel"]))
        objs.append(K.beam(f"pq_post_tie_b{i}", (bx, -by, z), (bx, by, z),
                           w=0.12, h=0.12, mat=M["steel"]))
        # 前后腿之间的纵向连系杆
        for sy in (-fy, fy):
            objs.append(K.beam(f"pq_post_tie_l{i}{'n' if sy < 0 else 'p'}",
                               (fx, sy, z), (bx, sy, z), w=0.09, h=0.09, mat=M["steel"]))

    # 顶板 + 轴承座
    objs.append(K.box("pq_post_cap", (SADDLE.x, 0.0, 7.56), (0.92, 0.90, 0.20), M["steel"]))
    for side, sy in (("l", -0.31), ("r", 0.31)):
        objs.append(K.box(f"pq_bearing_{side}", (SADDLE.x, sy, SADDLE.z), (0.34, 0.20, 0.44),
                          M["cast"]))
        if lod == 0:
            objs += K.bolt_ring(f"pq_bearing_bolt_{side}", (SADDLE.x, sy, SADDLE.z), "Y",
                                radius=0.13, bolt_r=0.018, bolt_h=0.05, count=4,
                                mat=M["steel"], group="static")


def build_walking_beam(M, objs, lod):
    """游梁（工字钢）+ 后臂连接头。group = beam，绕 SADDLE 摆动。"""
    objs += K.i_beam("pq_beam_main", (BEAM_BACK_X, 0.0, BEAM_Z), (BEAM_FRONT_X, 0.0, BEAM_Z),
                     width=0.40, height=0.62, web_t=0.045, flange_t=0.055,
                     mat=M["steel"], group="beam")
    # 后臂横担 + 两块耳板（连杆上端插在耳板之间，用销轴铰接 —— 真实结构不是实心方块）
    objs.append(K.box("pq_beam_tail_cross", (BEAM_BACK_X + 0.08, 0.0, BEAM_Z),
                      (0.22, 2.00, 0.30), M["steel"], group="beam"))
    for side, sy in (("l", -0.96), ("r", 0.96)):
        objs.append(K.box(f"pq_beam_ear_{side}", (BEAM_BACK_X + 0.08, sy, BEAM_Z),
                          (0.34, 0.055, 0.44), M["steel"], group="beam"))
    objs.append(K.cyl("pq_beam_tail_pin",
                      (BEAM_BACK_X + 0.08, -1.00, BEAM_Z), (BEAM_BACK_X + 0.08, 1.00, BEAM_Z),
                      0.050, 14, M["steel"], group="beam"))
    # 支点抱瓦
    objs.append(K.cyl("pq_beam_saddle", (SADDLE.x, -0.46, SADDLE.z), (SADDLE.x, 0.46, SADDLE.z),
                      0.17, 24, M["cast"], group="beam"))
    # 前端加强段（比游梁略窄，不形成"方盒子"）
    objs.append(K.box("pq_beam_nose", (BEAM_FRONT_X - 0.12, 0.0, BEAM_Z),
                      (0.24, 0.38, 0.66), M["steel"], group="beam"))


def build_horsehead(M, objs, lod):
    """
    驴头：薄弧板（R 1.05 / 板厚 0.095）+ 两侧夹板 + 径向加强筋。
    弧的两端正好落在 x = BEAM_FRONT_X，游梁前端插进弧口 —— 这是真实的套合结构，
    不是"贴一个环在梁头上"。
    """
    segs = 72 if lod == 0 else (36 if lod == 1 else 16)
    objs.append(K.arc_band("pq_hh_arc", (HH_C.x, 0.0, HH_C.z),
                           HH_R_OUT, HH_R_IN, HH_A0, HH_A1, HH_W, segs,
                           mat=M["steel"], group="beam"))
    # 径向加强筋：从弧板内侧收敛到游梁前端（外宽内窄的楔形）
    n_rib = 6 if lod == 0 else (2 if lod == 1 else 0)
    for i in range(n_rib):
        a = HH_A0 + (HH_A1 - HH_A0) * (i + 0.5) / n_rib
        r_mid = (HH_R_OUT + HH_R_IN) * 0.5
        p0 = (HH_C.x + HH_R_IN * math.cos(a), 0.0, HH_C.z + HH_R_IN * math.sin(a))
        p1 = (HH_C.x + r_mid * math.cos(a), 0.0, HH_C.z + r_mid * math.sin(a))
        objs.append(K.beam(f"pq_hh_rib_{i}", p0, p1, w=HH_W * 0.50, h=0.075,
                           mat=M["steel"], group="beam"))
    # 两侧夹板：把弧板两翼夹在游梁前端（真实驴头的两块侧板）
    for side, sy in (("l", -(HH_W * 0.5 + 0.015)), ("r", HH_W * 0.5 + 0.015)):
        objs.append(K.box(f"pq_hh_side_{side}", (2.60, sy, BEAM_Z - 0.02),
                          (0.52, 0.030, 0.72), M["steel"], group="beam"))
    # 驴头唇口：下缘外翻挡绳边
    objs.append(K.arc_band("pq_hh_lip", (HH_C.x, 0.0, HH_C.z),
                           HH_R_OUT + 0.035, HH_R_OUT - 0.02,
                           math.radians(-96.0), math.radians(-72.0),
                           HH_W + 0.06, 14, mat=M["steel"], group="beam"))
    # 两侧挡绳凸边（构成 U 型绳槽，驴头才不是一片纸）
    if lod <= 1:
        for side, sy in (("l", -(HH_W * 0.5 + 0.012)), ("r", HH_W * 0.5 + 0.012)):
            objs.append(K.arc_band(f"pq_hh_flange_{side}", (HH_C.x, sy, HH_C.z),
                                   HH_R_OUT - 0.004, HH_R_IN - 0.055, HH_A0, HH_A1,
                                   0.024, 40, mat=M["steel"], group="beam"))


def build_crank(M, objs, lod):
    """
    曲柄臂 + 平衡块 + 曲柄销，停在 CRANK_THETA（130°，指向左上）。

    姿态为什么重要：θ=90° 时曲柄臂、连杆、游梁后臂共线，侧视图里三者叠成一根柱子，
    四连杆的运动关系完全读不出来。停在 130° 让机构形成可辨识的三角形。
    """
    ct, st = math.cos(CRANK_THETA), math.sin(CRANK_THETA)
    for side, sy_c, sy_cw in (("l", -CRANK_ARM_Y, -CW_Y), ("r", CRANK_ARM_Y, CW_Y)):
        grp = f"crank_{side}"
        # 曲柄臂：轴心 → 曲柄销，沿 θ 方向（box 旋转会让包围盒失控，改用两端点梁）
        objs.append(K.beam(f"pq_crank_arm_{side}",
                           (CRANK.x, sy_c, CRANK.z), (PIN_X, sy_c, PIN_Z),
                           w=0.10, h=0.28, mat=M["steel"], group=grp))
        # 轴端轮毂
        objs.append(K.cyl(f"pq_crank_hub_{side}",
                          (CRANK.x, sy_c - 0.09, CRANK.z), (CRANK.x, sy_c + 0.09, CRANK.z),
                          0.26, 24, M["cast"], group=grp))
        # 平衡块：矩形可调式配重板，长轴沿曲柄方向（曲柄半径只有 0.86，块体随之收小）
        # 旋转角 = 90° - θ（从 +Z 转到 θ 方向，绕 +Y）
        cw_r = 0.45
        objs.append(K.box(f"pq_cw_{side}",
                          (CRANK.x + cw_r * ct, sy_cw, CRANK.z + cw_r * st),
                          (0.58, 0.40, 0.62), M["cast"], group=grp,
                          rot=(0.0, math.radians(90.0) - CRANK_THETA, 0.0)))
        # 平衡块锁紧螺栓（沿曲柄方向排布）
        if lod == 0:
            for k in range(4):
                rr = 0.22 + k * 0.13
                bx = CRANK.x + rr * ct
                bz = CRANK.z + rr * st
                for off in (-0.16, 0.16):
                    objs.append(K.hex_prism(f"pq_cw_bolt_{side}{k}{'a' if off < 0 else 'b'}",
                                            (bx + off * st, sy_cw, bz - off * ct),
                                            0.028, 0.38, M["steel"],
                                            axis="Y", group=grp))
    # 曲柄销（贯穿两根连杆下端）
    objs.append(K.cyl("pq_crank_pin", (PIN_X, -CRANK_ARM_Y - 0.06, PIN_Z),
                      (PIN_X, CRANK_ARM_Y + 0.06, PIN_Z),
                      0.075, 20, M["steel"], group="static"))


def build_pitman(M, objs, lod):
    """连杆：曲柄销 → 游梁后臂铰点。两端带销轴座。"""
    top = Vector((BEAM_BACK_X + 0.08, 0.0, BEAM_Z))
    bot = Vector((PIN_X, 0.0, PIN_Z))
    for side, sy in (("l", -PITMAN_Y), ("r", PITMAN_Y)):
        grp = f"pitman_{side}"
        p0 = (bot.x, sy, bot.z)
        p1 = (top.x, sy, top.z)
        objs.append(K.beam(f"pq_pitman_{side}", p0, p1, w=0.16, h=0.24,
                           mat=M["steel"], group=grp))
        # 上下端头
        objs.append(K.cyl(f"pq_pitman_head_lo_{side}",
                          (bot.x, sy - 0.10, bot.z), (bot.x, sy + 0.10, bot.z),
                          0.11, 18, M["cast"], group=grp))
        objs.append(K.cyl(f"pq_pitman_head_hi_{side}",
                          (top.x, sy - 0.10, top.z), (top.x, sy + 0.10, top.z),
                          0.11, 18, M["cast"], group=grp))


def build_gearbox(M, objs, lod):
    """减速箱：箱体 + 顶盖 + 散热筋 + 输入轴 + 油标。

    输入轴从箱体 -X 端面伸出，端点装大带轮；带轮 X 平面 = PULLEY_X，
    与电机小带轮同平面（轴都沿 X），皮带在 YZ 面内传动。
    """
    cx, cy, cz = CRANK.x, 0.0, GB_Z
    objs.append(K.box("pq_gb_body", (cx, cy, cz), (GB_HALF_X * 2, GB_HALF_Y * 2, 1.24), M["cast"]))
    objs.append(K.box("pq_gb_top", (cx, cy, cz + 0.64), (GB_HALF_X * 2 - 0.10, GB_HALF_Y * 2 - 0.10, 0.10), M["cast"]))
    if lod == 0:
        for i in range(6):
            x = cx - 0.55 + i * 0.22
            objs.append(K.box(f"pq_gb_fin_{i}", (x, cy, cz + 0.36), (0.05, GB_HALF_Y * 2 - 0.16, 0.46),
                              M["cast"]))
    # 输出轴（穿到两侧曲柄）
    objs.append(K.cyl("pq_gb_out_shaft", (cx, -0.86, CRANK.z), (cx, 0.86, CRANK.z),
                      0.13, 24, M["steel"]))
    # 输入轴：从箱体 -X 端面伸出
    in_x0 = cx - GB_HALF_X
    objs.append(K.cyl("pq_gb_in_shaft", (in_x0 + 0.02, cy, CRANK.z),
                      (PULLEY_X + 0.06, cy, CRANK.z), 0.070, 18, M["steel"]))
    # 大带轮（减速箱侧）
    objs.append(K.cyl("pq_gb_pulley", (PULLEY_X + 0.06, cy, CRANK.z),
                      (PULLEY_X - 0.06, cy, CRANK.z), 0.34, 32, M["cast"]))
    # 地脚螺栓
    if lod == 0:
        for i, (dx, dy) in enumerate(((-0.56, -0.50), (-0.56, 0.50), (0.56, -0.50), (0.56, 0.50))):
            objs.append(K.hex_prism(f"pq_gb_foot_bolt_{i}", (cx + dx, dy, BASE_TOP + 0.05),
                                    0.032, 0.10, M["steel"], axis="Z"))


def build_motor(M, objs, lod):
    """电机 + 小带轮 + 皮带 + 皮带罩。

    电机轴沿 X，与减速箱输入轴平行；小带轮与大带轮同在 PULLEY_X 平面，
    皮带在 YZ 面内跨接两轮（中心距 ≈ 1.00 m，包角足够）。
    """
    my, mz = MOTOR_Y, MOTOR_Z
    seg = 32 if lod == 0 else 16
    x0, x1 = -4.42, -3.94
    objs.append(K.cyl("pq_motor_body", (x0, my, mz), (x1, my, mz), MOTOR_R, seg, M["motor"]))
    for i, x in enumerate((x0, x1)):
        objs.append(K.cyl(f"pq_motor_cap_{i}", (x - 0.03, my, mz), (x + 0.03, my, mz),
                          MOTOR_R + 0.012, seg, M["cast"]))
    # 风扇罩（后端，外缘正好压在 -4.50 的 X 边界上）
    objs.append(K.cyl("pq_motor_fan", (x0 - 0.08, my, mz), (x0 - 0.01, my, mz), 0.21, seg,
                      M["cast"]))
    # 接线盒
    objs.append(K.box("pq_motor_jb", (-4.18, my, mz + 0.30), (0.28, 0.22, 0.15), M["cast"]))
    # 电机滑轨底座
    objs.append(K.box("pq_motor_skid", ((x0 + x1) * 0.5, my, 0.42), (x1 - x0 + 0.16, 0.52, 0.10),
                      M["steel"]))
    # 电机轴伸出 + 小带轮
    objs.append(K.cyl("pq_motor_shaft", (x1 - 0.02, my, mz), (PULLEY_X + 0.06, my, mz),
                      0.048, 14, M["steel"]))
    objs.append(K.cyl("pq_motor_pulley", (PULLEY_X + 0.06, my, mz), (PULLEY_X - 0.06, my, mz),
                      0.17, 24, M["cast"]))

    # 皮带：两轮外切线（YZ 面内），w 沿 X 为带宽方向
    if lod <= 1:
        import math as _m
        c1 = (0.0, CRANK.z)      # 大轮心 (y, z)
        c2 = (my, mz)            # 小轮心
        r1, r2 = 0.34, 0.17
        dy, dz = c2[0] - c1[0], c2[1] - c1[1]
        L = _m.hypot(dy, dz)
        uy, uz = dy / L, dz / L
        ny, nz = uz, -uy          # 法向
        for tag, sgn in (("a", 1.0), ("b", -1.0)):
            p0 = (PULLEY_X, c1[0] + sgn * r1 * ny, c1[1] + sgn * r1 * nz)
            p1 = (PULLEY_X, c2[0] + sgn * r2 * ny, c2[1] + sgn * r2 * nz)
            objs.append(K.beam(f"pq_belt_{tag}", p0, p1, w=0.030, h=0.070, mat=M["rubber"]))

    # 皮带防护网（两片薄侧板，不遮挡观察传动）
    for tag, xoff in (("a", -0.14), ("b", 0.14)):
        objs.append(K.box(f"pq_belt_guard_{tag}", (PULLEY_X + xoff, 0.48, 0.94),
                          (0.012, 1.20, 1.00), M["rail"]))

    if lod == 0:
        for i, (dx, dy2) in enumerate(((-0.18, -0.18), (-0.18, 0.18), (0.18, -0.18), (0.18, 0.18))):
            objs.append(K.hex_prism(f"pq_motor_bolt_{i}",
                                    ((x0 + x1) * 0.5 + dx, my + dy2, 0.48),
                                    0.024, 0.06, M["steel"], axis="Z"))


def build_wellhead(M, objs, lod):
    """
    光杆 + 绳挂（bridle）+ 井口法兰。

    真实悬挂方式：光杆卡子（clamp）卡住光杆，两根钢丝绳斜拉到驴头弧面两侧的绳槽，
    不是把光杆直接插进驴头里。绳长为可见长度（≈0.55 m），所以卡子放在 z=6.10。
    """
    seg = 16 if lod == 0 else 8
    objs.append(K.cyl("pq_polished_rod", (POLISHED_ROD_X, 0.0, 0.62),
                      (POLISHED_ROD_X, 0.0, 6.62), 0.045, seg, M["pipe"]))
    # 光杆卡子
    objs.append(K.box("pq_rod_clamp", (POLISHED_ROD_X, 0.0, 6.10), (0.19, 0.17, 0.11),
                      M["steel"], group="beam"))
    # 两根钢丝绳（斜拉到驴头弧面两侧）
    for side, sy in (("l", -1.0), ("r", 1.0)):
        p_top = (POLISHED_ROD_X, sy * 0.215, 6.645)
        p_bot = (POLISHED_ROD_X, sy * 0.055, 6.135)
        objs.append(K.cyl(f"pq_bridle_{side}", p_top, p_bot, 0.013, 8, M["pipe"],
                          group="beam"))
        # 绳头压板
        objs.append(K.box(f"pq_bridle_clip_{side}", (POLISHED_ROD_X, sy * 0.215, 6.665),
                          (0.10, 0.09, 0.05), M["cast"], group="beam"))
    # 井口
    objs.append(K.cyl("pq_wellhead_flange", (POLISHED_ROD_X, 0.0, 0.0),
                      (POLISHED_ROD_X, 0.0, 0.09), 0.22, 24, M["cast"]))
    objs.append(K.cyl("pq_wellhead_body", (POLISHED_ROD_X, 0.0, 0.09),
                      (POLISHED_ROD_X, 0.0, 0.58), 0.13, 20, M["pipe"]))
    if lod == 0:
        objs += K.bolt_ring("pq_wh_bolt", (POLISHED_ROD_X, 0.0, 0.10), "Z",
                            radius=0.17, bolt_r=0.020, bolt_h=0.05, count=8, mat=M["steel"])


def build_railing(M, objs, lod):
    """底座护栏：立柱 + 上下扶手。y 外缘 = ±1.22（Y 边界内）。"""
    if lod >= 1:
        return
    ry = 1.215
    posts = (-4.20, -3.00, -1.80, -0.60, 0.60, 1.80, 3.00, 4.20)
    for side, sy in (("l", -ry), ("r", ry)):
        for i, x in enumerate(posts):
            objs.append(K.cyl(f"pq_rail_post_{side}{i}", (x, sy, BASE_TOP),
                              (x, sy, 1.12), 0.032, 10, M["rail"]))
        for j, z in enumerate((0.78, 1.12)):
            objs.append(K.cyl(f"pq_rail_bar_{side}{j}", (posts[0], sy, z),
                              (posts[-1], sy, z), 0.030, 10, M["rail"]))
        # 端部封口
        for xe in (posts[0], posts[-1]):
            objs.append(K.cyl(f"pq_rail_end_{side}{int(xe*10)}", (xe, 0.10 * (1 if sy > 0 else -1), 1.12),
                              (xe, sy, 1.12), 0.030, 10, M["rail"]))


def build_ladder(M, objs, lod):
    """
    支架后侧检修梯。放在支架 -X 侧的中轴上（x 由 -1.34 斜到 -0.98），
    避开所有横撑与纵向连系杆 —— 首版把它塞在支架中间，与横撑交叉，视觉上很乱。
    """
    if lod >= 1:
        return
    x_bot, x_top = -1.34, -0.98
    z_bot, z_top = BASE_TOP, 7.20
    for side, sy in (("l", -0.30), ("r", 0.30)):
        objs.append(K.cyl(f"pq_ladder_rail_{side}", (x_bot, sy, z_bot), (x_top, sy, z_top),
                          0.028, 10, M["steel"]))
    n = 12
    for i in range(n):
        t = (i + 0.5) / n
        cx = x_bot + t * (x_top - x_bot)
        cz = z_bot + t * (z_top - z_bot)
        objs.append(K.box(f"pq_ladder_step_{i}", (cx, 0.0, cz), (0.05, 0.64, 0.03),
                          M["steel"]))
    # 顶部护笼开口
    objs.append(K.cyl("pq_ladder_top_bar", (x_top, -0.34, z_top), (x_top, 0.34, z_top),
                      0.025, 8, M["steel"]))


def build_details(M, objs, lod):
    """铭牌、护罩、管线等点缀件。"""
    if lod >= 2:
        return
    # 铭牌
    objs.append(K.box("pq_nameplate", (CRANK.x, -0.607, 1.30), (0.40, 0.012, 0.22),
                      M["rail"]))
    # 减速箱放油管
    objs.append(K.cyl("pq_drain_pipe", (-3.92, 0.40, 0.36), (-3.92, 0.40, 0.10),
                      0.028, 10, M["pipe"]))
    # 刹车手柄
    objs.append(K.beam("pq_brake_lever", (-2.64, 0.66, 1.56), (-2.48, 0.80, 2.28),
                       w=0.05, h=0.05, mat=M["rail"]))


# ============================================================ 主流程

def join_by_group(objs, groups_wanted):
    """
    按 pa_group 合并对象，减少 draw call（同组同运动）。返回 {group: obj}。

    注意：bpy.ops.object.join() 会真正销毁被吞掉的对象，objs 里残留的是失效引用
    （StructRNA of type Object has been removed）。所以先快照 name→group，
    之后只按名字取 bpy.data.objects，不再碰旧引用。
    """
    name_group = {}
    for o in objs:
        if o.name in bpy.data.objects:      # 过滤已失效
            name_group[o.name] = o.get("pa_group")
    out = {}
    for g in groups_wanted:
        names = [n for n, gg in name_group.items() if gg == g]
        members = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
        if not members:
            continue
        if len(members) == 1:
            members[0].name = f"pq_{g}"
            members[0]["pa_group"] = g
            out[g] = members[0]
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for o in members:
            o.select_set(True)
        bpy.context.view_layer.objects.active = members[0]
        bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = f"pq_{g}"
        merged["pa_group"] = g
        out[g] = merged
    return out


def main():
    args = parse_args()
    lod = args["lod"]
    out_path = args["out"] or f"pumpjack_lod{lod}.glb"
    report_path = args["report"]

    K.reset_scene()
    M = build_materials()
    objs = []

    # 运动组用 group 参数标记；静态件默认 static
    build_base(M, objs, lod)
    build_samson_post(M, objs, lod)
    build_walking_beam(M, objs, lod)
    build_horsehead(M, objs, lod)
    build_crank(M, objs, lod)
    build_pitman(M, objs, lod)
    build_gearbox(M, objs, lod)
    build_motor(M, objs, lod)
    build_wellhead(M, objs, lod)
    build_railing(M, objs, lod)
    build_ladder(M, objs, lod)
    build_details(M, objs, lod)

    # ---- 几何自检（合并前，逐构件便于定位）----
    mn, mx = K.world_bbox(objs)
    size_design = tuple(mx[i] - mn[i] for i in range(3))

    # ---- 尺寸校准：把包围盒精确对齐到 spec，并贴地/居中 ----
    sx = BBOX_TARGET[0] / size_design[0]
    sy = BBOX_TARGET[1] / size_design[1]
    sz = BBOX_TARGET[2] / size_design[2]
    offset = (-(mn[0] * sx + mx[0] * sx) * 0.5,
              -(mn[1] * sy + mx[1] * sy) * 0.5,
              -mn[2] * sz)
    K.apply_offset_and_scale(objs, (sx, sy, sz), offset)

    mn2, mx2 = K.world_bbox(objs)
    size_final = [round(mx2[i] - mn2[i], 5) for i in range(3)]

    # ---- 按运动组合并 ----
    groups = ["static", "beam", "crank_l", "crank_r", "pitman_l", "pitman_r"]
    joined = join_by_group(objs, groups)

    # ---- 写 extras（构件 ID ↔ 业务主数据）----
    for g, ob in joined.items():
        ob["pa_id"] = f"{args['id']}" + ("" if g == "static" else f":{g}")
        ob["pa_type"] = "pumpjack"
        ob["pa_spec"] = "C-456-305-144"
        ob["pa_group"] = g

    # 根节点也用空物体挂一份（便于 three.js 按 ID 反查）
    root = bpy.data.objects.new("PM_ROOT", None)
    bpy.context.scene.collection.objects.link(root)
    root["pa_id"] = args["id"]
    root["pa_type"] = "pumpjack"
    root["pa_spec"] = "C-456-305-144"
    root["pa_bbox_m"] = list(BBOX_TARGET)

    # ---- 统计 ----
    tris, verts, mats = K.mesh_stats(list(joined.values()))

    # ---- 导出 ----
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # Windows 下上一次的句柄没释放会 PermissionError，导出前先清掉
    if os.path.exists(out_path):
        try:
            os.remove(out_path)
        except OSError:
            pass
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
    )

    # ---- 报告 ----
    errs = [abs(size_final[i] - BBOX_TARGET[i]) / BBOX_TARGET[i] * 100 for i in range(3)]
    report = {
        "asset": "pumpjack",
        "spec": "C-456-305-144",
        "lod": lod,
        "id": args["id"],
        "bbox_target_m": list(BBOX_TARGET),
        "bbox_design_m": [round(v, 4) for v in size_design],
        "bbox_final_m": size_final,
        "bbox_min_m": [round(v, 5) for v in mn2],
        "bbox_max_m": [round(v, 5) for v in mx2],
        "calibration_scale": [round(sx, 6), round(sy, 6), round(sz, 6)],
        "error_pct": [round(e, 4) for e in errs],
        "triangles": tris,
        "vertices": verts,
        "materials": sorted(mats),
        "groups": sorted(joined.keys()),
        "file": out_path,
        "file_bytes": os.path.getsize(out_path) if os.path.exists(out_path) else 0,
    }
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    print("\n===== PA_REPORT_BEGIN =====")
    print(txt)
    print("===== PA_REPORT_END =====\n")
    if report_path:
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(txt)


if __name__ == "__main__":
    main()
