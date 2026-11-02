#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板 UI 的两个新端点（GET /devices、POST /ui/emulate）集成测试。

不依赖桌面端：起真守护进程（不 attach、不启浏览器），只验 HTTP 契约：

  1. GET  /devices      → 原样回插件下发的机型表（面板下拉的数据源）
  2. POST /ui/emulate   → 无 CDP 通道时回 applied=false + 可读原因（前端据此走 CSS 近似并显示 CSS 徽标）
  3. OPTIONS /ui/emulate→ 204 + CORS 头（渲染进程从 http(s):// 跨源 POST JSON 必须先过预检）
  4. POST /cmd/result   → 命令回报路径不受影响（防回归）
  5. GET  /未知路径      → 仍回 JSON 错误（不 500）
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
# 用安装脚本建好的通用 venv；可用 DSH_BRIDGE_PYTHON 覆盖
VENV = os.environ.get("DSH_BRIDGE_PYTHON") or str(
    Path.home() / ".dsh" / "browser-bridge" / "venv" / "bin" / "python3"
)
DAEMON = str(ROOT / "lib" / "browser_daemon.py")
PORT = 9333  # 避开生产 9330

# 与 lib/devices.js 同构的两条（只取测试需要的字段）
DEVICES = [
    {
        "order": 10, "title": "iPhone SE", "type": "phone", "default": True,
        "capabilities": ["touch", "mobile"], "dpr": 2,
        "vertical": {"width": 375, "height": 667}, "horizontal": {"width": 667, "height": 375},
        "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Safari/604.1",
        "uaMeta": {"platform": "iOS", "platformVersion": "18.5", "architecture": "", "model": "iPhone", "mobile": True},
    },
    {
        "order": 44, "title": "Laptop with HiDPI screen", "type": "notebook", "default": False,
        "capabilities": [], "dpr": 2,
        "vertical": {"width": 900, "height": 1440}, "horizontal": {"width": 1440, "height": 900},
        "ua": "", "uaMeta": None,
    },
]

env = dict(os.environ, DSH_BRIDGE_CONTROL_PORT=str(PORT))
proc = subprocess.Popen([VENV, DAEMON], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, env=env)


def wait_ready(timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("守护进程启动即退出")
            continue
        msg = json.loads(line)
        if msg.get("type") == "ready":
            return
    raise TimeoutError("守护进程未就绪")


def call(op, params=None, timeout=30):
    proc.stdin.write(json.dumps({"id": 1, "op": op, "params": params or {}}) + "\n")
    proc.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = json.loads(proc.stdout.readline() or "{}")
        if msg.get("type") in ("ready", "log"):
            continue
        if msg.get("id") == 1:
            if not msg.get("ok"):
                raise RuntimeError(msg.get("error"))
            return msg.get("result")
    raise TimeoutError(op)


def http(method, path, body=None, timeout=10):
    url = "http://127.0.0.1:%d%s" % (PORT, path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else None), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, None, dict(exc.headers)


checks = []


def chk(name, ok, detail=""):
    checks.append((ok, name, detail))
    print(("  ✓ " if ok else "  ✗ ") + name + (("（%s）" % detail) if detail else ""))


try:
    wait_ready()
    print("✓ 守护进程就绪（控制端口 %d，由 DSH_BRIDGE_CONTROL_PORT 指定）" % PORT)

    # 模拟插件在就绪阶段下发的 config（含机型表）
    call("config", {"controlPort": PORT, "devices": DEVICES, "defaultTarget": "builtin"})

    status, data, _ = http("GET", "/devices")
    got = (data or {}).get("devices") or []
    chk("GET /devices 返回机型表", status == 200 and len(got) == 2, "status=%s n=%s" % (status, len(got)))
    chk("机型表逐字段保真（title/尺寸/dpr/capabilities/UA/ClientHints）",
        got and got[0].get("title") == "iPhone SE" and got[0].get("dpr") == 2
        and got[0].get("vertical") == {"width": 375, "height": 667}
        and got[0].get("capabilities") == ["touch", "mobile"]
        and "iPhone" in (got[0].get("ua") or "") and (got[0].get("uaMeta") or {}).get("platform") == "iOS",
        str(got[0].get("title") if got else None))
    chk("GET /devices 带数据源说明", "DevTools" in ((data or {}).get("source") or ""))

    status, data, _ = http("POST", "/ui/emulate", {
        "spec": {"preset": "iPhone SE", "orientation": "vertical", "width": 375, "height": 667,
                 "dpr": 2, "mobile": True, "touch": True, "screenWidth": 375, "screenHeight": 667},
    })
    chk("POST /ui/emulate 无 CDP → applied=false（前端走 CSS 近似）",
        status == 200 and (data or {}).get("applied") is False and (data or {}).get("engine") == "none",
        json.dumps(data, ensure_ascii=False)[:90])
    chk("…且给出可读原因（提示 browser_attach / managed）",
        "browser_attach" in ((data or {}).get("reason") or "") or "CDP" in ((data or {}).get("reason") or ""),
        (data or {}).get("reason"))

    status, data, _ = http("POST", "/ui/emulate", {"reset": True})
    chk("POST /ui/emulate reset 同样安全回落", status == 200 and (data or {}).get("applied") is False)

    status, _, headers = http("OPTIONS", "/ui/emulate")
    chk("OPTIONS 预检 → 204 + CORS 允许 POST/JSON",
        status == 204 and headers.get("Access-Control-Allow-Origin") == "*"
        and "POST" in (headers.get("Access-Control-Allow-Methods") or "")
        and "Content-Type" in (headers.get("Access-Control-Allow-Headers") or ""),
        "status=%s allow=%s" % (status, headers.get("Access-Control-Allow-Methods")))

    status, data, headers = http("POST", "/cmd/result", {"id": 999999, "ok": True, "result": {}})
    chk("POST /cmd/result 不回归（未知 id 也 200）",
        status == 200 and (data or {}).get("received") is True, "status=%s" % status)
    chk("响应统一带 CORS 头", headers.get("Access-Control-Allow-Origin") == "*")

    status, data, _ = http("GET", "/nope")
    chk("未知路径回 JSON 错误而非 500", status == 200 and (data or {}).get("error"), str(data)[:60])

    bad = [c for c in checks if not c[0]]
    print("\n" + ("全部通过：UI 端点契约成立" if not bad else "%d 项未达标" % len(bad)))
    sys.exit(1 if bad else 0)
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=15)
    except Exception:
        proc.kill()
    err = ""
    try:
        err = proc.stderr.read() or ""
    except Exception:
        pass
    if err.strip():
        print("\n[daemon stderr]\n" + err.strip()[-1500:])
