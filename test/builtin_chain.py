#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""builtin_chain.py —— 无 CDP 内置面板命令通道的活体驱动 / 验收工具。

以"插件同款协议"拉起 browser_daemon.py（NDJSON over stdio），命令经 9330 命令队列
下发到 DSH 桌面端里的 client.cjs（须已随桌面端运行并在轮询），回收结果。
本脚本主要用来在开发/排障时无 DSH 会话地驱动面板（不依赖 agent 工具层）。

用法（务必用含 playwright 的解释器，推荐 venv3）:
  VENV=/Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3
  $VENV test/builtin_chain.py ping
  $VENV test/builtin_chain.py panel action=state
  $VENV test/builtin_chain.py navigate url=http://127.0.0.1:8799/builtin_probe.html
  $VENV test/builtin_chain.py dom [selector=#app]
  $VENV test/builtin_chain.py evaluate expression=document.title
  $VENV test/builtin_chain.py click selector=#btn
  $VENV test/builtin_chain.py screenshot [selector=#box]
  $VENV test/builtin_chain.py emulate mode=pc | mode=mobile [width=390]
  $VENV test/builtin_chain.py emulate reset=1
  $VENV test/builtin_chain.py back
  $VENV test/builtin_chain.py seq [url=...]        # 整套 M2 链路 + PASS/FAIL 汇总
  $VENV test/builtin_chain.py --takeover ping      # 先杀掉 9330 占用者再跑（会杀插件的守护进程！）

注意：
  - 运行期间 9330 由本脚本的守护进程占用——插件今后台自愈（下次工具调用时重拉）；
  - 脚本退出时会给守护进程发 EOF 收尸（managed Chrome 若开着会被关，面板通道不受影响）。
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DAEMON = os.path.join(ROOT, "lib", "browser_daemon.py")
VENV = "/Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3"
SHOTS = os.path.expanduser("~/.dsh/browser-bridge/shots")
CTRL_PORT = 9330


class Daemon:
    def __init__(self, python_bin, timeout=90):
        self.timeout = timeout
        self.next_id = 1
        self.pending = {}
        self.lock = threading.Lock()
        self.proc = subprocess.Popen(
            [python_bin, DAEMON],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.ready = threading.Event()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                print("  [daemon-raw] %s" % line[:200], file=sys.stderr)
                continue
            if msg.get("type") == "ready":
                self.ready.set()
                continue
            if msg.get("type") == "log":
                print("  [daemon:%s] %s" % (msg.get("level"), msg.get("message")), file=sys.stderr)
                continue
            with self.lock:
                slot = self.pending.pop(msg.get("id"), None)
            if slot is not None:
                slot.append(msg)

    def request(self, op, params=None, timeout=None):
        timeout = timeout or self.timeout
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            slot = []
            self.pending[rid] = slot
        self.proc.stdin.write(json.dumps({"id": rid, "op": op, "params": params or {}}, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if slot:
                msg = slot[0]
                if msg.get("ok"):
                    return msg.get("result")
                raise RuntimeError(msg.get("error") or "unknown daemon error")
            time.sleep(0.05)
        raise TimeoutError("daemon 未在 %ss 内响应 op=%s" % (timeout, op))

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=6)
        except Exception:
            self.proc.terminate()


def port_occupied():
    """9330 是否有「活的」监听者。SO_REUSEADDR：TIME_WAIT 残留不算占用（daemon 自身
    用的是 allow_reuse_address=1 的 HTTPServer，否则刚杀完旧 daemon 会误报）。"""
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.settimeout(1)
    try:
        s.bind(("127.0.0.1", CTRL_PORT))
        return False
    except OSError:
        return True
    finally:
        s.close()


def kill_port_occupant():
    out = subprocess.run(
        ["lsof", "-tnP", "-iTCP:%d" % CTRL_PORT, "-sTCP:LISTEN"],
        capture_output=True, text=True,
    ).stdout.strip()
    if not out:
        return None
    pids = [int(x) for x in out.split("\n") if x.strip().isdigit()]
    for pid in pids:
        try:
            os.kill(pid, 15)
            print("[takeover] 已停掉 9330 占用进程 pid=%d（原插件的守护进程，插件下次工具调用会自愈重拉）" % pid)
        except Exception as exc:
            print("[takeover] kill %d 失败：%s" % (pid, exc), file=sys.stderr)
    time.sleep(0.8)
    return pids


def build_params(op, kv):
    if op == "navigate":
        p = {"url": kv["url"], "timeout_ms": int(kv.get("timeout_ms", 30000))}
    elif op == "evaluate":
        p = {"expression": kv["expression"]}
    elif op == "dom":
        p = ({"selector": kv["selector"]} if kv.get("selector") else {})
    elif op == "click":
        p = {"selector": kv["selector"]}
    elif op == "screenshot":
        p = {}
        if kv.get("selector"):
            p["selector"] = kv["selector"]
    elif op == "emulate":
        if kv.get("reset"):
            p = {"reset": True}
        elif kv.get("mode") == "pc":
            p = {"mobile": False}
        else:
            p = {"mobile": True}
            if kv.get("width"):
                p["width"] = int(kv["width"])
    elif op == "back":
        p = {}
    elif op == "panel":
        p = {"action": kv.get("action", "state")}
        if kv.get("url"):
            p["url"] = kv["url"]
    else:
        raise SystemExit("未知 op：%s" % op)
    if kv.get("target"):
        p["target"] = kv["target"]
    return p


def main():
    ap = argparse.ArgumentParser(description="无 CDP 内置面板命令通道活体驱动")
    ap.add_argument("op")
    ap.add_argument("kv", nargs="*", help="k=v 参数")
    ap.add_argument("--python", default=VENV)
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--shots", default=SHOTS)
    ap.add_argument("--takeover", action="store_true", help="先杀掉 9330 占用者（插件的守护进程）")
    args = ap.parse_args()

    kv = {}
    for item in args.kv:
        k, _, v = item.partition("=")
        kv[k] = v

    if port_occupied():
        if args.takeover:
            kill_port_occupant()
        if port_occupied():
            print("!! 9330 被占用：先停掉插件的守护进程（或加 --takeover）后再跑。", file=sys.stderr)
            return 3

    d = Daemon(args.python, timeout=args.timeout)
    if not d.ready.wait(30):
        print("!! 守护进程 30s 未就绪", file=sys.stderr)
        d.close()
        return 2
    try:
        d.request("config", {"shotsDir": args.shots, "viewportWidth": 390, "viewportHeight": 844}, timeout=10)

        fails = 0

        def wait_client(deadline_s=8):
            """等 client.cjs 首次轮询到本守护进程（消冷启动假失败）。"""
            end = time.time() + deadline_s
            while time.time() < end:
                try:
                    p = d.request("ping", {}, timeout=10)
                except Exception:
                    p = {}
                if p.get("client_alive_s") is not None:
                    return p.get("client_alive_s")
                time.sleep(0.4)
            return None

        def run(label, op, params, expect=None):
            nonlocal fails
            print("\n>>> %s\n    op=%s params=%s" % (label, op, json.dumps(params, ensure_ascii=False)))
            t0 = time.time()
            try:
                res = d.request(op, params)
                print("<<< %.1fs %s" % (time.time() - t0, json.dumps(res, ensure_ascii=False, default=str)[:1800]))
                if expect is not None and not expect(res):
                    print("!!! 期望未满足：%s" % label)
                    fails += 1
                return res
            except Exception as exc:
                print("!!! 失败：%s -> %s" % (label, exc))
                fails += 1
                return None

        if args.op == "seq":
            url = kv.get("url") or "http://127.0.0.1:8799/builtin_probe.html"

            # client 探活前置：等 client.cjs 第一次轮询到本守护进程（最多 10s）
            alive = None
            for _ in range(20):
                try:
                    p = d.request("ping", {}, timeout=10)
                except Exception:
                    p = {}
                alive = p.get("client_alive_s")
                if alive is not None:
                    break
                time.sleep(0.5)
            print("\n>>> 0.preflight: client_alive_s = %s" % alive)
            if alive is None:
                print("!!! client.cjs 未在轮询本守护进程（未装载新版 / 桌面端未开 / 端口被顶替）。")
                print("!!! 中止 seq：先排查 client 装载（普通重启桌面端后重试）。")
                return 4

            run("1.panel.state（前置快照）", "panel", {"action": "state"})
            run("2.navigate（自动开面板+首航）", "navigate",
                {"url": url, "timeout_ms": 30000, "target": "builtin"},
                expect=lambda r: url.rsplit("/", 1)[-1] in (r.get("url") or ""))
            run("3.dom 摘要", "dom", {"target": "builtin"}, expect=lambda r: "探针" in (r.get("text") or ""))
            run("4.evaluate title", "evaluate", {"expression": "document.title", "target": "builtin"},
                expect=lambda r: "探针" in str(r.get("value")))
            w1 = run("5.evaluate innerWidth", "evaluate", {"expression": "window.innerWidth", "target": "builtin"})
            if w1 is not None and not (380 <= int(w1.get("value") or 0) <= 410):
                print("!!! 默认手机视口期望 innerWidth≈390，实际 %s" % w1.get("value"))
            run("6.click #btn", "click", {"selector": "#btn", "target": "builtin"})
            run("7.dom #out", "dom", {"selector": "#out", "target": "builtin"},
                expect=lambda r: "已点击" in (r.get("html") or ""))
            run("8.screenshot", "screenshot", {"target": "builtin"},
                expect=lambda r: (r.get("bytes") or 0) > 1000)
            run("9.screenshot #box", "screenshot", {"selector": "#box", "target": "builtin"},
                expect=lambda r: (r.get("bytes") or 0) > 200)
            run("10.emulate PC", "emulate", {"mobile": False, "target": "builtin"})
            w2 = run("11.eval innerWidth(PC)", "evaluate", {"expression": "window.innerWidth", "target": "builtin"})
            run("12.emulate Mobile", "emulate", {"mobile": True, "width": 390, "target": "builtin"})
            w3 = run("13.eval innerWidth(Mobile)", "evaluate", {"expression": "window.innerWidth", "target": "builtin"})
            if w2 is not None and w3 is not None:
                print("    PC宽=%s → Mobile宽=%s（PC 应更宽，Mobile 应≈390）" % (w2.get("value"), w3.get("value")))
            run("13.5 emulate reset（还原面板原生视口）", "emulate", {"reset": True, "target": "builtin"})
            run("13.6 eval innerWidth(reset 后应为面板全宽)", "evaluate", {"expression": "window.innerWidth", "target": "builtin"})
            run("14.back", "back", {})
            run("15.panel.state（后置快照）", "panel", {"action": "state"})
        elif args.op == "ping":
            run("ping", "ping", {})
        else:
            ca = wait_client()
            print("\n>>> preflight: client_alive_s = %s" % ca)
            if ca is None:
                print("!!! client.cjs 未轮询本守护进程（未装载/桌面端未开）；命令大概率超时报错。")
            params = build_params(args.op, kv)
            run(args.op, args.op, params)

        print("\n== 完成：失败 %d 项 ==" % fails)
        return 1 if fails else 0
    finally:
        d.close()


if __name__ == "__main__":
    sys.exit(main())
