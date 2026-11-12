#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
P2 · 公开井位获取与 geo 块生成

数据源（2026-11-03 实测可达）：
  ArcGIS Online 公开 Feature Service
  item : 65ec8999ac1a49ad9241500890c49053
  name : Oil and Gas Well Locations COGCC 2022 Mar 23
  url  : https://services5.arcgis.com/enGOFVOIYC8OyheQ/arcgis/rest/services/
         Oil_and_Gas_Well_Locations_COGCC_2022_Mar_23/FeatureServer/0
  覆盖 : 全州 122,052 条井位点，含 API / Well_Name / Facil_Id / Lat / Lon / Max_MD
  许可 : public（科罗拉多州公开数据）

为什么不走 v4 列的主源：
  ecmc.state.co.us / cogcc.state.co.us / maps1.larimer.org / co.weld.co.us / gis.colorado.gov
  在本机全部 000（DNS 或连接超时）；data.colorado.gov 及其 Socrata API 全部 403。
  ArcGIS Online 可通，且其托管的就是 COGCC 官方 wells shapefile，属等价替代。

关键实现细节（别改）：
  curl 必须 --http1.1。本机代理对 HTTP/2 直接 aborted（curl 56），加了这个开关才稳。

用法：
  python tools/geo_merge.py            # 用缓存（若无缓存则抓取）
  python tools/geo_merge.py --refresh  # 强制重抓
  python tools/geo_merge.py --plot     # 附带生成井位散点图
"""
import os
import sys
import csv
import json
import math
import time
import subprocess
import urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PILOT = os.path.join(ROOT, "09_开源数据平替", "reports",
                     "cogis_pilot_run_40479938455", "pilot")
CACHE_DIR = os.path.join(ROOT, "tools", "geo")
CACHE = os.path.join(CACHE_DIR, "cogcc_wells_raw.json")
OUT = os.path.join(ROOT, "frontend", "src", "data", "geo.json")
BUNDLE = os.path.join(ROOT, "release", "pilot_bundle_final77.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SERVICE = ("https://services5.arcgis.com/enGOFVOIYC8OyheQ/arcgis/rest/services/"
           "Oil_and_Gas_Well_Locations_COGCC_2022_Mar_23/FeatureServer/0/query")
OUT_FIELDS = "API,Well_Name,Facil_Id,Latitude,Longitude,Max_MD,Operator,Loc_Qual,Spud_Date"


# ---------------------------------------------------------------- 抓取

def http_json(url, timeout=120, retries=3):
    last = None
    for i in range(retries):
        r = subprocess.run(
            ["curl", "-sS", "--http1.1", "-m", str(timeout), "-A", UA,
             "-H", "Accept: application/json", url],
            capture_output=True, text=True, encoding="utf-8")
        if r.returncode == 0 and r.stdout.strip():
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError as e:
                last = f"JSONDecodeError: {e} | head={r.stdout[:200]}"
        else:
            last = f"curl rc={r.returncode} err={r.stderr.strip()[:200]}"
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"抓取失败: {last}")


def fetch_wells(apis):
    inlist = ",".join("'%s'" % a for a in apis)
    params = {
        "where": f"API IN ({inlist})",
        "outFields": OUT_FIELDS,
        "returnGeometry": "false",
        "f": "json",
        "resultRecordCount": "2000",
    }
    url = SERVICE + "?" + urllib.parse.urlencode(params)
    d = http_json(url)
    if "error" in d:
        raise RuntimeError(f"服务返回错误: {d['error']}")
    feats = d.get("features", [])
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump({
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "service": SERVICE,
            "n_returned": len(feats),
            "exceeded_transfer_limit": bool(d.get("exceededTransferLimit")),
            "features": feats,
        }, f, ensure_ascii=False, indent=1)
    return feats


def load_raw(apis, refresh=False):
    if os.path.isfile(CACHE) and not refresh:
        with open(CACHE, "r", encoding="utf-8") as f:
            d = json.load(f)
        print(f"[cache] 命中缓存 {d.get('fetched_at')}，{d.get('n_returned')} 条")
        return d["features"]
    print("[net] 抓取中…")
    feats = fetch_wells(apis)
    print(f"[net] 返回 {len(feats)} 条")
    return feats


# ---------------------------------------------------------------- 输入

def load_targets():
    """返回 [(well_id, api8, name, facility_id)]，以 bundle 为准"""
    with open(BUNDLE, "r", encoding="utf-8") as f:
        b = json.load(f)
    fac = {}
    with open(os.path.join(PILOT, "pilot_events_v2c.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            fac[r["api8"]] = r.get("facility_id", "").strip()
    out = []
    for w in b["wells"]:
        api = str(w.get("api") or "").strip()
        out.append((w["well_id"], api, (w.get("name") or "").strip(), fac.get(api, "")))
    return out


# ---------------------------------------------------------------- 匹配

def norm_name(s):
    return "".join(ch for ch in (s or "").upper() if ch.isalnum())


def name_sim(a, b):
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.9
    # 粗粒度：共同前缀占比
    common = 0
    for x, y in zip(a, b):
        if x != y:
            break
        common += 1
    return common / max(len(a), len(b))


def match(feats, targets):
    idx = {}
    for ft in feats:
        a = ft.get("attributes", {})
        api = str(a.get("API") or "").strip()
        if api:
            idx.setdefault(api, a)
    rows = []
    for well_id, api, name, facility in targets:
        a = idx.get(api)
        if not a:
            rows.append({"well_id": well_id, "api": api, "match": "none",
                         "name_bundle": name})
            continue
        sim = name_sim(name, a.get("Well_Name"))
        fac_ok = bool(facility) and str(a.get("Facil_Id") or "") == facility
        if sim >= 0.99:
            kind = "exact"
        elif sim >= 0.6:
            kind = "name_fuzzy"
        else:
            kind = "api_only"
        rows.append({
            "well_id": well_id, "api": api, "match": kind,
            "name_bundle": name, "name_cogcc": a.get("Well_Name"),
            "name_sim": round(sim, 3),
            "facility_bundle": facility,
            "facility_cogcc": a.get("Facil_Id"),
            "facility_ok": fac_ok,
            "lon": a.get("Longitude"), "lat": a.get("Latitude"),
            "max_md_ft": a.get("Max_MD"),
            "operator": a.get("Operator"),
        })
    return rows


# ---------------------------------------------------------------- pad 聚类

# 阈值选 300 m 而非 800 m 的依据（2026-11-03 实测）：
#   300 m : 58 簇，最大簇 4 口，最大跨度  87 m  ← 真实井场
#   500 m : 50 簇，最大簇 12 口，最大跨度 1627 m ← 链式伪聚类开始
#   800 m : 46 簇，最大簇 13 口，最大跨度 1765 m ← 把相邻 pad 连成一片
# 单链接在 300 m 下最大簇跨度仅 87 m ≪ 阈值，无链式效应，可安全使用。
PAD_LINK_M = 300.0


def build_pads(wells):
    """单链接聚类 → pad 分组。返回按「北→南、西→东」稳定排序的列表。"""
    n = len(wells)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        xi, yi = wells[i]["x"], wells[i]["y"]
        for j in range(i + 1, n):
            if math.hypot(xi - wells[j]["x"], yi - wells[j]["y"]) < PAD_LINK_M:
                union(i, j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    pads = []
    for members in groups.values():
        xs = [wells[i]["x"] for i in members]
        ys = [wells[i]["y"] for i in members]
        pads.append({
            "well_ids": sorted(wells[i]["well_id"] for i in members),
            "n": len(members),
            "centroid_x": round(sum(xs) / len(xs), 2),
            "centroid_y": round(sum(ys) / len(ys), 2),
            "span_m": round(max(max(xs) - min(xs), max(ys) - min(ys)), 1),
            "extent": {"x": [round(min(xs), 1), round(max(xs), 1)],
                       "y": [round(min(ys), 1), round(max(ys), 1)]},
        })

    # 稳定编号：北→南（y 降序），同纬度西→东（x 升序）
    pads.sort(key=lambda p: (-p["centroid_y"], p["centroid_x"]))
    for k, p in enumerate(pads, 1):
        p["pad_id"] = f"PAD_{k:03d}"
    return pads


# ---------------------------------------------------------------- 坐标转换

def to_enu(rows):
    """WGS84 → 局部 ENU 米制，原点 = 命中井质心

    公式（局部平面近似，适用于 ≤50 km 范围）：
        x = (lon - lon0) * 111320 * cos(lat0)
        y = (lat - lat0) * 110574
    精度：在 40°N、20 km 范围内，相对误差 < 3e-4（即 < 6 m），
          对井距 ≈300 m 的场景完全够用；不做大地水准面/投影带修正。
    """
    pts = [r for r in rows if r.get("lat") is not None and r.get("lon") is not None]
    if not pts:
        return None, None
    lon0 = sum(r["lon"] for r in pts) / len(pts)
    lat0 = sum(r["lat"] for r in pts) / len(pts)
    lat0_rad = math.radians(lat0)
    kx = 111320.0 * math.cos(lat0_rad)
    ky = 110574.0
    for r in pts:
        r["x"] = round((r["lon"] - lon0) * kx, 2)
        r["y"] = round((r["lat"] - lat0) * ky, 2)
    return {"lon": round(lon0, 6), "lat": round(lat0, 6)}, (kx, ky)


# ---------------------------------------------------------------- 地层

STRATA = [
    {
        "name": "Niobrara",
        "top_m": None, "bottom_m": None,
        "basis": "区域公开柱状图（Denver Basin, Wattenberg Field）；本批 77 口井无单井测井，"
                 "深度区间取自区域文献，非本井实测",
        "source_url": "https://www.searchanddiscovery.com/pdfz/documents/2017/10991sonnenberg/ndx_sonnenberg.pdf.html",
        "depth_status": "pending",   # 待补：文献具体页码数值
    },
    {
        "name": "Codell",
        "top_m": None, "bottom_m": None,
        "basis": "同上，Codell 位于 Niobrara 之下约 30–60 m",
        "source_url": "https://www.searchanddiscovery.com/pdfz/documents/2017/10991sonnenberg/ndx_sonnenberg.pdf.html",
        "depth_status": "pending",
    },
]


# ---------------------------------------------------------------- 输出

def build_geo(rows, origin, scale, coverage, fallback):
    wells = []
    for r in rows:
        if r.get("x") is None:
            continue
        wells.append({
            "api": r["api"], "well_id": r["well_id"],
            "lon": r["lon"], "lat": r["lat"],
            "x": r["x"], "y": r["y"],
            "match": r["match"],
            "facility_ok": r.get("facility_ok"),
            "max_md_ft": r.get("max_md_ft"),
        })

    pads = build_pads(wells) if wells else []

    # 两级尺度范围（供 P6/P7 直接使用，免去再算）
    xs = [w["x"] for w in wells]
    ys = [w["y"] for w in wells]
    max_span = max((max(xs) - min(xs)) if xs else 0, (max(ys) - min(ys)) if ys else 0)
    radius = max((math.hypot(w["x"], w["y"]) for w in wells), default=0.0)
    max_pad_span = max((p["span_m"] for p in pads), default=0.0)

    # 地层：深度未补齐前整层不带 top/bottom，UI 应隐藏该层
    strata = []
    for s in STRATA:
        strata.append({k: v for k, v in s.items() if k != "depth_status"})

    return {
        "source": "COGCC wells shapefile via ArcGIS Online public Feature Service "
                  "(Oil and Gas Well Locations COGCC 2022 Mar 23)",
        "source_url": SERVICE.split("/query")[0],
        "license": "public data, State of Colorado (COGCC/ECMC); 使用声明见 /about",
        "snapshot": "2022-03-23",
        "crs": "EPSG:4326 (输入) → 本地 ENU 米制 (渲染)",
        "origin": origin,
        "enu_scale": {"kx_per_deg_lon": round(scale[0], 2),
                      "ky_per_deg_lat": round(scale[1], 2),
                      "note": "局部平面近似，20 km 内误差 < 6 m"},
        "coverage": round(coverage, 4),
        "method": "API 号（8 位）精确匹配；辅以 Well_Name 相似度与 Facil_Id 交叉校验",
        "cover_method": f"单链接聚类，阈值 {PAD_LINK_M:.0f} m；"
                        f"实测无链式伪聚类（最大簇跨度 {max_pad_span:.0f} m ≪ 阈值）",
        "wells": wells,
        "pads": pads,
        "levels": {
            "L0": {
                "label": "区域视图",
                "extent_m": {"x": [round(min(xs), 1), round(max(xs), 1)] if xs else [0, 0],
                             "y": [round(min(ys), 1), round(max(ys), 1)] if ys else [0, 0]},
                "span_m": round(max_span, 1),
                "fit_radius_m": round(radius, 1),
                "camera_hint": "用 fitToBounds 自适应；参考 pos=(0, 105000, 88000) target=(0,0,0) fov=60",
            },
            "L1": {
                "label": "井场视图",
                "extent_rule": (
                    "自适应三档，按选中井的邻域密度决定："
                    "(a) 多井 pad → pad 跨度 + 100 m 余量（最大 pad 87 m，故约 300 m 见方）；"
                    "(b) 单井 pad 但最近邻 ≤ 2000 m → 扩到包含最近 2 口邻井，上限 2000 m；"
                    "(c) 最近邻 > 2000 m → 固定 1000 m 见方，UI 标注「附近无邻近井」"
                ),
                "size_m_default": 300,
                "size_m_max": 2000,
                "vertical_m": -4000,
                "vertical_basis": "真实 MD 中位 8000–12000 ft ≈ 2400–3650 m，取 -4000 m 留余量",
                "origin_rule": "多井 pad 用 pad 质心；单井/稀疏用选中井本身作原点",
                "vertical_exaggeration": 1.0,
                "ve_note": "真实比例下井筒细长属正常；若可视性不足，P7 可调 VE 并在画面标注倍数",
                "pad_stats": {
                    "n_pads": len(pads),
                    "n_single": sum(1 for p in pads if p["n"] == 1),
                    "n_multi": sum(1 for p in pads if p["n"] > 1),
                    "multi_wells": sum(p["n"] for p in pads if p["n"] > 1),
                    "max_pad_span_m": round(max_pad_span, 1),
                },
            },
        },
        "strata": strata,
        "fallback": fallback,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def report(rows, coverage):
    n = len(rows)
    from collections import Counter
    c = Counter(r["match"] for r in rows)
    fac = sum(1 for r in rows if r.get("facility_ok"))
    xs = [r["x"] for r in rows if r.get("x") is not None]
    ys = [r["y"] for r in rows if r.get("y") is not None]
    print("\n" + "=" * 62)
    print("P2 井位匹配报告")
    print("=" * 62)
    print(f"目标井数        : {n}")
    print(f"命中(任意匹配)  : {c.get('exact',0)+c.get('name_fuzzy',0)+c.get('api_only',0)}"
          f"  coverage={coverage:.4f}")
    print(f"  exact(名字全等): {c.get('exact',0)}")
    print(f"  name_fuzzy     : {c.get('name_fuzzy',0)}")
    print(f"  api_only       : {c.get('api_only',0)}")
    print(f"  none           : {c.get('none',0)}")
    print(f"Facil_Id 交叉验证: {fac}/{n} 一致")
    if xs:
        print(f"ENU 范围        : x [{min(xs):.0f}, {max(xs):.0f}] m, "
              f"y [{min(ys):.0f}, {max(ys):.0f}] m")
        print(f"最大跨度        : {max(xs)-min(xs):.0f} × {max(ys)-min(ys):.0f} m")
    print(f"fallback        : {coverage < 0.9}")
    print("=" * 62)


def report_pads(pads):
    if not pads:
        return
    sizes = sorted((p["n"] for p in pads), reverse=True)
    single = sum(1 for p in pads if p["n"] == 1)
    maxpad = max(pads, key=lambda p: p["n"])
    print("\n" + "=" * 62)
    print("pad 分组（两级尺度的 L1 单位）")
    print("=" * 62)
    print(f"pad 数          : {len(pads)}（阈值 {PAD_LINK_M:.0f} m）")
    print(f"规模分布        : {sizes}")
    print(f"单井 pad        : {single} 个（{single/len(pads):.0%}）")
    print(f"最大 pad        : {maxpad['pad_id']}，{maxpad['n']} 口，跨度 {maxpad['span_m']:.0f} m")
    print(f"多井 pad        : {len(pads)-single} 个，覆盖 "
          f"{sum(p['n'] for p in pads if p['n']>1)} 口井")
    print("=" * 62)


def _png_write(path, w, h, canvas):
    """最小 PNG 编码器（RGB8，无依赖）。canvas: bytearray，长度 = h*(1+3w)"""
    import zlib
    import struct

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(canvas), 9)))
        f.write(chunk(b"IEND", b""))


def plot(rows, path):
    """井位散点图 · 纯标准库实现（不依赖 Pillow / matplotlib）

    画布：白底 + 边框 + 10 km 网格；点色区分匹配等级。
    无文字渲染（不引入字体），图例以色块呈现，含义：
        红=exact  橙=name_fuzzy  蓝=api_only  灰=孤立单井
    """
    pts = [r for r in rows if r.get("x") is not None]
    if not pts:
        print("[plot] 跳过：无坐标")
        return

    W, H, pad = 1000, 820, 70
    xs = [r["x"] for r in pts]
    ys = [r["y"] for r in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)

    # 等比例缩放，居中
    s = min((W - 2 * pad) / max(maxx - minx, 1.0), (H - 2 * pad) / max(maxy - miny, 1.0))
    offx = (W - (maxx - minx) * s) / 2
    offy = (H - (maxy - miny) * s) / 2

    stride = 1 + 3 * W
    canvas = bytearray(b"\xff" * (stride * H))

    def put(px, py, rgb):
        if 0 <= px < W and 0 <= py < H:
            i = py * stride + 1 + px * 3
            canvas[i:i + 3] = bytes(rgb)

    def dot(cx, cy, r, rgb):
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if dx * dx + dy * dy <= r * r:
                    put(cx + dx, cy + dy, rgb)

    def hline(y, x0, x1, rgb):
        for x in range(max(0, x0), min(W, x1)):
            put(x, y, rgb)

    def vline(x, y0, y1, rgb):
        for y in range(max(0, y0), min(H, y1)):
            put(x, y, rgb)

    def to_px(x, y):
        px = int(offx + (x - minx) * s)
        py = int(H - offy - (y - miny) * s)
        return px, py

    # 10 km 网格
    grid = (232, 232, 232)
    gx = math.ceil(minx / 10000.0) * 10000
    while gx <= maxx:
        px, _ = to_px(gx, miny)
        vline(px, 0, H, grid)
        gx += 10000
    gy = math.ceil(miny / 10000.0) * 10000
    while gy <= maxy:
        _, py = to_px(minx, gy)
        hline(py, 0, W, grid)
        gy += 10000

    # 孤立井识别（最近邻 > 3 km）
    nn = []
    for i, a in enumerate(pts):
        d = min(math.hypot(a["x"] - b["x"], a["y"] - b["y"])
                for j, b in enumerate(pts) if j != i) if len(pts) > 1 else 0.0
        nn.append(d)

    colors = {"exact": (200, 40, 40), "name_fuzzy": (230, 150, 30), "api_only": (60, 110, 200)}
    for a, d in zip(pts, nn):
        c = (150, 150, 150) if d > 3000 else colors.get(a["match"], (100, 100, 100))
        px, py = to_px(a["x"], a["y"])
        dot(px, py, 5, c)

    # 边框
    border = (120, 120, 120)
    hline(pad // 3, pad // 3, W - pad // 3, border)
    hline(H - pad // 3, pad // 3, W - pad // 3, border)
    vline(pad // 3, pad // 3, H - pad // 3, border)
    vline(W - pad // 3, pad // 3, H - pad // 3, border)

    # 左上角图例色块
    legend = [((200, 40, 40), "exact"), ((230, 150, 30), "fuzzy"),
              ((60, 110, 200), "api_only"), ((150, 150, 150), "isolated")]
    for i, (c, _) in enumerate(legend):
        dot(28 + i * 26, 25, 6, c)

    _png_write(path, W, H, canvas)
    print(f"[plot] 已保存 {os.path.relpath(path, ROOT)}  "
          f"({W}x{H}, {len(pts)} wells, span {maxx-minx:.0f}x{maxy-miny:.0f} m, "
          f"isolated={sum(1 for d in nn if d>3000)})")


def _unused_pil_plot(rows, path):
    """保留 Pillow 版本，装得上时可用（含文字标注）"""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[plot] 跳过：未安装 Pillow")
        return
    pts = [r for r in rows if r.get("x") is not None]
    if not pts:
        print("[plot] 跳过：无坐标")
        return
    W, H, pad = 900, 700, 60
    xs = [r["x"] for r in pts]
    ys = [r["y"] for r in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    sx = (W - 2 * pad) / max(maxx - minx, 1)
    sy = (H - 2 * pad) / max(maxy - miny, 1)
    s = min(sx, sy)
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([pad, pad, W - pad, H - pad], outline=(180, 180, 180))
    colors = {"exact": (200, 40, 40), "name_fuzzy": (230, 150, 30), "api_only": (60, 110, 200)}
    for r in pts:
        px = pad + (r["x"] - minx) * s + (W - 2 * pad - (maxx - minx) * s) / 2
        py = H - pad - (r["y"] - miny) * s - (H - 2 * pad - (maxy - miny) * s) / 2
        c = colors.get(r["match"], (100, 100, 100))
        d.ellipse([px - 4, py - 4, px + 4, py + 4], fill=c)
    d.text((pad, 20), f"Weld County - {len(pts)} wells (ENU, meter)  "
                      f"red=exact orange=fuzzy blue=api_only", fill=(0, 0, 0))
    d.text((W - 220, H - 35), f"span {maxx-minx:.0f} x {maxy-miny:.0f} m", fill=(80, 80, 80))
    img.save(path)
    print(f"[plot] 已保存 {os.path.relpath(path, ROOT)}")


def main():
    refresh = "--refresh" in sys.argv
    do_plot = "--plot" in sys.argv

    targets = load_targets()
    apis = [t[1] for t in targets if t[1]]
    print(f"目标井 {len(targets)} 口，API 有效 {len(apis)} 个")

    feats = load_raw(apis, refresh)
    rows = match(feats, targets)
    n_hit = sum(1 for r in rows if r["match"] != "none")
    coverage = n_hit / len(rows) if rows else 0.0

    origin, scale = to_enu(rows)
    if origin is None:
        print("!! 无任何坐标命中，写 fallback 占位")
        origin, scale = {"lon": None, "lat": None}, (0, 0)

    fallback = coverage < 0.9
    geo = build_geo(rows, origin, scale, coverage, fallback)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False, indent=1)

    report(rows, coverage)
    report_pads(geo["pads"])
    print(f"已写入 {os.path.relpath(OUT, ROOT)}")
    if do_plot:
        plot(rows, os.path.join(CACHE_DIR, "well_locations.png"))

    # 供 P1 合并；同时落一份匹配明细便于审计
    detail = os.path.join(CACHE_DIR, "match_detail.json")
    with open(detail, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
