#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""browser_daemon.py —— dsh-browser-bridge 的浏览器守护进程。

由插件的 DaemonClient 以子进程方式启动（stdin/stdout 走 NDJSON，UTF-8），常驻持有：

- **内置浏览器面板通道（默认，builtin）**：把命令入队到 9330 控制端口，由随桌面端
  boot manifest 常驻的客户端扩展（client.cjs）轮询取走、用 webview 原生 API 执行后
  回报——零 CDP、普通重启桌面端即可用；面板未打开时 navigate 会自动打开。
- **托管可见 Chrome（managed，显式指定才用）**：Playwright 持久上下文
  （channel=chrome 系统浏览器，有头，slowMo 放慢便于用户旁观），
  当前活动页（navigate/click/screenshot/dom/evaluate 全部作用于它）。

目标解析：`params.target` 缺省时取 `_GLOBAL_CONFIG['defaultTarget']`（插件配置下发，
默认 **builtin**）——2026-10-13 起默认由 managed 改为 builtin，避免模型不传 target
时习惯性弹出外置 Chrome 窗口做页面调试。

协议（每行一个 JSON 对象）：
  请求:  {"id": 1, "op": "navigate", "params": {...}}
  响应:  {"id": 1, "ok": true, "result": {...}}
       | {"id": 1, "ok": false, "error": "...", "traceback": "...(尾部)"}
  日志:  {"type": "log", "level": "info"|"warn", "message": "..."}
  就绪:  {"type": "ready"}

生命周期：
  - stdin EOF（DSH 退出/插件卸载/进程被杀）→ 关闭浏览器并退出；
  - 浏览器被用户手动关掉 → context 失效，下一次请求自动重新拉起；
  - 登录态靠 profileDir（持久化 user-data-dir）跨会话保留，进程不背登录态。

ops（凡带 `target?` 的：缺省 = `_GLOBAL_CONFIG['defaultTarget']`，当前默认 builtin；见 `Browser._target`）：
  config     应用配置（profileDir/shotsDir/viewport/slowMo/defaultTarget...），幂等
  ping       健康检查
  navigate   {"url, wait_until?, timeout_ms?, target?}      → {url, title, status}
  evaluate   {"expression, target?}                         → {value}
  screenshot {"full_page?, selector?, timeout_ms?, target?} → {path, bytes, url, title}
  dom        {"selector?, max_chars?, target?}              → 摘要或 outerHTML
  click      {"selector, timeout_ms?, target?}              → {clicked, url, title}
  emulate    {"width?, height?, ua?, reset?, target?}       → 设备仿真开关/调参
  back       {"target?}                                     → guest history.back（诊断口）
  attach     {"cdp_port?, url_prefix?, timeout_ms?}         → CDP attach 到 DSH 桌面端（降级通道）
  targets    {"cdp_port?}                                   → 重读 CDP target 清单
  detach     {}                                             → 断开 attach（不杀桌面端）

设计红线（对应插件 README）：
  - 只绑本机：Chrome 由本进程派生，不开放任何远程端口；
  - 凭据不进协议：登录态只在 Chrome profile 里，协议里不传密码/token；
  - 生产系统不自动提交：这是调用方（模型）的纪律，守护进程只提供原语。
"""
import json
import os
import re
import sys
import time
import threading
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

START_TIME = time.time()

# 无 CDP 命令通道（路线 C'）：agent 工具 → 命令队列 → client.cjs 轮询 → webview 原生 API 执行
# 彻底摆脱 --remote-debugging-port 带参重启（普通重启即可用，client.cjs 随桌面端常驻）。
_CMD_LOCK = threading.Lock()
_CMD_PENDING = {}            # cmd_id -> {"op","params","event","result"}
_CMD_TAKEN = set()           # 已被 client 取走、等待回报的 cmd_id
_CMD_WAKE = threading.Event()  # 有新命令入队时唤醒 /cmd/poll 的长轮询
_CMD_SEQ = 0
_CLIENT_LAST_SEEN = 0.0      # client.cjs 最近一次轮询 /cmd/poll 的时间戳（探活用）


def _next_cmd_id():
    global _CMD_SEQ
    _CMD_SEQ += 1
    return "c%d" % _CMD_SEQ


def _safe_title(page):
    try:
        return page.title()
    except Exception:
        return ""


def _jsonable(value):
    """尽量把 evaluate 结果变成可 JSON 序列化的东西；失败退化为 repr。"""
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        try:
            return repr(value)[:2000]
        except Exception:
            return "<unserializable>"


class PlaywrightBuiltin:
    """路线 C 通道 1：面板 target 被 Playwright page 化时的全功能适配（同 managed 能力）。"""

    def __init__(self, page):
        self.page = page

    def alive(self):
        try:
            _ = self.page.url
            return not self.page.is_closed()
        except Exception:
            return False

    def navigate(self, params):
        page = self.page
        resp = page.goto(
            params["url"],
            wait_until=params.get("wait_until", "load"),
            timeout=int(params.get("timeout_ms", 30000)),
        )
        return {"url": page.url, "title": _safe_title(page), "status": resp.status if resp is not None else None}

    def evaluate(self, params):
        return {"value": _jsonable(self.page.evaluate(params["expression"]))}

    def screenshot(self, params):
        page = self.page
        shots_dir = Path(str(self._config("shotsDir", "~/.dsh/browser-bridge/shots"))).expanduser()
        shots_dir.mkdir(parents=True, exist_ok=True)
        path = _shot_path(shots_dir)
        selector = params.get("selector")
        timeout = int(params.get("timeout_ms", 15000))
        if selector:
            page.locator(selector).first.screenshot(path=str(path), timeout=timeout)
        else:
            page.screenshot(path=str(path), full_page=bool(params.get("full_page", False)), timeout=timeout)
        return {"path": str(path), "bytes": path.stat().st_size, "url": page.url, "title": _safe_title(page)}

    def dom(self, params):
        page = self.page
        selector = params.get("selector")
        max_chars = int(params.get("max_chars", 20000))
        if selector:
            html = page.locator(selector).first.evaluate("el => el.outerHTML")
            return {
                "selector": selector,
                "html": html[:max_chars],
                "html_length": len(html),
                "truncated": len(html) > max_chars,
                "url": page.url,
            }
        info = page.evaluate(DOM_SUMMARY_JS)
        text = info.get("text", "") or ""
        info["text"] = text[:max_chars]
        info["text_truncated"] = len(text) > max_chars
        return info

    def click(self, params):
        page = self.page
        timeout = int(params.get("timeout_ms", 15000))
        page.click(params["selector"], timeout=timeout)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        return {"clicked": params["selector"], "url": page.url, "title": _safe_title(page)}

    def emulate(self, params):
        """设备仿真（这条通道同样走 CDP Emulation.*，与 managed / DevTools 口径一致）。

        旧实现只 set_viewport_size（给不了 dpr/touch/Client Hints）；现改走本页的 CDP 会话。
        """
        if params.get("reset"):
            return apply_emulation(self._cdp().send, {}, reset=True)
        return apply_emulation(self._cdp().send, params.get("spec") or {})

    def emulate_reset(self, params):
        return apply_emulation(self._cdp().send, {}, reset=True)

    def _cdp(self):
        """本页的 CDP 会话（惰性创建；页面被换掉时重建）。"""
        if getattr(self, "_cdp_session", None) is None:
            self._cdp_session = self.page.context.new_cdp_session(self.page)
        return self._cdp_session

    def _config(self, key, default):
        # PlaywrightBuiltin 不直接持 config，经外部注入的 getter 兜底
        return _GLOBAL_CONFIG.get(key, default)


class BuiltinSession:
    """路线 C 通道 2：裸 CDP WebSocket（webview/iframe guest 不被 Playwright page 化时的兜底）。

    每个 op 独立连/断 target 的 webSocketDebuggerUrl（无状态、不怕面板导航换世界）；
    click 仅支持 CSS 选择器（无 Playwright 选择器引擎）。
    """

    def __init__(self, ws_url, log=None):
        self.ws_url = ws_url
        self._log = log or (lambda *a, **k: None)
        self._mid = 0

    def command(self, method, params=None, timeout=20):
        from websocket import create_connection  # websocket-client

        ws = None
        try:
            try:
                ws = create_connection(self.ws_url, timeout=timeout, suppress_origin=True)
            except TypeError:
                ws = create_connection(self.ws_url, timeout=timeout)
            self._mid += 1
            mid = self._mid
            ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            deadline = time.time() + timeout
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError("CDP 命令超时：%s" % method)
                ws.settimeout(remaining)
                payload = ws.recv()
                if isinstance(payload, bytes):
                    payload = payload.decode("utf-8", "replace")
                msg = json.loads(payload)
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise RuntimeError("CDP %s 失败：%s" % (method, msg["error"].get("message", msg["error"])))
                    return msg.get("result") or {}
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    def alive(self):
        try:
            self.command("Runtime.evaluate", {"expression": "1", "returnByValue": True}, timeout=4)
            return True
        except Exception:
            return False

    def pipeline(self, steps, timeout=25):
        """同一 CDP 连接内顺序执行多命令。

        nodeId/objectId 只在建立它的那个连接（DOM/Runtime agent 会话）里有效，
        跨连接即失效——凡是「先 getDocument 再 querySelector 再操作节点」这类
        序列必须走本方法。steps: [(method, params), ...]，params 传 callable
        时以之前的结果列表为入参动态生成。
        """
        from websocket import create_connection  # websocket-client

        ws = None
        try:
            try:
                ws = create_connection(self.ws_url, timeout=timeout, suppress_origin=True)
            except TypeError:
                ws = create_connection(self.ws_url, timeout=timeout)
            outs = []
            for mid, (method, params) in enumerate(steps, 1):
                real_params = params(outs) if callable(params) else (params or {})
                ws.send(json.dumps({"id": mid, "method": method, "params": real_params}))
                deadline = time.time() + timeout
                while True:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        raise TimeoutError("CDP 命令超时：%s" % method)
                    ws.settimeout(remaining)
                    payload = ws.recv()
                    if isinstance(payload, bytes):
                        payload = payload.decode("utf-8", "replace")
                    msg = json.loads(payload)
                    if msg.get("id") == mid:
                        if "error" in msg:
                            raise RuntimeError("CDP %s 失败：%s" % (method, msg["error"].get("message", msg["error"])))
                        outs.append(msg.get("result") or {})
                        break
            return outs
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    def _eval(self, expression, timeout=20):
        def run(expr):
            result = self.command(
                "Runtime.evaluate",
                {"expression": expr, "returnByValue": True, "awaitPromise": True},
                timeout=timeout,
            )
            details = result.get("exceptionDetails")
            if details:
                exc = details.get("exception") or {}
                raise RuntimeError("页面执行失败：%s" % (exc.get("description") or details.get("text") or json.dumps(details, ensure_ascii=False)[:300]))
            return (result.get("result") or {})
        result = run(expression)
        if result.get("type") == "function":
            # 传入的是函数体形态（`() => ...` / function）→ 补一次调用；已是 IIFE 的不会进到这里
            result = run("(%s)()" % expression)
        return _jsonable(result.get("value"))

    def url(self):
        return self._eval("location.href") or ""

    def title(self):
        return self._eval("document.title") or ""

    def navigate(self, params):
        url = params["url"]
        timeout_ms = int(params.get("timeout_ms", 30000))
        self.command("Page.navigate", {"url": url}, timeout=timeout_ms / 1000 + 5)
        deadline = time.time() + min(timeout_ms, 45000) / 1000
        while time.time() < deadline:
            try:
                state = self._eval("document.readyState", timeout=5)
            except Exception:
                state = None
            if state == "complete":
                break
            time.sleep(0.3)
        return {"url": self.url(), "title": self.title(), "status": None, "note": "raw-cdp：status 不可知"}

    def evaluate(self, params):
        return {"value": self._eval(params["expression"])}

    def screenshot(self, params):
        shots_dir = Path(str(_GLOBAL_CONFIG.get("shotsDir", "~/.dsh/browser-bridge/shots"))).expanduser()
        shots_dir.mkdir(parents=True, exist_ok=True)
        path = _shot_path(shots_dir)
        cmd = {"format": "png", "captureBeyondViewport": bool(params.get("full_page", False))}
        if params.get("selector"):
            rect_json = self._eval(
                "(() => { const el = document.querySelector(%s); if (!el) throw new Error('未找到元素'); "
                "const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()"
                % json.dumps(params["selector"])
            )
            rect = json.loads(rect_json) if isinstance(rect_json, str) else rect_json
            cmd["clip"] = {"x": rect["x"], "y": rect["y"], "width": rect["w"], "height": rect["h"], "scale": 1}
            cmd["captureBeyondViewport"] = False
        import base64

        data = base64.b64decode(self.command("Page.captureScreenshot", cmd, timeout=30).get("data", ""))
        path.write_bytes(data)
        return {"path": str(path), "bytes": len(data), "url": self.url(), "title": self.title()}

    def dom(self, params):
        selector = params.get("selector")
        max_chars = int(params.get("max_chars", 20000))
        if selector:
            html = self._eval("document.querySelector(%s) ? document.querySelector(%s).outerHTML : ''" % (json.dumps(selector), json.dumps(selector)))
            if not html:
                raise RuntimeError("未找到元素：%s（用不带 selector 的 dom 摘要看看真实结构）" % selector)
            return {"selector": selector, "html": html[:max_chars], "html_length": len(html), "truncated": len(html) > max_chars, "url": self.url()}
        info = self._eval(DOM_SUMMARY_JS)
        text = info.get("text", "") or ""
        info["text"] = text[:max_chars]
        info["text_truncated"] = len(text) > max_chars
        return info

    def emulate(self, params):
        """设备仿真（raw CDP 的 Emulation 域）——与 managed 共用 `apply_emulation`，口径一致。

        本通道（CDP attach 到带参重启的桌面端）是**目前唯一已验证可用**的"内置面板 +
        完美仿真"组合：Emulation 域完备，含 screen 尺寸/朝向/Client Hints。
        """
        if params.get("reset"):
            return self.emulate_reset(params)
        return apply_emulation(lambda m, p=None: self.command(m, p, timeout=15), params.get("spec") or {})

    def emulate_reset(self, params):
        return apply_emulation(lambda m, p=None: self.command(m, p, timeout=15), {}, reset=True)

    def click(self, params):
        selector = params["selector"]
        # 先试真实鼠标事件（更接近真人），失败退回 el.click()
        try:
            center = self._eval(
                "(() => { const el = document.querySelector(%s); if (!el) throw new Error('未找到元素'); "
                "const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()"
                % json.dumps(selector)
            )
            point = json.loads(center) if isinstance(center, str) else center
            for type_ in ("mousePressed", "mouseReleased"):
                self.command(
                    "Input.dispatchMouseEvent",
                    {"type": type_, "x": point["x"], "y": point["y"], "button": "left", "clickCount": 1},
                    timeout=10,
                )
        except Exception:
            self._eval("document.querySelector(%s).click()" % json.dumps(selector))
        try:
            self.command("Runtime.evaluate", {"expression": "1", "returnByValue": True}, timeout=3)
        except Exception:
            pass
        time.sleep(0.2)
        return {"clicked": selector, "url": self.url(), "title": self.title()}


DOM_SUMMARY_JS = """(() => {
    const inputs = [...document.querySelectorAll('input,textarea,select')].slice(0, 40).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        value: el.type === 'password' ? null : (el.value || null)
    }));
    return {
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText : '',
        inputs
    };
})()"""


def _wrap_eval_expression(expr):
    """裸 CDP 的 Runtime.evaluate 只认表达式：函数体形态要补一次调用。"""
    s = (expr or "").strip()
    if re.match(r"^async\b", s) or s.startswith("function") or (s.startswith("(") and "=>" in s):
        return "(%s)()" % s
    return s


def apply_emulation(send, spec, reset=False):
    """把设备规格下发到一条 CDP 通道（`send(method, params)`）。

    与 Chrome DevTools 设备工具栏**同一组命令**；managed（Playwright CDP session）与
    builtin-CDP（attach 降级通道）两条路径共用，保证口径一致：

      Emulation.setDeviceMetricsOverride  视口/mobile/dpr/screen/朝向
      Emulation.setTouchEmulationEnabled  maxTouchPoints / (pointer: coarse) / (hover: none)
      Emulation.setUserAgentOverride      UA + Client Hints（userAgentMetadata）

    实测（test/emulation_probe.py）：iPhone 16 Pro Max 规格下发后，页面侧
    innerWidth/innerHeight=440×956、devicePixelRatio=3、screen=440×956、
    navigator.maxTouchPoints=5、(pointer: coarse) 与 (hover: none) 均命中。
    """
    if reset:
        send("Emulation.clearDeviceMetricsOverride")
        send("Emulation.setTouchEmulationEnabled", {"enabled": False, "maxTouchPoints": 1})
        send("Emulation.setUserAgentOverride", {"userAgent": ""})
        return {"emulated": False, "engine": "cdp"}
    horizontal = spec.get("orientation") == "horizontal"
    width = int(spec["width"])
    height = int(spec["height"])
    touch = bool(spec.get("touch"))
    send("Emulation.setDeviceMetricsOverride", {
        "width": width,
        "height": height,
        "deviceScaleFactor": float(spec.get("dpr") or 1),
        "mobile": bool(spec.get("mobile")),
        "screenWidth": int(spec.get("screenWidth") or width),
        "screenHeight": int(spec.get("screenHeight") or height),
        "positionX": 0,
        "positionY": 0,
        "scale": 1,
        "screenOrientation": {
            "type": "landscapePrimary" if horizontal else "portraitPrimary",
            "angle": 90 if horizontal else 0,
        },
    })
    send("Emulation.setTouchEmulationEnabled", {
        "enabled": touch,
        "maxTouchPoints": 5 if touch else 1,
        "configuration": "mobile" if touch else "desktop",
    })
    if spec.get("ua"):
        params = {"userAgent": spec["ua"]}
        meta = _ua_metadata(spec.get("uaMeta"))
        if meta:
            params["userAgentMetadata"] = meta
        try:
            send("Emulation.setUserAgentOverride", params)
        except Exception:
            # 个别 Chromium 版本对 metadata 字段有强校验 → 退回只覆盖 UA
            send("Emulation.setUserAgentOverride", {"userAgent": spec["ua"]})
    return {
        "emulated": {
            "preset": spec.get("preset"),
            "width": width,
            "height": height,
            "deviceScaleFactor": float(spec.get("dpr") or 1),
            "mobile": bool(spec.get("mobile")),
            "touch": touch,
            "orientation": "horizontal" if horizontal else "vertical",
            "ua": spec.get("ua"),
        },
        "engine": "cdp",
    }


def _ua_metadata(meta):
    """DevTools 的 user-agent-metadata → CDP UserAgentMetadata（brands 交给 Chromium 自行填充）。"""
    if not meta:
        return None
    return {
        "platform": meta.get("platform", ""),
        "platformVersion": str(meta.get("platformVersion", "")),
        "architecture": meta.get("architecture", ""),
        "model": meta.get("model", ""),
        "mobile": bool(meta.get("mobile")),
    }


def _shot_path(shots_dir):
    path = shots_dir / ("%s.png" % time.strftime("%Y%m%d-%H%M%S"))
    seq = 1
    while path.exists():
        seq += 1
        path = shots_dir / ("%s-%d.png" % (time.strftime("%Y%m%d-%H%M%S"), seq))
    return path


# 守护进程级配置快照（PlaywrightBuiltin 的截图目录等取用；config op 时刷新）
_GLOBAL_CONFIG = {}
# 控制端口的 /ui/emulate 需要触碰 Browser（已 attach 的 CDP 会话），由 main() 注入
_UI_BROWSER = None


class Browser:
    """持久上下文单例 + 当前页管理。"""

    def __init__(self):
        self.pw = None
        self.context = None
        self.page = None
        self.config = {}
        # 路线 C：CDP attach 到 DSH 桌面端（内置浏览器面板的 webview guest）——降级备用通道
        self.builtin_browser = None
        self.builtin_session = None
        self.attach_info = None
        # managed 目标的真仿真通道：当前页的 CDP 会话（Emulation.* 唯一入口，见 _cdp_session）
        self.managed_cdp = None
        self.managed_cdp_page = None

    def log(self, level, message):
        print(json.dumps({"type": "log", "level": level, "message": message}, ensure_ascii=False), flush=True)

    def ensure(self):
        """确保持久上下文活着；死了（浏览器被手关/崩溃）就重新拉起。"""
        if self.context is not None:
            try:
                _ = self.context.pages  # 探活
                return
            except Exception:
                self.log("warn", "浏览器上下文已失效，重新拉起 Chrome")
                self.context = None
                self.page = None
        if self.pw is None:
            self.pw = sync_playwright().start()
        cfg = self.config
        profile_dir = Path(str(cfg.get("profileDir", "~/.dsh/browser-bridge/profile"))).expanduser()
        profile_dir.mkdir(parents=True, exist_ok=True)
        viewport = {
            "width": int(cfg.get("viewportWidth", 390)),
            "height": int(cfg.get("viewportHeight", 844)),
        }
        slow_mo = int(cfg.get("slowMoMs", 250))
        self.log(
            "info",
            "启动 Chrome（channel=chrome, profile=%s, viewport=%sx%s, dsf=%s, slowMo=%sms）"
            % (profile_dir, viewport["width"], viewport["height"], cfg.get("deviceScaleFactor", 2), slow_mo),
        )
        self.context = self.pw.chromium.launch_persistent_context(
            str(profile_dir),
            channel="chrome",
            headless=bool(cfg.get("headless", False)),
            viewport=viewport,
            device_scale_factor=float(cfg.get("deviceScaleFactor", 2)),
            slow_mo=slow_mo,
            args=[
                "--window-size=%d,%d" % (viewport["width"] + 80, viewport["height"] + 160),
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        # 首启 profile 可能带出 chrome://welcome 之类的引导页，关掉避免抢"当前页"
        for stale in list(self.context.pages):
            if stale.url.startswith("chrome://") or stale.url.startswith("about:"):
                try:
                    stale.close()
                except Exception:
                    pass
        self.page = None

    def current_page(self):
        self.ensure()
        pages = [p for p in self.context.pages if not p.is_closed()]
        if self.page is not None and not self.page.is_closed() and self.page in pages:
            page = self.page
        elif pages:
            page = self.page = pages[-1]
        else:
            page = self.page = self.context.new_page()
        try:
            page.bring_to_front()
        except Exception:
            pass
        return page

    # ---------- 路线 C：CDP attach（双通道：Playwright page 化 / 裸 CDP） ----------

    def builtin(self):
        """当前内置面板会话（PlaywrightBuiltin 或 BuiltinSession），死了给可读错误。

        注意：这是 **CDP 降级通道**的会话。默认路径（client.cjs 命令通道，见
        `_builtin_dispatch`）不需要 attach，也不经过本方法。
        """
        session = self.builtin_session
        if session is None:
            raise RuntimeError(
                "内置面板的 CDP 降级通道未 attach。默认路径不需要它——请确认桌面端已普通重启"
                "（client 扩展随之装载）、并在内置浏览器面板里打开过一次页面；"
                "仅当需要 CDP 深度调试时才调 browser_attach（那需要带 --remote-debugging-port=9222 重启桌面端）。"
            )
        if not session.alive():
            self.builtin_session = None
            self.builtin_browser = None
            raise RuntimeError(
                "内置浏览器面板的 CDP 连接已失效（面板可能被关闭/重启，或桌面端没带 CDP 参数重启）。"
                "请重新调 browser_attach。"
            )
        return session

    # ---------- 路线 C'：无 CDP 命令通道（client.cjs 常驻宿主，轮询执行） ----------

    def _via_client(self, op, params, timeout=25):
        """把一条内置面板命令交给 client.cjs 执行（经 9330 控制端口的命令队列），等结果。

        - 入队 _CMD_PENDING → client 轮询 /cmd/poll 取走 → 用 webview 原生 API 执行
          → POST /cmd/result 回报 → 本方法拿到结果返回。
        - 完全不需要 CDP 9222 / attach：client.cjs 随桌面端 boot manifest 常驻，
          普通重启即可用。
        """
        if params is None:
            params = {}
        cmd_id = _next_cmd_id()
        evt = threading.Event()
        with _CMD_LOCK:
            _CMD_PENDING[cmd_id] = {"op": op, "params": params, "event": evt, "result": None}
        _CMD_WAKE.set()
        if not evt.wait(timeout):
            with _CMD_LOCK:
                _CMD_PENDING.pop(cmd_id, None)
                _CMD_TAKEN.discard(cmd_id)
            raise RuntimeError(
                "内置面板客户端未在 %.0fs 内回报命令 %s（可能原因：① client 扩展未装载——需普通重启桌面端；"
                "② 面板未打开且自动打开失败；③ 命令本身执行超时）" % (timeout, op)
            )
        with _CMD_LOCK:
            item = _CMD_PENDING.pop(cmd_id, None)
            result = item["result"] if item else None
        if result is None:
            raise RuntimeError("内置面板命令 %s 无结果" % op)
        if not result.get("ok"):
            raise RuntimeError("内置面板执行失败：%s" % (result.get("error") or "未知"))
        return result.get("result") or {}

    def _client_alive(self, window_s=10):
        """最近 window_s 秒内 client.cjs 是否轮询过命令队列（探活，不抛错）。"""
        return time.time() - _CLIENT_LAST_SEEN <= window_s

    def _wait_client(self, timeout_s=3):
        """等 client 首次轮询到本守护进程（消除"守护进程刚起、client 还没轮到"的假失败）。

        正常稳态下 _client_alive() 直接 True（零等待）；仅在守护进程冷启动后的
        头几秒内可能需要等 ≤timeout_s。
        """
        if self._client_alive():
            return True
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            time.sleep(0.12)
            if self._client_alive(window_s=5):
                return True
        return self._client_alive(window_s=5)

    def _builtin_dispatch(self, op, params, timeout=None):
        """内置面板操作：优先走 client 命令通道（无 CDP）；client 不可达时回落已 attach 的 CDP。

        timeout 预算：默认 25s；带 timeout_ms 的命令（navigate/click 等）按页面预算 +
        15s 自动加宽（覆盖首次自动开面板：展开侧栏 + 填地址 + 挂 webview 的开销）。
        """
        if timeout is None:
            timeout = 25
            tms = params.get("timeout_ms") if isinstance(params, dict) else None
            if tms:
                try:
                    timeout = max(timeout, int(tms) / 1000.0 + 15)
                except (TypeError, ValueError):
                    pass
        if self._wait_client():
            return self._via_client(op, params, timeout=timeout)
        if self.builtin_session is not None:
            self.log("warn", "client 通道未探测到，回落 CDP attach 通道执行 %s" % op)
            return getattr(self.builtin(), op)(params)
        raise RuntimeError(
            "内置面板客户端未在线（client 扩展未装载或面板客户端失联）。"
            "请普通重启 DSH 桌面端（无需任何带参），并在内置浏览器面板里打开一次页面后重试。"
        )

    def _cdp_targets(self, port):
        """直读 CDP HTTP 端点的 target 列表（不经 Playwright，含 webview/iframe 与 ws 端点）。"""
        import urllib.request

        with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=5) as resp:
            raw = json.loads(resp.read().decode("utf-8", "replace"))
        targets = []
        for item in raw if isinstance(raw, list) else []:
            targets.append(
                {
                    "id": item.get("id"),
                    "parentId": item.get("parentId"),
                    "type": item.get("type"),
                    "title": (item.get("title") or "")[:120],
                    "url": (item.get("url") or "")[:300],
                    "ws": item.get("webSocketDebuggerUrl"),
                }
            )
        return targets

    def _excluded_target(self, target):
        url = target.get("url") or ""
        if url.startswith(("chrome://", "devtools://", "chrome-extension://")):
            return True
        if re.search(r"127\.0\.0\.1:19387|localhost:19387", url):
            return True  # DSH 主窗口（web GUI 壳）
        if url.startswith("file://") and re.search(r"deepseek|dsh", target.get("title") or "", re.I):
            return True  # DSH 主窗口（file:// 壳）
        if not target.get("ws"):
            return True  # browser/browser_ui 等无 ws 端点的
        return False

    def _select_target(self, targets, url_prefix):
        """从 CDP target 清单里挑"内置浏览器面板"。

        排除 DSH 壳与 chrome:// 内部页；优先级：url_prefix 匹配 > webview/iframe 型
        > 唯一 http(s) 候选 > 唯一候选；再多就宁缺毋滥回清单。
        """
        cands = [t for t in targets if not self._excluded_target(t)]
        if url_prefix:
            matched = [t for t in cands if (t.get("url") or "").startswith(url_prefix)]
            return (matched[0], cands) if matched else (None, cands)
        webviews = [t for t in cands if t.get("type") in ("webview", "iframe")]
        if len(webviews) >= 1:
            return webviews[0], cands
        http_cands = [t for t in cands if (t.get("url") or "").startswith(("http://", "https://"))]
        if len(http_cands) == 1:
            return http_cands[0], cands
        if len(cands) == 1:
            return cands[0], cands
        return None, cands

    def op_attach(self, params):
        """connect_over_cdp 到带参重启的 DSH 桌面端，选中内置浏览器面板。

        双通道：type=page 先试 Playwright page 化（全功能选择器）；webview/iframe 型 target
        完全绕开 Playwright 直走裸 CDP——源码证实 Playwright 不 page 化这类 target
        （`_onAttachedToTarget` 只 page 化 type=page / other+PW_CHROMIUM_ATTACH_TO_OTHER），
        且实测对 Electron connect 的 auto-attach/detach 周期会把面板 guest 搞崩。
        裸 CDP 通道 navigate/evaluate/screenshot/dom/click 全量自实现（click 仅 CSS 选择器）。
        """
        port = int(params.get("cdp_port", 9222))
        url_prefix = params.get("url_prefix")
        targets = self._cdp_targets(port)  # 连不上会在这里抛错
        selected, candidates = self._select_target(targets, url_prefix)
        auto_emu = False
        # 先落 attach_info（webview 分支的自动锁宽依赖 webview_id）
        self.attach_info = {"cdp_port": port, "url_prefix": url_prefix, "targets": targets,
                            "webview_id": selected.get("id") if selected is not None and selected.get("type") in ("webview", "iframe") else None}
        if selected is None:
            return {
                "attached": False,
                "reason": "候选不唯一且无法判定哪个是内置浏览器面板；带 url_prefix 重试，或先在 DSH 里打开内置浏览器面板再 attach",
                "targets": [{k: t[k] for k in ("type", "title", "url")} for t in candidates],
            }
        if selected["type"] in ("webview", "iframe"):
            # 源码定论：Playwright 不 page 化 webview/iframe target，且对 Electron 的
            # connect_over_cdp auto-attach/detach 周期有副作用（实测会把面板 guest 搞崩）
            # → 这类 target 直接走裸 CDP，完全不碰 Playwright。
            # 注：移动端展示/切换现由客户端扩展（client.cjs）全权负责（宿主侧锁宽 + UA），
            # 本通道仅是 CDP 降级备用，不再做宿主 DOM 注入。
            self.builtin_browser = None
            self.builtin_session = BuiltinSession(selected["ws"], log=self.log)
            mode = "raw-cdp"
            pages = []
            # type=page → 先试 Playwright page 化（全功能：playwright 选择器）
            os.environ.setdefault("PW_CHROMIUM_ATTACH_TO_OTHER", "1")
            if self.pw is None:
                self.pw = sync_playwright().start()
            browser = self.pw.chromium.connect_over_cdp(
                "http://127.0.0.1:%d" % port, timeout=int(params.get("timeout_ms", 15000))
            )
            pages = [p for ctx in browser.contexts for p in ctx.pages]
            pw_page = None
            for page in pages:
                if page.url and selected["url"] and page.url.split("#")[0] == selected["url"].split("#")[0]:
                    pw_page = page
                    break
            self.builtin_browser = browser
            if pw_page is not None:
                self.builtin_session = PlaywrightBuiltin(pw_page)
                mode = "playwright"
            else:
                self.builtin_session = BuiltinSession(selected["ws"], log=self.log)
                mode = "raw-cdp"
        self.log("info", "已 attach（%s）→ %s" % (mode, selected["url"]))
        return {
            "attached": True,
            "mode": mode,
            "selected": {"url": selected["url"], "title": selected["title"], "type": selected["type"]},
            "targets": [{k: t[k] for k in ("type", "title", "url")} for t in candidates],
            "playwright_pages": [p.url[:200] for p in pages],
            "hint": "后续工具传 target=builtin 即作用于该页面；面板被关闭/重启后需重新 attach"
            + ("（raw-cdp 模式：click 仅支持 CSS 选择器）" if mode == "raw-cdp" else ""),
        }

    # ---------- 无 CDP 通道专用 op（CDP attach 降级模式无对等能力） ----------

    def op_panel(self, params):
        """面板诊断 / 显式打开：state=宿主态快照；open=确保面板打开（可带 url 发起首航）。

        诊断信息（webviews/地址栏/引导瓦片/bridge stats）只存在于宿主 DOM，故仅走
        client 命令通道；CDP 模式无对等物。
        """
        if not self._wait_client():
            raise RuntimeError(
                "内置面板客户端未在线（client.cjs 未装载/未轮询）。请普通重启 DSH 桌面端后重试。"
            )
        return self._via_client("panel", params, timeout=30)

    def op_back(self, params):
        """面板 guest history.back()（无 CDP 通道专用）。"""
        if not self._wait_client():
            raise RuntimeError(
                "内置面板客户端未在线（client.cjs 未装载/未轮询）。请普通重启 DSH 桌面端后重试。"
            )
        return self._via_client("back", params, timeout=15)

    # ---------- 设备仿真：managed = 真 CDP；builtin = 降级透传 ----------

    def _cdp_session(self, page):
        """取（或建）当前页的 CDP 会话——managed 目标做设备仿真的唯一入口。

        Playwright 的 `set_viewport_size` 只能改视口尺寸，**给不了** dpr / mobile /
        touch / Client Hints，所以这里直接开一条 CDP 会话，用与 Chrome DevTools
        设备工具栏**同一组** `Emulation.*` 命令（见 `_emulate_managed`）。
        """
        if self.managed_cdp is not None and self.managed_cdp_page is page:
            return self.managed_cdp
        if self.managed_cdp is not None:
            try:
                self.managed_cdp.detach()
            except Exception:
                pass
        self.managed_cdp = self.context.new_cdp_session(page)
        self.managed_cdp_page = page
        return self.managed_cdp

    @staticmethod
    def _ua_metadata(meta):
        """（保留为兼容入口，实现已移到模块级 `_ua_metadata`。）"""
        return _ua_metadata(meta)

    def _emulate_managed(self, page, spec, reset=False):
        """managed：CDP `Emulation.*` —— 与 Chrome DevTools 设备工具栏等价。"""
        out = apply_emulation(self._cdp_session(page).send, spec, reset=reset)
        out["url"] = page.url
        return out

    def op_emulate(self, params):
        """设备仿真（口径对齐 Chrome DevTools 设备工具栏）。

        - **managed**：本守护进程直接发 CDP `Emulation.*` → 真仿真（视口/dpr/mobile/touch/Client Hints）。
        - **builtin**：本方法只提供**降级**（把 spec 交给 client.cjs 做 CSS 近似）；桌面端下
          真正的完美仿真由插件层（`lib/electron-emulation.js`）经 Electron 主进程 CDP 完成，
          不经本守护进程——见 index.js 的 `browser_emulate`。
        """
        spec = params.get("spec") or {}
        reset = bool(params.get("reset"))
        if self._target(params) == "builtin":
            if not spec and not reset:
                raise RuntimeError("builtin 仿真需要 spec（机型规格）；请经 browser_emulate 工具调用")
            # ① 已 attach 的 CDP 通道优先：Emulation 域完备 → 与 DevTools 等价（已验证可用）
            try:
                session = self.builtin_session
                if session is not None and session.alive():
                    out = apply_emulation(lambda m, p=None: session.command(m, p, timeout=15), spec, reset=reset)
                    out["engine"] = "cdp-attach"
                    return out
            except Exception as exc:
                self.log("warn", "builtin 仿真改走 CDP attach 失败，回落 client 通道：%s" % exc)
            # ② 无 CDP → client.cjs 的 CSS 近似（降级，调用方需如实标注缺项）
            out = self._builtin_dispatch("emulate", params, timeout=20)
            out["engine"] = out.get("engine") or "css"
            return out
        return self._emulate_managed(self.current_page(), spec, reset=reset)

    def op_client_info(self, params):
        """询问 client.cjs 内置面板的实时句柄（webContents id / URL / 当前仿真态）。

        插件层拿到 webContents id 后，才能用 Electron 主进程的 `webContents.debugger`
        走原生 CDP（无需 --remote-debugging-port 带参重启）。
        """
        if not self._wait_client():
            raise RuntimeError("内置面板客户端未在线（client.cjs 未装载/未轮询）。请普通重启 DSH 桌面端后重试。")
        return self._via_client("info", params or {}, timeout=10)

    def op_targets(self, params):
        """重读 CDP target 清单（attach 前后都可用，用于确认面板开没开）。"""
        port = int(params.get("cdp_port", self.attach_info["cdp_port"] if self.attach_info else 9222))
        targets = self._cdp_targets(port)
        return {
            "cdp_port": port,
            "targets": [{k: t[k] for k in ("type", "title", "url")} for t in targets],
            "webview_count": sum(1 for t in targets if t["type"] == "webview"),
        }

    def op_detach(self, params):
        """断开 attach（不关闭 DSH 桌面端，只断 CDP 连接）。"""
        browser = self.builtin_browser
        self.builtin_browser = None
        self.builtin_session = None
        self.attach_info = None
        if browser is not None:
            try:
                browser.close()  # connect_over_cdp 语义：仅断开，不杀浏览器
            except Exception:
                pass
        return {"detached": True}

    # ---------- ops ----------

    def _target(self, params):
        """解析实际生效的目标：显式 `params.target` > 插件默认 `defaultTarget`（默认 builtin）。

        双保险的第二层：JS 侧（index.js 的 resolveTarget）已把缺省目标注入 params，
        这里再兜一层，保证任何调用路径都不会"静默退回外置 Chrome"。
        """
        target = (params or {}).get("target")
        if target in ("managed", "builtin"):
            return target
        default = str(_GLOBAL_CONFIG.get("defaultTarget") or "builtin").strip()
        return default if default in ("managed", "builtin") else "builtin"

    def op_navigate(self, params):
        if self._target(params) == "builtin":
            return self._builtin_dispatch("navigate", params)
        page = self.current_page()
        resp = page.goto(
            params["url"],
            wait_until=params.get("wait_until", "load"),
            timeout=int(params.get("timeout_ms", 30000)),
        )
        title = _safe_title(page)
        return {"url": page.url, "title": title, "status": resp.status if resp is not None else None}

    def op_evaluate(self, params):
        if self._target(params) == "builtin":
            return self._builtin_dispatch("evaluate", params)
        page = self.current_page()
        value = page.evaluate(params["expression"])
        return {"value": _jsonable(value)}

    def _screenshot_builtin(self, params):
        """内置面板截图：client.cjs 用 webview.capturePage() 拿 PNG，base64 回报，daemon 落盘。

        capturePage 有卡宿主风险 → client 侧已包 6s 超时护栏；失败报可读错误不落盘。
        CDP 通道作为回落（client 不可达且已 attach 时）。
        """
        import base64
        shots_dir = Path(str(_GLOBAL_CONFIG.get("shotsDir", "~/.dsh/browser-bridge/shots"))).expanduser()
        shots_dir.mkdir(parents=True, exist_ok=True)
        if self._client_alive():
            res = self._via_client("screenshot", params, timeout=20)
            b64 = res.get("base64") or ""
            if not b64:
                raise RuntimeError("内置面板截图未返回图片数据（capturePage 可能超时）：%s" % (res.get("error") or "未知"))
            try:
                png = base64.b64decode(b64)
            except Exception as exc:
                raise RuntimeError("内置面板截图 base64 解码失败：%s" % exc)
            path = _shot_path(shots_dir)
            path.write_bytes(png)
            return {"path": str(path), "bytes": len(png), "url": res.get("url") or "", "title": res.get("title") or ""}
        if self.builtin_session is not None:
            return self.builtin().screenshot(params)
        raise RuntimeError("内置面板客户端未在线，截图失败。请普通重启桌面端并在面板里打开过页面后重试。")

    def op_screenshot(self, params):
        if self._target(params) == "builtin":
            return self._screenshot_builtin(params)
        page = self.current_page()
        shots_dir = Path(str(self.config.get("shotsDir", "~/.dsh/browser-bridge/shots"))).expanduser()
        shots_dir.mkdir(parents=True, exist_ok=True)
        path = shots_dir / ("%s.png" % time.strftime("%Y%m%d-%H%M%S"))
        # 同秒多张时加序号避免覆盖
        seq = 1
        while path.exists():
            seq += 1
            path = shots_dir / ("%s-%d.png" % (time.strftime("%Y%m%d-%H%M%S"), seq))
        selector = params.get("selector")
        timeout = int(params.get("timeout_ms", 15000))
        if selector:
            page.locator(selector).first.screenshot(path=str(path), timeout=timeout)
        else:
            page.screenshot(path=str(path), full_page=bool(params.get("full_page", False)), timeout=timeout)
        return {"path": str(path), "bytes": path.stat().st_size, "url": page.url, "title": _safe_title(page)}

    def op_dom(self, params):
        if self._target(params) == "builtin":
            return self._builtin_dispatch("dom", params)
        page = self.current_page()
        selector = params.get("selector")
        max_chars = int(params.get("max_chars", 20000))
        if selector:
            locator = page.locator(selector).first
            html = locator.evaluate("el => el.outerHTML")
            return {
                "selector": selector,
                "html": html[:max_chars],
                "html_length": len(html),
                "truncated": len(html) > max_chars,
                "url": page.url,
            }
        info = page.evaluate(
            """() => {
                const inputs = [...document.querySelectorAll('input,textarea,select')]
                    .slice(0, 40)
                    .map(el => ({
                        tag: el.tagName.toLowerCase(),
                        type: el.type || null,
                        id: el.id || null,
                        name: el.name || null,
                        placeholder: el.placeholder || null,
                        value: el.type === 'password' ? null : (el.value || null)
                    }));
                return {
                    title: document.title,
                    url: location.href,
                    text: document.body ? document.body.innerText : '',
                    inputs
                };
            }"""
        )
        text = info.get("text", "") or ""
        info["text"] = text[:max_chars]
        info["text_truncated"] = len(text) > max_chars
        return info

    def op_click(self, params):
        if self._target(params) == "builtin":
            return self._builtin_dispatch("click", params)
        page = self.current_page()
        selector = params["selector"]
        timeout = int(params.get("timeout_ms", 15000))
        page.click(selector, timeout=timeout)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        return {"clicked": selector, "url": page.url, "title": _safe_title(page)}


HANDLERS = {
    "navigate": Browser.op_navigate,
    "evaluate": Browser.op_evaluate,
    "screenshot": Browser.op_screenshot,
    "dom": Browser.op_dom,
    "click": Browser.op_click,
    "attach": Browser.op_attach,
    "targets": Browser.op_targets,
    "detach": Browser.op_detach,
    "emulate": Browser.op_emulate,
    "panel": Browser.op_panel,
    "back": Browser.op_back,
    "client-info": Browser.op_client_info,
}


def _poll_cmd(block_seconds=2):
    """client 轮询取命令：返回队首未领命令 {id,op,params}，无则 None（带唤醒等待）。"""
    global _CLIENT_LAST_SEEN
    deadline = time.time() + block_seconds
    while True:
        with _CMD_LOCK:
            _CLIENT_LAST_SEEN = time.time()
            for cid, item in _CMD_PENDING.items():
                if cid in _CMD_TAKEN:
                    continue
                _CMD_TAKEN.add(cid)
                return {"id": cid, "op": item["op"], "params": item.get("params") or {}}
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        _CMD_WAKE.wait(min(remaining, 0.5))


def _set_cmd_result(data):
    """client 回报结果：按 id 找到 pending 命令，set result + event 唤醒等待方。"""
    global _CLIENT_LAST_SEEN
    # 长命令执行期间 client 不轮询（单命令串行），回报本身就是"客户端还活着"的铁证——
    # 这里刷新探活时间戳，否则命令刚结束后的后续命令会被 _client_alive 误拒。
    _CLIENT_LAST_SEEN = time.time()
    cid = data.get("id")
    if not cid:
        return
    with _CMD_LOCK:
        item = _CMD_PENDING.get(cid)
        if item is None:
            return
        item["result"] = {"ok": bool(data.get("ok")), "result": data.get("result"), "error": data.get("error")}
        _CMD_TAKEN.discard(cid)
        item["event"].set()


def _start_control_server(port, browser=None):
    """127.0.0.1 控制端口：client.cjs 命令通道（/cmd/poll 取命令、/cmd/result 回报）。

    另有两个**面向面板 UI** 的端点（2026-10-14 加，供机型下拉）：

      GET  /devices     机型表（数据源 = 插件下发的 lib/devices.js，单一数据源）
      POST /ui/emulate  UI 触发的仿真：能用 CDP 就用（完美），否则回 {applied:false} 让前端走 CSS 近似

    仅绑本机回环；端口信任级别 = 本机任意进程可调（与旧 CDP 9222 同级，但只暴露
    命令队列读写 + 机型表 + 仿真下发，不暴露任意执行面）。
    """
    import http.server
    import threading

    global _UI_BROWSER
    _UI_BROWSER = browser

    class Handler(http.server.BaseHTTPRequestHandler):
        def _respond(self, payload, status=200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length).decode("utf-8", "replace") or "{}")

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/cmd/poll":
                # client.cjs 轮询：取走队首未领命令（长轮询：有新命令即唤醒）
                cmd = _poll_cmd(block_seconds=2)
                self._respond({"cmd": cmd})
                return
            if path == "/devices":
                # 面板机型下拉的数据源；表由插件在 config 下发（源自 lib/devices.js）
                self._respond({
                    "devices": _GLOBAL_CONFIG.get("devices") or [],
                    "source": "lib/devices.js（与 Chrome DevTools 设备列表逐字段一致）",
                })
                return
            self._respond({"error": "unknown: %s" % path})

        def do_POST(self):
            path = self.path.split("?")[0]
            if path == "/ui/emulate":
                self._ui_emulate()
                return
            if path != "/cmd/result":
                self._respond({"error": "unknown: %s" % path})
                return
            # client.cjs 回报命令执行结果：{"id":..., "ok":true, "result":...} 或 {"ok":false,"error":...}
            try:
                data = self._read_json()
            except Exception as exc:
                self._respond({"error": "bad body: %s" % exc})
                return
            _set_cmd_result(data)
            self._respond({"received": True})

        def _ui_emulate(self):
            """面板 UI 触发的仿真。

            CDP 可用（已 browser_attach）→ 由 daemon 直接下发 Emulation.*，**完美仿真**；
            否则回 applied=false + 原因，前端据此走自己的 CSS 近似并显示"CSS"徽标。
            """
            try:
                data = self._read_json()
            except Exception as exc:
                self._respond({"applied": False, "engine": "none", "reason": "bad body: %s" % exc})
                return
            browser = _UI_BROWSER
            if browser is None:
                self._respond({"applied": False, "engine": "none", "reason": "daemon 未就绪"})
                return
            try:
                session = browser.builtin_session
                if session is not None and session.alive():
                    apply_emulation(
                        lambda m, p=None: session.command(m, p, timeout=15),
                        data.get("spec") or {},
                        reset=bool(data.get("reset")),
                    )
                    self._respond({"applied": True, "engine": "cdp-attach"})
                    return
                self._respond({
                    "applied": False,
                    "engine": "none",
                    "reason": "无 CDP 通道（未 browser_attach）；dpr / touch / (pointer: coarse) / Client Hints 需 CDP",
                })
            except Exception as exc:
                self._respond({"applied": False, "engine": "none", "reason": "%s: %s" % (type(exc).__name__, exc)})

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()

        def log_message(self, *args):
            pass

    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as exc:
        print(json.dumps({"type": "log", "level": "warn",
                          "message": "控制端口 %d 不可用（%s），内置面板命令通道将不可用" % (port, exc)}, ensure_ascii=False), flush=True)
        return
    threading.Thread(target=srv.serve_forever, daemon=True, name="dsh-bridge-control").start()
    print(json.dumps({"type": "log", "level": "info",
                      "message": "控制端口就绪：http://127.0.0.1:%d（client 命令通道）" % port}, ensure_ascii=False), flush=True)


def handle(browser, msg):
    op = msg.get("op")
    params = msg.get("params") or {}
    if op == "config":
        browser.config = params or {}
        _GLOBAL_CONFIG.clear()
        _GLOBAL_CONFIG.update(browser.config)
        return {"configured": True}
    if op == "ping":
        return {
            "pong": True,
            "uptime_s": round(time.time() - START_TIME, 1),
            "browser_alive": browser.context is not None,
            "client_alive_s": round(time.time() - _CLIENT_LAST_SEEN, 1) if _CLIENT_LAST_SEEN > 0 else None,
        }
    handler = HANDLERS.get(op)
    if handler is None:
        raise ValueError("unknown op: %s（可用：config/ping/%s）" % (op, "/".join(sorted(HANDLERS))))
    return handler(browser, params)


def main():
    browser = Browser()
    # 端口优先级：环境变量（供测试隔离，避免抢生产 9330）> 插件 config 下发 > 默认 9330
    port = int(os.environ.get("DSH_BRIDGE_CONTROL_PORT") or _GLOBAL_CONFIG.get("controlPort", 9330))
    _start_control_server(port, browser)
    print(json.dumps({"type": "ready"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = None
        try:
            msg = json.loads(line)
        except Exception as exc:
            print(json.dumps({"type": "log", "level": "warn", "message": "请求行解析失败: %s" % exc}, ensure_ascii=False), flush=True)
            continue
        rid = msg.get("id")
        try:
            result = handle(browser, msg)
            print(json.dumps({"id": rid, "ok": True, "result": result}, ensure_ascii=False, default=lambda o: repr(o)[:500]), flush=True)
        except Exception as exc:
            detail = "%s: %s" % (type(exc).__name__, exc)
            browser.log("warn", "op=%s 失败: %s" % (msg.get("op"), detail))
            print(
                json.dumps(
                    {"id": rid, "ok": False, "error": detail, "traceback": traceback.format_exc(limit=4)[-1200:]},
                    ensure_ascii=False,
                    default=str,
                ),
                flush=True,
            )
    # stdin EOF：宿主退出/插件卸载 → 收尸退出
    try:
        if browser.builtin_browser is not None:
            try:
                browser.builtin_browser.close()  # connect_over_cdp 语义：仅断开
            except Exception:
                pass
        if browser.context is not None:
            browser.context.close()
        if browser.pw is not None:
            browser.pw.stop()
    except Exception:
        pass


if __name__ == "__main__":
    main()
