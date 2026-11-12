# -*- coding: utf-8 -*-
"""gh_run.py —— 推文件到 GitHub → 触发 workflow → 轮询 → 下载 artifact。

只用标准库（urllib），不装依赖。token 从 `~/.gse/gh_token.txt` 读，绝不打印。

用法
----
    python tools/gh_run.py --workflow cogis_pilot.yml \
        --file scripts/pilot_cogcc.py \
        --input n_wells=120 --input pool=400 --input years=2014-2025

    python tools/gh_run.py --workflow cogis_pilot.yml --no-push   # 只触发
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

REPO = "g1914y/gse-ndic-probe"
API = f"https://api.github.com/repos/{REPO}"
TOK = (Path.home() / ".gse" / "gh_token.txt").read_text(encoding="utf-8").strip()
LOCAL_ROOT = Path(__file__).resolve().parents[1] / "09_开源数据平替"
REPORT_ROOT = Path(__file__).resolve().parents[1] / "09_开源数据平替" / "reports"


def _req(url: str, method: str = "GET", body: dict | None = None,
         raw: bytes | None = None, timeout: int = 60, allow_redirect: bool = True,
         auth: bool = True):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    elif raw is not None:
        data = raw
    r = urllib.request.Request(url, data=data, method=method)
    if auth:
        r.add_header("Authorization", f"Bearer {TOK}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("X-GitHub-Api-Version", "2022-11-28")
    r.add_header("User-Agent", "gse-gh-run")
    if data is not None:
        r.add_header("Content-Type", "application/json; charset=utf-8")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = (urllib.request.build_opener()
              if allow_redirect else urllib.request.build_opener(NoRedirect))
    with opener.open(r, timeout=timeout) as resp:
        return resp.status, dict(resp.headers), resp.read()


def push_file(rel: str, verbose: bool = True) -> bool:
    src = LOCAL_ROOT / rel
    if not src.exists():
        print(f"[push] 跳过（本地不存在）{rel}")
        return False
    text = src.read_text(encoding="utf-8")
    url = f"{API}/contents/{rel}"
    try:
        _, _, raw = _req(url)
        cur = json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        cur = {"sha": None, "content": None}
    if cur.get("content"):
        remote = base64.b64decode(cur["content"].replace("\n", "")).decode("utf-8")
        if remote.rstrip() == text.rstrip():
            print(f"[push] {rel} 远端已是最新，跳过")
            return False
    body = {"message": f"chore: update {rel}",
            "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
            "branch": "main"}
    if cur.get("sha"):
        body["sha"] = cur["sha"]
    _, _, raw = _req(url, "PUT", body=body)
    print(f"[push] 已推送 {rel} → {json.loads(raw)['content']['sha'][:12]}…")
    return True


def latest_run_id(workflow: str) -> int:
    _, _, raw = _req(f"{API}/actions/workflows/{workflow}/runs?per_page=1")
    runs = json.loads(raw).get("workflow_runs", [])
    return int(runs[0]["id"]) if runs else 0


def trigger(workflow: str, inputs: dict) -> None:
    _req(f"{API}/actions/workflows/{workflow}/dispatches", "POST",
         body={"ref": "main", "inputs": inputs})
    print(f"[trigger] {workflow} inputs={inputs}")


def wait_run(workflow: str, prev_id: int, timeout_s: int = 1800,
             poll: int = 15) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        _, _, raw = _req(f"{API}/actions/workflows/{workflow}/runs?per_page=5")
        for r in json.loads(raw).get("workflow_runs", []):
            if int(r["id"]) > prev_id:
                print(f"[wait] run {r['id']} status={r['status']}")
                if r["status"] == "completed":
                    return r
                break
        time.sleep(poll)
    raise TimeoutError(f"等 workflow 超时（{timeout_s}s）")


def download_artifacts(run_id: int, out_dir: Path) -> None:
    _, _, raw = _req(f"{API}/actions/runs/{run_id}/artifacts")
    arts = json.loads(raw).get("artifacts", [])
    out_dir.mkdir(parents=True, exist_ok=True)
    for a in arts:
        url = a["archive_download_url"]
        try:
            _, hdr, _ = _req(url, allow_redirect=False)
        except urllib.error.HTTPError as e:
            if e.code not in (302, 301):
                print(f"[art] {a['name']} 失败 {e.code}")
                continue
            hdr = dict(e.headers)
        loc = hdr.get("Location")
        if not loc:
            print(f"[art] {a['name']} 未取到重定向")
            continue
        # 重定向目标是 Azure blob 的 SAS 链接：不能再带 GitHub 的 Authorization，
        # 否则 Azure 返回 401「Server failed to authenticate the request」。
        _, _, blob = _req(loc, auth=False)
        with zipfile.ZipFile(BytesIO(blob)) as z:
            z.extractall(out_dir)
        print(f"[art] {a['name']}  {len(blob):,} B → {out_dir}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", default="cogis_pilot.yml")
    ap.add_argument("--file", action="append", default=[], help="要推送的相对路径（可多次）")
    ap.add_argument("--input", action="append", default=[], help="k=v，可多次")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--no-wait", action="store_true")
    ap.add_argument("--out", default="", help="artifact 落盘目录，默认 reports/<workflow>_run_<id>")
    ap.add_argument("--only-download", type=int, default=0,
                    help="只下载指定 run 的产物，不推送不触发")
    a = ap.parse_args(argv)

    if a.only_download:
        out = Path(a.out) if a.out else REPORT_ROOT / f"{a.workflow.replace('.yml','')}_run_{a.only_download}"
        download_artifacts(a.only_download, out)
        print(f"\n证据目录: {out}")
        for p in sorted(out.rglob("*")):
            if p.is_file():
                print(f"  {p.relative_to(out)}  {p.stat().st_size:,} B")
        rep = out / "pilot" / "pilot_report.md"
        if rep.exists():
            print("\n=== pilot_report.md ===")
            print(rep.read_text(encoding="utf-8"))
        return 0

    prev = latest_run_id(a.workflow)
    print(f"[0] 触发前最新 run = {prev}")

    if not a.no_push:
        for f in a.file:
            push_file(f)
    else:
        print("[push] 已跳过")

    inputs = {}
    for kv in a.input:
        k, _, v = kv.partition("=")
        inputs[k] = v
    trigger(a.workflow, inputs)

    if a.no_wait:
        return 0
    run = wait_run(a.workflow, prev)
    print(f"[wait] conclusion={run['conclusion']}")
    if run["conclusion"] != "success":
        print("[!] 非 success，artifact 仍会尽量下载")

    out = Path(a.out) if a.out else REPORT_ROOT / f"{a.workflow.replace('.yml','')}_run_{run['id']}"
    download_artifacts(int(run["id"]), out)
    print(f"\n证据目录: {out}")
    for p in sorted(out.rglob("*")):
        if p.is_file():
            print(f"  {p.relative_to(out)}  {p.stat().st_size:,} B")
    rep = out / "pilot" / "pilot_report.md"
    if rep.exists():
        print("\n=== pilot_report.md ===")
        print(rep.read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
