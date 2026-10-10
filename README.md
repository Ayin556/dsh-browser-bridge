# dsh-browser-bridge

给 agent 的浏览器控制插件（DSH server 侧）：注册 `browser_navigate / browser_evaluate /
browser_screenshot / browser_dom / browser_click` 五个操作工具 + `browser_attach`（CDP
降级备用）+ `browser_emulate`（设备仿真）。两个操作目标：

- **`managed`（默认）**：驱动一个**用户可见**的持久 Chrome（Playwright，有头、slowMo 放慢、
  持久 profile 登录态跨会话保留）——用户全程旁观、可中断；
- **`builtin`**：驱动 **DSH 桌面端内置浏览器面板**（右侧栏那个，用户可见）。
  **2026-10-10 v5 定稿：无 CDP 命令通道——普通启动/重启桌面端即可用，无需任何启动参数、
  无需 attach；面板未打开时 navigate 会自动打开。** 设备仿真（手机视口/UA）由随桌面端
  常驻的客户端扩展（`lib/client.cjs`）默认管理。

> 需求源与设计决策：`~/deepseekharness工作区/dsh-browser-control/开发交接卡.md`。
> 权威踩坑实录与历次接力的全部细节：
> `~/.aiconfig/project-overlays/deepseekharness/kb/dsh-browser-bridge/内置浏览器调试能力.md`。
> 开发/排障活体驱动工具：`test/builtin_chain.py`（下文「自测」节）。

## 工具一览

| 工具 | 作用 | 备注 |
|---|---|---|
| `browser_navigate(url)` | 打开 URL | managed=托管 Chrome；builtin=内置面板（未打开时**自动打开**并首航） |
| `browser_dom(selector?)` | 页面摘要（标题/可见文本/**输入框清单**）或元素 outerHTML | 登录页直接拿表单结构；密码框 value 永不回传 |
| `browser_evaluate(expression)` | 页面里执行 JS，返回 JSON | 表达式或 `() => {...}` 函数体；Promise 自动等待 |
| `browser_click(selector)` | 点击（CSS 选择器） | 点击后返回新 URL/标题 |
| `browser_screenshot(full_page?\|selector?)` | 截图落盘返回绝对路径 | 需要看图时模型再调 `read_image`；builtin 目标支持 selector 元素截图 |
| `browser_attach(cdp_port?, url_prefix?)` | **【降级备用，一般不用】** CDP attach 到**带参重启**的 DSH 桌面端 | 仅在需要 CDP 深度调试时用；日常 builtin 无需它 |
| `browser_emulate(…)` | 设备仿真开关/调参（宽度/UA/reset） | builtin 默认已是手机视口（390 锁宽 + 移动 UA）；managed 等价于调视口 |

所有工具带可选 `target`：`managed`（默认）｜`builtin`（内置面板，**普通重启即可用**）。

典型链路：`navigate → dom（找表单/元素）→ click/evaluate（操作）→ screenshot（回证）`。
选择器选不中先用 `browser_dom` 看真实结构。

## 内置面板通道（builtin）——怎么工作的（v5 定稿）

```
agent 工具（server 侧）
  → daemon 命令队列（9330 控制端口，仅绑 127.0.0.1）
  → client.cjs（随桌面端 boot manifest 常驻宿主的客户端扩展）200ms 轮询取命令
  → 用 <webview> 原生 API（executeJavaScript / capturePage / loadURL / setUserAgent…）执行
  → POST /cmd/result 回报 → daemon 回给 agent
```

要点与设计决定（全部实测）：

- **零 CDP**：不再需要 `--remote-debugging-port=9222` 带参重启；9222 只保留给
  `browser_attach` 降级通道；
- **自动开面板**：无 webview 且无地址栏时，navigate 自动把面板开出来——优先官方
  `sidebarRight` 服务（`commandTarget` + `openTabFromTarget`，**必须先展开再取新鲜
  target**，见踩坑 #18），并叠加 DOM 回退（点 `[data-sidebar-right-expand]` 展开 +
  点 `button[data-sidebar-right-guide-entry="browser"]` 引导瓦片，均为官方稳定 data-* 钩子）；
- **首航**：面板浏览器标签的地址栏用「native setter + input 事件 + 点前往按钮」驱动
  （合成 Enter 不触发提交）；webview 挂载后命令导航走 `loadURL`；
- **导航自愈（v5.3.4）**：`loadURL` 的 Promise 与实际导航状态在高竞态下会分叉
  （面板重启自恢复导航/地址栏首航相遇 → ERR_ABORTED/(-3)）——被顶掉不报错，轮询自愈
  （3s 补发一次）；成功判据="目标被加载 或 页面已离开原址"；deadline 兜底返回实况；
- **UA 修正（v5.3）**：命令流首航可能赶在 `setUserAgent` 之前发出（扫描节流竞态）——
  导航完成后在安全时机补设移动 UA 并 reload 一次（此后不再触发）；agent 自动开的
  webview 跳过「用户流首挂自动 reload」（`__dshBridgeSuppressNext`，防首航竞态）；
- **超时护栏铁律**：所有 webview API 调用一律包 `Promise.race` 超时（capturePage 6s、
  evaluate 20s、loadURL 30s），失败回报可读错误，绝不让宿主挂起；
- **诊断口**：`browser_navigate` 的 daemon 侧另有 `panel`（宿主态快照：webviews/地址栏/
  引导瓦片/bridge stats）与 `back`（guest history.back）两个 op，经
  `test/builtin_chain.py panel action=state` 等直调，排障专用。

## 客户端扩展：设备仿真 + 命令通道（`lib/client.cjs`）

经 package.json 声明（`exports["./client"]` + `dsh.client={platform:"web",inject:[]}`）
进桌面 boot manifest，**桌面端默认启动即常驻**，零 CDP、零守护进程依赖：

- **命令通道 v5**：200ms 轮询 9330 `/cmd/poll` 执行 agent 命令（上一节）；fetch 全量超时
  护栏；`panel` 诊断 op；
- **设备仿真 v4**：每个 `webview[data-sidebar-browser-frame]` 独立一份 🖥/📱 切换钮
  （expando 引用 + class 定位）；📱 = 390 锁宽（width/maxWidth/minWidth/flex 全锁）+
  移动 UA（Pixel 8 / Chrome124 Mobile）；🖥 = 还原原 UA + 全宽；用户点击切换 reload
  立即生效；agent 经 `browser_emulate` 驱动时只换 UA 不 reload（不打断会话流程）；
- **模拟 APP 导航栏默认关闭**（`SHOW_APPBAR=false`，用户裁决：视觉噪音），要真机观感改 true；
- **防冻三件套**：observer 100ms 节流队列 + 全局 `RELOAD_CAP=10` 熔断 + 诊断仪表
  `window.__dshBridgeStats={scans,applyChrome,creates,reloads}`；
  ⚠ 冻结红线：observer 链上 textContent/insertBefore/appendChild 一律先比较后写（踩坑 #14）。

## 架构：为什么是 Node 插件 + Python 守护进程（零安装）

```
DSH server (cordis)                      venv3 Python
└─ lib/index.js（本插件，7 工具）  ──NDJSON(stdio)──▶  lib/browser_daemon.py
   DaemonClient：懒启动/断线重启/超时              ├─ Playwright 持久上下文（channel=chrome 系统浏览器，有头）
                                                    ├─ 9330 控制端口：/cmd/poll + /cmd/result（内置面板命令队列）
                                                    └─ CDP attach 降级通道（browser_attach 用，平时闲置）
桌面端另挂客户端扩展 lib/client.cjs（boot manifest 加载，纯宿主 DOM + 命令通道，见上节）
```

- **运行时零安装**：不引 npm 依赖、不下浏览器二进制——Playwright 1.61 已在 venv3，
  `channel:"chrome"` 规避版本匹配问题；
- **单例 + 跨轮次复用**：守护进程随插件进程常驻（挂载即急启），会话轮次之间浏览器不关；
- **自愈**：用户手动关掉浏览器 → 下一次工具调用自动重拉（登录态在 profile 里，不丢）；
- **收尸**：DSH 退出/插件卸载 → 守护进程 stdin EOF → 关浏览器退出，零残留。

## 安装（2026-10-09 已落地的三处登记，两 profile 各一套）

```sh
# 1. profile 的依赖软链（web + desktop 都已做）
ln -sfn ~/deepseekharness工作区/dsh-browser-bridge ~/.dsh/profiles/<profile>/node_modules/dsh-browser-bridge
# 2. profile 的 package.json：dependencies 加 link: + dsh.profile.bundles 加包名（已做）
# 3. 插件自身的 node_modules/@deepseek-ai 软链到共享层（已做）
```

生效：重启桌面端（普通启动即可，v5 起**无需任何参数**）。bundle 解析可用
`dsh --profile web --dump-config` 验证（`- id: browser-bridge` 正确插入）。

## 配置（写进 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖）

```yaml
- id: browser-bridge
  name: dsh-browser-bridge
  config:
    pythonBin: /Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3
    profileDir: ~/.dsh/browser-bridge/profile   # 登录态存这里（托管 Chrome）
    shotsDir: ~/.dsh/browser-bridge/shots       # 截图输出
    viewportWidth: 390        # 托管 Chrome 视口（内置面板的手机视口由 client 扩展管理）
    viewportHeight: 844
    deviceScaleFactor: 2
    slowMoMs: 250             # 动作放慢，用户肉眼可跟；0 = 不放慢
    headless: false           # 就是要给用户看
    defaultTimeoutMs: 30000
    startupTimeoutMs: 45000
    maxResultChars: 20000     # dom/evaluate 回传截断阈值
    cdpPort: 9222             # 仅 browser_attach 降级通道用
    controlPort: 9330         # 内置面板命令通道（仅绑 127.0.0.1）
    announce: true            # 系统提示词公布工具用法（sectionOrder 116.7）
```

## 安全红线（不可违背）

1. **不做自动提交生产系统表单**；内部系统登录先走 `fe-local-autologin` skill
   （凭据只由 `browser_session.py` 内部取用，**绝不进对话、日志、协议**）；
2. 密码输入框的 value 在 `browser_dom` 摘要里**强制隐去**（daemon 侧实现）；
3. `browser_evaluate` 是页面任意 JS：不要在里面放凭据，不要对生产系统注入；
4. 浏览器动作全部发生在**用户屏幕上**，保持可见、可中断；
5. 本插件不开放远程端口；9330（命令队列）/9222（CDP 降级）都只绑 127.0.0.1，同为本机信任级。

## 自测

```sh
cd ~/deepseekharness工作区/dsh-browser-bridge
node test/bridge.test.mjs                 # 单测（假 ctx，不弹浏览器；DSH_BRIDGE_TEST_NO_START=1 防止急启守护进程）
DSH_BRIDGE_E2E=1 node test/bridge.test.mjs  # e2e（真 Chrome，slowMo=0，自动收尾零残留）

VENV=/Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3
$VENV test/test_cmd_queue.py              # 命令队列逻辑单测
# 内置面板活体链路（需桌面端已开且新版 client 已装载；会接管 9330）：
$VENV test/builtin_chain.py ping                      # client 探活
$VENV test/builtin_chain.py panel action=state        # 宿主态快照（无 CDP 排障口）
$VENV test/builtin_chain.py seq --takeover            # 全套 M2 链路（含自动开面板+首航+仿真），输出 PASS/FAIL 汇总
# 探针页服务（seq 默认 url 使用；双 fork 防沙箱回收）：
/Users/ayin/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -m http.server 8799 \
  --bind 127.0.0.1 --directory test
```

`builtin_chain.py --takeover` 会停掉插件当前的守护进程（9330 占用者）——测试完随手
杀掉即可；插件会在下次工具调用时自愈重拉自己的守护进程。

## M1 验收（托管 Chrome，重启 DSH 后第一件事）

在 DSH 会话里对模型说：

> 打开 http://localhost:80/riskmobile/ 登录并截图

模型应依次调 `browser_navigate` → `browser_dom` → `browser_click`/`evaluate`
→ `browser_screenshot`，用户全程看着 Chrome 窗口动作。

## M2 验收（内置面板，v5 起普通重启即可）

对模型说（无需任何启动参数）：

> 用内置浏览器打开 https://www.baidu.com 并截图

模型调 `browser_navigate(target=builtin)` → 面板自动打开并加载 → `screenshot` 落盘，
用户看着右侧栏面板里页面动。2026-10-10 实测：`test/builtin_chain.py seq` 全绿
（navigate/dom/evaluate/click/screenshot×2/emulate PC↔Mobile/reset/back）。

## 与 BrowserSkill 的关系（重要背景）

web profile 里另有腾讯 BrowserSkill 的官方 DSH 插件（"扩展连接用户日常浏览器"路线），
**与本插件互补不冲突**：BrowserSkill 适合操控用户手边已登录的浏览器；本插件适合
调试自动化与回放复现（托管 Chrome 独立持久 profile、移动端视口、动作放慢；内置面板
驱动则是"看着面板动"的原生形态）。

## CDP attach 降级通道（browser_attach，仅排障用）

一次性准备（⚠ `open -a --args` 实测会被 DSH 的两段式自举丢参，**必须直接拉起 stage-2**）：

```sh
killall -TERM "DeepSeek Harness" 2>/dev/null; sleep 3
killall -9 "DeepSeek Harness" 2>/dev/null; sleep 1
nohup /Applications/DeepSeek\ Harness.app/Contents/MacOS/DeepSeek\ Harness \
  --remote-debugging-port=9222 --expose-internals \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/app.asar/dsh \
  /Users/ayin/.dsh/profiles/desktop \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/primary-runtime \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/bin \
  > /tmp/dsh-cdp.log 2>&1 &
```

之后在会话里 `browser_attach` → 各工具传 `target: "builtin"`。已知边界：面板 webview
是惰性挂载（空态无 target）；webview/iframe target 不走 Playwright（裸 CDP WebSocket，
`BuiltinSession`）；面板关闭/桌面端重启后需重新 attach。**日常使用完全不需要本节。**

自测：`DSH_BRIDGE_E2E=1 venv3/bin/python3 test/raw_cdp.test.py` 直测裸 CDP 通道全链路
（navigate/evaluate/真实鼠标 click/密码框隐去/截图/跨导航存活）。
