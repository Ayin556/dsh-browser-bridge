import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DEVICES, buildSpec, listDevices } from "./devices.js";
import { applySpec as applyElectronSpec, clearSpec as clearElectronSpec, diagnose as diagnoseElectron, disposeAll as disposeElectron, probe as probeElectron } from "./electron-emulation.js";

//#region 插件元信息
/**
 * dsh-browser-bridge —— 给 agent 的浏览器控制工具（默认驱动 DSH 内置浏览器面板）。
 *
 * ## 解决的问题
 *
 * DSH 的 agent 工具全集里没有任何浏览器控制原语；内置浏览器面板
 * （`dsh-client-ui-sidebar-browser`）是给人看的 UI，agent 不可控。本插件按
 * `~/deepseekharness工作区/dsh-browser-control/开发交接卡.md` 的路线 B/C 补上：
 * 注册 `browser_navigate / browser_evaluate / browser_screenshot / browser_dom /
 * browser_click` 五个 server 工具，**默认路由到 DSH 桌面端内置浏览器面板**
 * （右侧栏，用户可见、不额外弹窗）——省略 `target` 参数即走内置，这是 2026-10-13
 * 起的默认（此前默认是 managed 托管 Chrome，导致模型调试时习惯性弹外置窗口）。
 *
 * ## 目标（target）与默认值
 *
 * 所有工具带可选 `target` 参数，实际生效值 = 显式参数 ?? `config.defaultTarget`。
 * 未显式指定时**一律走内置面板**——这是让模型"默认就在内置浏览器里调试"的关键。
 *
 * - **`builtin`（默认）**：DSH 桌面端内置浏览器面板（右侧栏，用户可见、不弹外部窗口）。
 *   走无 CDP 命令通道（2026-10-10 v5 定稿）：守护进程把命令入队 → 随桌面端 boot manifest
 *   常驻的客户端扩展（client.cjs）轮询取命令、用 webview 原生 API
 *   （executeJavaScript/capturePage/loadURL）执行 → 回报结果。普通重启桌面端即可用
 *   （无需任何启动参数）；面板未打开时 navigate 会自动打开。CDP attach（browser_attach）
 *   降级为备用通道，仅在需要深度调试时使用。
 * - **`managed`（显式指定才用）**：仅在需要**独立登录态 / 独立窗口**时传 target=managed。
 *   本插件托管一个用户可见的有头 Chrome——
 *   - 守护进程随插件进程常驻（单例 + 跨轮次复用，会话轮次之间浏览器不关）；
 *   - 登录态持久化：`launch_persistent_context(profileDir)`，登录一次跨会话有效；
 *   - slowMo 默认 250ms：动作放慢，用户肉眼可跟；
 *   - 运行时零安装：不引 npm/浏览器二进制依赖，走 venv3 的 Python Playwright
 *     （`lib/browser_daemon.py`，NDJSON over stdio），channel=chrome 用系统浏览器，
 *     规避 Playwright 自带 chromium 的版本匹配问题。
 *
 * ## 通道差异（写进工具描述，避免模型选错）
 *
 * `builtin` 的 click/dom/screenshot 由 client.cjs 用 `document.querySelector` 实现 →
 * **只支持 CSS 选择器**（不支持 Playwright 的 text=/role= 语法）；`managed` 走 Playwright，
 * 支持完整选择器语法。
 *
 * @module dsh-browser-bridge
 */
const name = "dsh-browser-bridge";
const DAEMON_SCRIPT = fileURLToPath(new URL("./browser_daemon.py", import.meta.url));
//#endregion

//#region 配置
const Config = z.object({
	/** 守护进程用的 Python 解释器（含 playwright 的 venv3）。 */
	pythonBin: z.string().default("/Users/ayin/person/person-python/windowsPC/pythonPC/venv3/bin/python3"),
	/** Chrome 持久 profile 目录（登录态存这里；相对/`~` 路径按 home 解析）。 */
	profileDir: z.string().default("~/.dsh/browser-bridge/profile"),
	/** 截图输出目录。 */
	shotsDir: z.string().default("~/.dsh/browser-bridge/shots"),
	/**
	 * 默认操作目标（模型不传 `target` 时生效）。
	 *
	 * - `builtin`（默认）：DSH 桌面端内置浏览器面板——用户可见、不弹外部窗口，
	 *   研发调试的首选（2026-10-13 起把默认从 managed 改为 builtin：此前模型不传
	 *   target 就会弹出外置 Chrome，实测一场会话 72 次调用里 57 次落到外置）。
	 * - `managed`：本插件托管的有头 Chrome（独立窗口 + 独立登录态），仅在明确需要时改回。
	 */
	defaultTarget: z.union(["builtin", "managed"]).default("builtin"),
	/** 页面视口宽（默认 390 = 移动端调试友好）。 */
	viewportWidth: z.number().default(390),
	/** 页面视口高（默认 844）。 */
	viewportHeight: z.number().default(844),
	/** 设备缩放（默认 2，截图更清晰）。 */
	deviceScaleFactor: z.number().default(2),
	/** 每个浏览器动作的放慢毫秒数（0 = 不放慢；放慢是为了让用户肉眼旁观）。 */
	slowMoMs: z.number().default(250),
	/** 是否无头（默认 false：就是要给用户看）。 */
	headless: z.boolean().default(false),
	/** 默认操作超时（毫秒）。 */
	defaultTimeoutMs: z.number().default(30000),
	/** 守护进程启动就绪超时（毫秒）。 */
	startupTimeoutMs: z.number().default(45000),
	/** dom/evaluate 结果回传的最大字符数（超出截断）。 */
	maxResultChars: z.number().default(20000),
	/** 路线 C：DSH 桌面端的 CDP 端口（需带参重启 `--remote-debugging-port=<cdpPort>`）。 */
	cdpPort: z.number().default(9222),
	/** 模拟栏按钮的控制端口（本机回环；daemon 启动即绑定）。 */
	controlPort: z.number().default(9330),
	/** attach 面板后自动开启移动端仿真（390×844 dsf3 + touch）——面板宽度≠手机宽度。 */
	mobileEmulation: z.boolean().default(true),
	/** 公布工具用法的系统提示词段落。 */
	announce: z.boolean().default(true),
	/** 公告段落顺序（排在 aiconfig-agents 的 116.6 之后）。 */
	sectionOrder: z.number().default(116.7)
});
//#endregion

//#region 路径工具
/** 展开 `~` 与相对路径（相对按 home）。 */
function expandPath(dir) {
	const expanded = dir === "~" || dir.startsWith("~/") ? joinHome(dir) : dir;
	return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

function joinHome(dir) {
	return dir === "~" ? homedir() : resolve(homedir(), dir.slice(2));
}
//#endregion

//#region 守护进程客户端
/**
 * 浏览器守护进程客户端：懒启动 venv3 python + browser_daemon.py，
 * NDJSON 请求/响应按 id 配对；进程死亡后下一次调用自动重启（Chrome 随之重拉，
 * profile 里的登录态还在）。
 */
class DaemonClient {
	constructor(config, logger) {
		this.config = config;
		this.logger = logger;
		this.proc = void 0;
		this.pending = new Map();
		this.nextId = 1;
		this.buffer = "";
		this.readyPromise = void 0;
		this.starting = false;
	}

	/** 确保守护进程活着并已就绪（含 config 下发）。 */
	async ensure() {
		if (this.proc !== void 0 && this.readyPromise === void 0) return;
		if (this.readyPromise !== void 0) return this.readyPromise;
		this.starting = true;
		this.readyPromise = new Promise((resolveReady, rejectReady) => {
			const profileDir = expandPath(this.config.profileDir);
			const shotsDir = expandPath(this.config.shotsDir);
			try {
				mkdirSync(profileDir, { recursive: true });
				mkdirSync(shotsDir, { recursive: true });
			} catch (error) {
				rejectReady(new Error(`浏览器 profile/截图目录创建失败：${String(error)}`));
				return;
			}
			let settled = false;
			const startupTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				rejectReady(new Error(`浏览器守护进程 ${this.config.startupTimeoutMs}ms 内未就绪（python=${this.config.pythonBin}）`));
			}, this.config.startupTimeoutMs);
			let proc;
			try {
				proc = spawn(this.config.pythonBin, [DAEMON_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
			} catch (error) {
				clearTimeout(startupTimer);
				settled = true;
				rejectReady(new Error(`无法启动 Python 守护进程（${this.config.pythonBin}）：${String(error)}`));
				return;
			}
			this.proc = proc;
			proc.stdout.setEncoding("utf8");
			proc.stdout.on("data", (chunk) => {
				this.buffer += chunk;
				let index;
				while ((index = this.buffer.indexOf("\n")) >= 0) {
					const line = this.buffer.slice(0, index).trim();
					this.buffer = this.buffer.slice(index + 1);
					if (line.length === 0) continue;
					this.onLine(line, () => {
						if (settled) return;
						settled = true;
						clearTimeout(startupTimer);
						resolveReady();
					});
				}
			});
			proc.stderr.setEncoding("utf8");
			let stderrTail = "";
			proc.stderr.on("data", (chunk) => {
				stderrTail = (stderrTail + chunk).slice(-4000);
			});
			proc.on("exit", (code, signalName) => {
				this.logger.warn(`[browser-bridge] 守护进程退出（code=${code ?? "null"} signal=${signalName ?? "null"}）${stderrTail.length > 0 ? ` stderr 尾部：${stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
				this.proc = void 0;
				this.readyPromise = void 0;
				for (const pending of this.pending.values()) pending.reject(new Error("浏览器守护进程已退出，本次操作未完成（下次调用会自动重启浏览器）"));
				this.pending.clear();
			});
			proc.on("error", (error) => {
				this.logger.warn(`[browser-bridge] 守护进程 spawn 失败：${String(error)}`);
			});
		}).then(() => {
			this.starting = false;
			// ⚠ 不能调 this.request("config")——request 会再进 ensure()，而此刻 this.readyPromise
			// 正是本 promise 链自身（async 返回值 adoption 自引用）→ 相互等待死锁（2026-10-10
			// 实锤：browser_navigate 全体卡死、会话无法终止的根因）。就绪阶段的下发走 _sendRaw。
			return this._sendRaw("config", {
				profileDir: expandPath(this.config.profileDir),
				shotsDir: expandPath(this.config.shotsDir),
				// 守护进程侧也据此解析缺省 target（双保险：JS 侧已注入，Python 侧再兜一层）
				defaultTarget: this.config.defaultTarget,
				// 机型表下发给守护进程：面板机型下拉由 GET /devices 提供给 client.cjs，
				// 保证"单一数据源 = lib/devices.js"（避免前端另抄一份）
				devices: DEVICES,
				viewportWidth: this.config.viewportWidth,
				viewportHeight: this.config.viewportHeight,
				deviceScaleFactor: this.config.deviceScaleFactor,
				slowMoMs: this.config.slowMoMs,
				headless: this.config.headless,
				controlPort: this.config.controlPort,
				mobileEmulation: this.config.mobileEmulation
			}, this.config.startupTimeoutMs);
		}, (error) => {
			this.starting = false;
			this.readyPromise = void 0;
			throw error;
		});
		return this.readyPromise;
	}

	onLine(line, onReady) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.logger.warn(`[browser-bridge] 守护进程输出无法解析：${line.slice(0, 200)}`);
			return;
		}
		if (message.type === "ready") {
			this.logger.info("[browser-bridge] 守护进程已就绪");
			onReady();
			return;
		}
		if (message.type === "log") {
			const logger = message.level === "warn" ? this.logger.warn : this.logger.info;
			logger.call(this.logger, `[browser-bridge] ${message.message}`);
			return;
		}
		const pending = this.pending.get(message.id);
		if (pending === void 0) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new Error(`${message.error}${message.traceback ? `\n${message.traceback.split("\n").slice(-2).join("\n")}` : ""}`));
	}

	/** 发一个 op（不经过 ensure；就绪阶段与 request 共用）。 */
	_sendRaw(op, params, timeoutMs) {
		const proc = this.proc;
		if (proc === void 0 || proc.stdin === void 0) return Promise.reject(new Error("浏览器守护进程不可用"));
		const id = this.nextId++;
		const budget = timeoutMs ?? this.config.defaultTimeoutMs + 20000;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectRequest(new Error(`浏览器操作 ${op} 超时（${budget}ms）。浏览器可能仍在动；可重试或加大 timeout_ms。`));
			}, budget);
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
			try {
				proc.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				rejectRequest(new Error(`向守护进程写入失败：${String(error)}`));
			}
		});
	}

	/**
	 * ensure + 硬上限：就绪阶段的任何卡死都必须在有限时间内暴露并可恢复。
	 * （2026-10-10 事故教训：request 曾在无上限的 ensure 上等待，工具调用会无限悬挂，
	 * 连 DSH 的"终止"都被顶住——这一层保证此类问题最多拖 startupTimeoutMs+15s。）
	 */
	async _ensureGuarded() {
		const budget = this.config.startupTimeoutMs + 15000;
		let timer;
		const guard = new Promise((_, rejectGuard) => {
			timer = setTimeout(() => rejectGuard(new Error(`浏览器守护进程就绪等待超过 ${budget}ms（状态已重置，下次调用会重新拉起）`)), budget);
			timer.unref?.();
		});
		try {
			await Promise.race([this.ensure(), guard]);
		} catch (error) {
			this.readyPromise = void 0;
			if (this.proc !== void 0) {
				try { this.proc.kill(); } catch { /* 已死则忽略 */ }
				this.proc = void 0;
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 发一个 op，等响应；超时不再等待（守护进程侧可能仍在执行，结果作废）。 */
	async request(op, params, timeoutMs) {
		await this._ensureGuarded();
		return this._sendRaw(op, params, timeoutMs);
	}

	/** 插件卸载时收尸：关守护进程（Chrome 一并关闭）。 */
	async stop() {
		const proc = this.proc;
		if (proc === void 0) return;
		this.proc = void 0;
		this.readyPromise = void 0;
		for (const pending of this.pending.values()) pending.reject(new Error("插件卸载，浏览器操作取消"));
		this.pending.clear();
		await Promise.allSettled([new Promise((resolveStop) => {
			proc.once("exit", resolveStop);
			setTimeout(resolveStop, 3000).unref?.();
			try {
				proc.kill();
			} catch {
				/* 已死则忽略 */
			}
		})]);
	}
}
//#endregion

//#region 工具公共件
/**
 * 所有工具共用的 `target` 参数。描述随 `config.defaultTarget` 动态生成——
 * 模型看到的"默认目标"必须与真实分派完全一致，否则它会照描述去开外置浏览器。
 */
function targetParam(config) {
	const builtinDefault = config.defaultTarget !== "managed";
	return {
		type: "string",
		enum: ["builtin", "managed"],
		description: builtinDefault
			? "操作目标，省略即 builtin。builtin=DSH 桌面端内置浏览器面板（默认；用户可见的右侧栏，不弹外部窗口；面板未打开时 navigate 会自动打开；无需 CDP/attach）；managed=本插件托管的有头 Chrome（会弹出独立浏览器窗口，仅在需要独立登录态/独立窗口时才用）。"
			: "操作目标，省略即 managed。managed=本插件托管的有头 Chrome（默认，独立窗口 + 独立登录态）；builtin=DSH 桌面端内置浏览器面板（右侧栏，用户可见；面板未打开时 navigate 会自动打开；无需 CDP/attach）。"
	};
}

/** 解析实际生效的目标：显式参数 > 插件默认（`config.defaultTarget`，默认 builtin）。 */
function resolveTarget(config, args) {
	return args.target ?? config.defaultTarget;
}

/** 机型清单文本（对齐 Chrome DevTools 的设备列表；默认显示项在前）。 */
function deviceListText() {
	const rows = listDevices().map((d) => {
		const caps = d.capabilities.join("/") || "—";
		return `| ${d.default ? "★" : " "} ${d.title} | ${d.vertical.width}×${d.vertical.height} | ${d.dpr} | ${d.type} | ${caps} |`;
	});
	return [
		`可用机型（共 ${DEVICES.length} 款，与 Chrome DevTools 设备列表逐字段一致；★ = DevTools 下拉里默认显示）：`,
		"",
		"| 机型 | 竖屏 CSS 尺寸 | dpr | 类别 | 能力 |",
		"|---|---|---|---|---|",
		...rows,
		"",
		"用法：`browser_emulate(device=\"iPhone 16 Pro Max\")`；横屏加 `orientation=\"horizontal\"`；",
		"自定义 PC 视口用 `width`/`height`/`dpr`（等价 DevTools 的 Responsive）；`reset=true` 还原。"
	].join("\n");
}

/** 机型规格 → 一行可读摘要。 */
function specSummary(spec) {
	const parts = [
		`${spec.preset ?? "custom"} ${spec.width}×${spec.height} CSS px`,
		`dpr ${spec.dpr}`,
		spec.mobile ? "mobile" : "desktop",
		spec.touch ? "touch" : "no-touch",
		spec.orientation === "horizontal" ? "横屏" : "竖屏"
	];
	return parts.join("，");
}

/** 内置面板：Electron 主进程原生 CDP —— 与 Chrome DevTools 设备工具栏等价的通道。 */
async function emulateViaElectron(client, spec, reset) {
	const cap = probeElectron();
	if (!cap.ok) return { ok: false, reason: `原生 CDP 不可用（${cap.reason}）` };
	let info;
	try {
		info = await client.request("client-info", { target: "builtin" }, 20000);
	} catch (error) {
		return { ok: false, reason: `面板句柄查询失败：${error.message}` };
	}
	let id = info?.webContentsId;
	if (typeof id !== "number") {
		// 面板没开 → 自动开一次再取句柄（零门槛：不必先手动把面板点开）
		try {
			await client.request("panel", { action: "open", target: "builtin" }, 30000);
			info = await client.request("client-info", { target: "builtin" }, 20000);
			id = info?.webContentsId;
		} catch (error) {
			return { ok: false, reason: `面板未打开且自动打开失败：${error.message}` };
		}
	}
	if (typeof id !== "number") {
		return { ok: false, reason: "面板 webview 还没挂出 webContents（先用 browser_navigate 打开一个页面）" };
	}
	try {
		if (reset) await clearElectronSpec(cap.electron, id);
		else await applyElectronSpec(cap.electron, id, spec);
	} catch (error) {
		const d = diagnoseElectron(id);
		const hint = d.reachable === false
			? "（诊断：面板 webContents 不在本进程的 Electron 实例里 → 零参数通道不可用；请用 browser_attach 或 target=managed）"
			: "";
		return { ok: false, reason: `Electron CDP 下发失败：${error.message}${hint}` };
	}
	const head = reset
		? "已清除仿真：面板恢复原生视口 / UA / 指针形态"
		: `已仿真：${specSummary(spec)}\nUA：${spec.ua ? "已按机型覆盖（含 Client Hints）" : "未覆盖，保留原 UA"}`;
	return {
		ok: true,
		text: [
			head,
			"通道：Electron 原生 CDP（Emulation.setDeviceMetricsOverride / setUserAgentOverride / setTouchEmulationEnabled）——与 Chrome DevTools 设备工具栏同一组命令，零启动参数",
			`面板：webContents #${id}`
		].join("\n")
	};
}

/** 降级通道（CSS 近似）结果文本：必须如实说明"什么没被仿真"。 */
function degradedEmulateText(out, reason, spec, reset) {
	const cleared = reset || out?.emulated === false;
	return [
		cleared ? "已清除仿真（降级通道）：面板恢复原生视口与 UA" : `已仿真（降级 CSS 近似）：${spec === null ? "" : specSummary(spec)}`,
		`⚠️ 降级原因：${reason}`,
		"viewport 宽度真实生效（PC 大视口经锁宽+缩放下发，页面 innerWidth=目标宽，响应式站点走桌面布局）；未仿真：devicePixelRatio / touch / (pointer: coarse)·(hover: none) / Client Hints —— 这几项只有 CDP 能给",
		"要拿到与 Chrome DevTools 完全一致的仿真：① 用 DSH **桌面端**（Electron 原生 CDP，零启动参数）；② 或显式传 target=managed（托管 Chrome 同样走 CDP）。"
	].join("\n");
}

/** 托管 Chrome 的 CDP 仿真结果文本。 */
function managedEmulateText(out, spec, reset) {
	if (reset || out?.emulated === false) {
		return `已清除仿真（托管 Chrome，CDP）：视口与 UA 恢复原生\n当前页：${out?.url ?? "（未知）"}`;
	}
	return [
		`已仿真（托管 Chrome，CDP）：${spec === null ? "" : specSummary(spec)}`,
		`UA：${spec?.ua ? "已按机型覆盖（含 Client Hints）" : "未覆盖"}`,
		`当前页：${out?.url ?? "（未知）"}`
	].join("\n");
}

/**
 * 仿真能力诊断：把"零参数通道到底通不通"变成一条可读结论，不必在会话里盲猜。
 * 起因：桌面端正常启动时 cordis host 是**独立于 UI 的 Electron 子进程**，
 * 而 Electron 的 webContents 只在同一实例内可见。
 */
async function emulateDiagnosis(client) {
	let panelId = null;
	let clientErr = null;
	try {
		const info = await client.request("client-info", { target: "builtin" }, 20000);
		if (typeof info?.webContentsId === "number") panelId = info.webContentsId;
	} catch (error) {
		clientErr = error.message;
	}
	const d = diagnoseElectron(panelId);
	const lines = [
		"设备仿真能力诊断",
		`- 宿主 Electron：${d.ok ? d.electron : "否"}`,
		`- 原生 CDP（require(\"electron\")）：${d.ok ? "可用" : `不可用 —— ${d.reason}`}`,
		`- 面板上报的 webContentsId：${panelId ?? "（无）"}${clientErr ? `（查询失败：${clientErr}）` : ""}`,
		`- 本进程 Electron 实例内的 webContents：${d.webContents ? d.webContents.length : 0} 个`
	];
	for (const w of (d.webContents ?? []).slice(0, 12)) {
		lines.push(`    #${w.id} [${w.type}] ${w.url}`);
	}
	lines.push(`- 判定：${d.verdict}`);
	lines.push("");
	lines.push("三条通道：");
	lines.push("  ① Electron 原生 CDP（零启动参数）—— 需上面判定为「可达」");
	lines.push("  ② CDP attach 到内置面板 —— 需一次带 --remote-debugging-port=9222 重启后调 browser_attach（Emulation 域完备）");
	lines.push("  ③ target=managed —— 托管 Chrome，CDP 仿真已实测通过");
	lines.push("  以上都不可用时降级为 CSS 近似：dpr / touch / (pointer: coarse) / Client Hints 不保真。");
	return lines.join("\n");
}

/**
 * 设备仿真主流程。
 *
 * builtin（内置面板）优先走 **Electron 主进程原生 CDP**——viewport/dpr/mobile/touch/
 * UA+Client Hints 全覆盖，与 Chrome DevTools 设备工具栏同一组命令，且零启动参数；
 * 拿不到面板句柄或非 Electron 宿主（web profile / 单测）时，退回守护进程 →
 * client.cjs 的 CSS 近似，并在文本里如实说明哪几项没被仿真。
 */
async function runEmulate(client, config, args) {
	if (args.list === true) return deviceListText();
	if (args.diagnose === true) return await emulateDiagnosis(client);
	const target = resolveTarget(config, args);
	const reset = args.reset === true;
	let spec = null;
	if (!reset) {
		const built = buildSpec({
			device: args.device,
			orientation: args.orientation,
			overrides: { width: args.width, height: args.height, dpr: args.dpr, mobile: args.mobile, touch: args.touch, ua: args.ua }
		});
		if (built.spec === null) return [`仿真参数有误：${built.error}`, "", deviceListText()].join("\n");
		spec = built.spec;
	}
	if (target === "builtin") {
		const viaElectron = await emulateViaElectron(client, spec, reset);
		if (viaElectron.ok) return viaElectron.text;
		const out = await client.request("emulate", { spec, reset, target }, 40000);
		return degradedEmulateText(out, viaElectron.reason, spec, reset);
	}
	const out = await client.request("emulate", { spec, reset, target }, 40000);
	return managedEmulateText(out, spec, reset);
}

function clip(text, max) {
	if (typeof text !== "string") return text;
	return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）` : text;
}

function toolDef(ctx, client, config, partial) {
	return defineTool({
		isConcurrencySafe: () => false,
		...partial,
		async execute(args, exec) {
			return partial.execute(client, config, args, exec);
		}
	});
}
//#endregion

//#region 六个工具
function buildTools(ctx, client, config) {
	const logger = ctx.logger;
	return [
		toolDef(ctx, client, config, {
			name: "browser_navigate",
			description: "打开一个 URL。默认在 DSH 桌面端内置浏览器面板（右侧栏，用户可见、不弹外部窗口）中打开——省略 target 即内置，面板未打开会自动打开。仅在需要独立登录态/独立窗口时才传 target=managed（会弹出独立 Chrome 窗口）。返回最终 URL/标题/HTTP 状态。",
			parameters: {
				url: { type: "string", required: true, description: "要打开的完整 URL（含 http(s):// 或 file://）。" },
				wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "导航等待策略，默认 load；SPA 慢页面可用 domcontentloaded。" },
				timeout_ms: { type: "number", description: "导航超时（毫秒），默认 30000。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("navigate", {
					url: args.url,
					wait_until: args.wait_until ?? "load",
					timeout_ms: args.timeout_ms ?? config.defaultTimeoutMs,
					target: resolveTarget(config, args)
				}, (args.timeout_ms ?? config.defaultTimeoutMs) + 30000);
				const text = `已导航：${result.url}\n标题：${result.title || "（无）"}${result.status ? `\nHTTP 状态：${result.status}` : ""}`;
				logger.info(`[browser-bridge] navigate → ${result.url}`);
				return { text };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_evaluate",
			description: "在当前页（默认 DSH 内置浏览器面板）里执行任意 JS 并返回 JSON 结果。传表达式（`document.title`）或函数体（`() => document.querySelector('h1')?.textContent`）；返回 Promise 会自动等待。页面上下文同步执行，别在这里放凭据。",
			parameters: {
				expression: { type: "string", required: true, description: "JS 表达式或 `() => {...}` 函数体；async 函数返回的 Promise 会被自动等待。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("evaluate", { expression: args.expression, target: resolveTarget(config, args) });
				const raw = JSON.stringify(result.value, null, 1) ?? "undefined";
				return { text: `求值结果：\n${clip(raw, config.maxResultChars)}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_screenshot",
			description: "对当前页（默认 DSH 内置浏览器面板）截图，PNG 落盘并返回绝对路径（需要看图时用 read_image 读该路径）。支持整页截图与按 CSS 选择器截元素。截图即用户在面板里所见。",
			parameters: {
				full_page: { type: "boolean", description: "是否整页滚动截图（默认 false，只截视口）。" },
				selector: { type: "string", description: "只截该 CSS 选择器命中的第一个元素。" },
				timeout_ms: { type: "number", description: "截图超时（毫秒），默认 15000。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("screenshot", {
					full_page: args.full_page ?? false,
					selector: args.selector,
					timeout_ms: args.timeout_ms ?? 15000,
					target: resolveTarget(config, args)
				});
				return { text: `截图已保存：${result.path}（${Math.round(result.bytes / 1024)}KB）\n页面：${result.title || "（无标题）"} — ${result.url}\n需要看图时用 read_image 读该路径。` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_dom",
			description: "读取当前页（默认 DSH 内置浏览器面板）的 DOM：不给选择器 → 页面摘要（标题/URL/可见文本/全部输入框清单，登录页直接拿表单结构）；给 CSS 选择器 → 该元素 outerHTML。选不到元素会报错并给出可尝试的建议。",
			parameters: {
				selector: { type: "string", description: "CSS 选择器；省略则返回页面摘要。" },
				max_chars: { type: "number", description: "结果最大字符数，默认 20000。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("dom", { selector: args.selector, max_chars: args.max_chars ?? config.maxResultChars, target: resolveTarget(config, args) });
				if (args.selector) {
					return { text: clip(`<${args.selector}> outerHTML（${result.html_length} 字符${result.truncated ? "，已截断" : ""}）：\n${result.html}`, config.maxResultChars + 200) };
				}
				const inputs = (result.inputs ?? []).map((input) => `- ${input.tag}${input.type ? `[type=${input.type}]` : ""}${input.id ? ` #${input.id}` : ""}${input.name ? ` [name=${input.name}]` : ""}${input.placeholder ? ` placeholder="${input.placeholder}"` : ""}${input.value ? ` value=${JSON.stringify(input.value)}` : ""}`).join("\n");
				return {
					text: clip([
						`页面：${result.title || "（无标题）"} — ${result.url}`,
						`可见文本（${result.text_truncated ? "已截断" : "完整"}）：`,
						result.text || "（空）",
						inputs.length > 0 ? `\n输入框清单：\n${inputs}` : ""
					].join("\n"), config.maxResultChars + 200)
				};
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_click",
			description: "点击当前页（默认 DSH 内置浏览器面板）里的元素。内置通道只支持 CSS 选择器（client 侧走 document.querySelector）；仅 target=managed 时才支持 Playwright 的 text=/role= 语法。点击后等 DOM 稳定并返回新 URL/标题。注意红线：不要在生产系统里自动提交表单。",
			parameters: {
				selector: { type: "string", required: true, description: "CSS 选择器（内置通道）；target=managed 时也可用 Playwright 选择器（text=xxx / role=xxx[name=yyy]）。" },
				timeout_ms: { type: "number", description: "等待元素可点击的超时（毫秒），默认 15000。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("click", {
					selector: args.selector,
					timeout_ms: args.timeout_ms ?? 15000,
					target: resolveTarget(config, args)
				}, (args.timeout_ms ?? 15000) + 20000);
				return { text: `已点击：${result.clicked}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_fill",
			description: "向当前页（默认 DSH 内置浏览器面板）的输入框填入文本。兼容 React/Vue 受控组件（native setter + input/change 事件）。支持 input/textarea/contenteditable；select 下拉用 browser_select。",
			parameters: {
				selector: { type: "string", required: true, description: "CSS 选择器（内置通道）；target=managed 时也可用 Playwright 选择器。" },
				value: { type: "string", required: true, description: "要填入的文本。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("fill", {
					selector: args.selector,
					value: args.value,
					target: resolveTarget(config, args)
				});
				return { text: `已填入 ${JSON.stringify(result.value)} → ${result.selector}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_select",
			description: "在当前页（默认 DSH 内置浏览器面板）的 <select> 下拉里选择一项。按 value 或 label 匹配（value 优先精确匹配，label 按文本匹配；纯数字 value 也按索引兜底）。",
			parameters: {
				selector: { type: "string", required: true, description: "CSS 选择器（内置通道）；target=managed 时也可用 Playwright 选择器。" },
				value: { type: "string", description: "选项的 value。" },
				label: { type: "string", description: "选项的可见文本。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("select", {
					selector: args.selector,
					value: args.value,
					label: args.label,
					target: resolveTarget(config, args)
				});
				const sel = result.selected || {};
				return { text: `已选择 ${result.selector} → ${sel.label ? `label=${sel.label}` : `value=${sel.value}`}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_press",
			description: "在当前页（默认 DSH 内置浏览器面板）里按键。key 支持 Enter/Tab/Escape/Backspace/方向键/Home/End/PageUp/PageDown/Delete/Space 等命名键；单字符则输入到目标元素（默认当前焦点元素）。",
			parameters: {
				key: { type: "string", required: true, description: "按键名（如 Enter、Tab、Escape、ArrowDown、\"a\"）。" },
				selector: { type: "string", description: "CSS 选择器（可选）；不传则作用于当前焦点元素。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("press", {
					key: args.key,
					selector: args.selector,
					target: resolveTarget(config, args)
				});
				return { text: `已按键：${args.key}${result.selector ? ` → ${result.selector}` : "（焦点元素）"}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_hover",
			description: "在当前页（默认 DSH 内置浏览器面板）的指定元素上触发悬停（mouseover/mouseenter/mousemove），用于唤起悬浮菜单/提示。",
			parameters: {
				selector: { type: "string", required: true, description: "CSS 选择器（内置通道）；target=managed 时也可用 Playwright 选择器。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("hover", {
					selector: args.selector,
					target: resolveTarget(config, args)
				});
				return { text: `已悬停：${result.selector}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_console",
			description: "读取当前页（默认 DSH 内置浏览器面板）的 console 日志（log/warn/error/info，最近 N 条）。内置面板由 webview console-message 事件实时缓存；托管 Chrome 由 Playwright 监听。研发调试看报错用这个，不用开外部 devtools。",
			parameters: {
				limit: { type: "number", description: "最多返回条数，默认 100。" },
				level: { type: "string", enum: ["error", "warning", "info", "verbose"], description: "只返回该级别及以上的日志；不传返回全部。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("console", {
					limit: args.limit ?? 100,
					level: args.level,
					target: resolveTarget(config, args)
				});
				const logs = result.logs || [];
				const levelRank = { error: 3, warning: 2, info: 1, verbose: 0 };
				const minRank = args.level ? levelRank[args.level] ?? 0 : -1;
				const filtered = logs.filter((l) => (levelRank[l.level] ?? 1) >= minRank);
				if (filtered.length === 0) return { text: `页面：${result.title || "（无标题）"} — ${result.url}\nconsole 无${args.level ? ` ${args.level} 及以上` : ""}日志${result.hint ? `\n提示：${result.hint}` : ""}` };
				const lines = filtered.map((l) => `[${l.level}] ${l.message}`).join("\n");
				return { text: `页面：${result.title || "（无标题）"} — ${result.url}\nconsole（${filtered.length} 条${args.level ? `，${args.level}+` : ""}）：\n${clip(lines, config.maxResultChars)}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_network",
			description: "读取当前页（默认 DSH 内置浏览器面板）的网络请求：已完成的资源（performance resource entries：URL/类型/耗时/大小）+ 最近失败/异常请求（fetch/XHR ≥400、requestfailed）。研发调试看 4xx/5xx 与慢请求用这个。",
			parameters: {
				limit: { type: "number", description: "最多返回条数，默认 80。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("network", {
					limit: args.limit ?? 80,
					target: resolveTarget(config, args)
				});
				const entries = result.entries || [];
				const fails = result.fails || [];
				const failLines = fails.length
					? `\n失败/异常请求（${fails.length} 条）：\n` + fails.slice(-20).map((f) => `- [${f.status ?? "FAIL"}] ${f.type} ${f.url}${f.error ? ` (${f.error})` : ""}`).join("\n")
					: "";
				const entryLines = entries.length
					? `\n已完成资源（${entries.length} 条，按耗时降序）：\n` + entries.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 25).map((e) => `- ${e.initiatorType || "?"} ${e.name}  ${e.duration}ms${e.transferSize ? ` / ${(e.transferSize / 1024).toFixed(0)}KB` : ""}`).join("\n")
					: "";
				return { text: `页面：${result.title || "（无标题）"} — ${result.url}${failLines}${entryLines}`.slice(0, config.maxResultChars) };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_attach",
			description: "【备用通道，一般不用】把本插件 CDP attach 到**带参重启**（--remote-debugging-port=9222）的 DSH 桌面端，选中内置浏览器面板里的页面。日常驱动面板不需要它：普通重启 + target=builtin 即可（经客户端命令通道，面板未打开会自动打开）。仅在需要 CDP 深度调试时使用；面板被关闭/桌面端重启后需重新 attach。",
			parameters: {
				cdp_port: { type: "number", description: "DSH 桌面端的 CDP 端口，默认 9222。" },
				url_prefix: { type: "string", description: "只匹配 URL 以该前缀开头的页面（多个候选时用）。" },
				timeout_ms: { type: "number", description: "attach 超时（毫秒），默认 15000。" }
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("attach", {
					cdp_port: args.cdp_port ?? config.cdpPort,
					url_prefix: args.url_prefix,
					timeout_ms: args.timeout_ms ?? 15000
				}, (args.timeout_ms ?? 15000) + 20000);
				const targets = (result.targets ?? []).map((t) => `- [${t.type}] ${t.title || "（无标题）"} — ${t.url}`).join("\n");
				if (result.attached) {
					return { text: `已 attach 并选中：${result.selected.title || "（无标题）"} — ${result.selected.url}\n后续工具传 target=builtin 即作用于该页面。${result.hint ? `\n${result.hint}` : ""}\n全部 CDP target：\n${targets}` };
				}
				return { text: `attach 成功但未选中页面：${result.reason}\nCDP target 候选：\n${targets}\nPlaywright 可见页面：\n${(result.playwright_pages ?? []).join("\n") || "（无）"}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_emulate",
			description: "设备仿真（口径对齐 Chrome DevTools 设备工具栏）。用 device 传机型名（如 \"iPhone 16 Pro Max\"、\"Pixel 9\"、\"zfold6\"，模糊匹配；共 46 款，见 list=true），可加 orientation=\"horizontal\" 横屏；自定义 PC 视口用 width/height/dpr。reset=true 还原。生效通道：内置面板走 Electron 原生 CDP（Emulation.setDeviceMetricsOverride + setUserAgentOverride + setTouchEmulationEnabled，与 DevTools 同一组命令）；托管 Chrome 同样走 CDP。两个通道都不可用时会降级为 CSS 近似，并在结果里明确标注。",
			parameters: {
				device: { type: "string", description: "机型名（模糊匹配：大小写/空格/连字符不敏感，可用简写如 iphone16pro、pixel9、zfold6）。" },
				orientation: { type: "string", enum: ["vertical", "horizontal"], description: "屏幕方向，默认 vertical。" },
				width: { type: "number", description: "自定义视口宽（与 height 一起用；等价 DevTools 的 Responsive 自定义尺寸）。" },
				height: { type: "number", description: "自定义视口高。" },
				dpr: { type: "number", description: "devicePixelRatio（自定义视口时用，默认 1）。" },
				mobile: { type: "boolean", description: "是否 mobile 视口（影响 meta viewport / 布局宽度），默认跟随机型。" },
				touch: { type: "boolean", description: "是否开启触摸仿真（影响 navigator.maxTouchPoints / (pointer: coarse)），默认跟随机型。" },
				ua: { type: "string", description: "覆盖 User-Agent（默认用机型的真实 UA；同时覆盖 Client Hints）。" },
				reset: { type: "boolean", description: "true = 清除仿真，恢复面板/浏览器的原生视口与 UA。" },
				list: { type: "boolean", description: "true = 只列出可用机型（含尺寸/dpr），不做任何仿真。" },
				diagnose: { type: "boolean", description: "true = 只做能力诊断：报告内置面板的完美仿真通道（Electron 原生 CDP）是否可达、以及三条通道的可用性。用于排查「仿真没生效」。" },
				target: targetParam(config)
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				return { text: await runEmulate(client, config, args) };
			}
		})
	];
}
//#endregion

//#region 插件入口
const inject = ["tools", "systemPrompt"];

/**
 * 挂载：注册 7 个浏览器工具（5 操作 + browser_attach + browser_emulate）+（可选）用法公告段落。
 *
 * 失败一律降级为告警 + 不注册（不让一个坏配置拖垮整个 profile 启动）；
 * 真正的启动失败发生在第一次工具调用时（懒启动守护进程），错误会原样回到模型。
 */
function apply(ctx, config) {
	const logger = ctx.logger;
	const client = new DaemonClient(config, logger);
	// 急启动：插件挂载即拉起守护进程（不懒加载）——控制端口（client 命令通道）随 DSH 常驻，
	// 内置面板不依赖 agent 是否调用过工具。DSH_BRIDGE_TEST_NO_START=1 时跳过（供单测隔离用）。
	if (process.env.DSH_BRIDGE_TEST_NO_START !== "1") {
		void client.ensure().catch((error) => {
			logger.warn(`[browser-bridge] 守护进程急启动失败（首次工具调用会重试）：${String(error)}`);
		});
	}
	const disposers = [];
	// 启动即探测内置面板的"完美仿真"通道（Electron 主进程原生 CDP）并在日志里留痕——
	// 这是判断"browser_emulate 会走哪条通道"的权威依据（不依赖会话内提示）。
	const emuCap = probeElectron();
	if (emuCap.ok) {
		logger.info(`[browser-bridge] 设备仿真通道：Electron 原生 CDP 可用（Electron ${emuCap.version}）——内置面板可达 Chrome DevTools 等价仿真`);
	} else {
		logger.warn(`[browser-bridge] 设备仿真将降级：${emuCap.reason}（内置面板只能做 CSS 近似：dpr/touch/(pointer: coarse) 不保真）`);
	}
	for (const definition of buildTools(ctx, client, config)) {
		disposers.push(ctx.tools.register(definition));
	}
	logger.info(`[browser-bridge] 已注册浏览器工具：${disposers.length} 个（profile=${expandPath(config.profileDir)}，python=${config.pythonBin}）`);
	if (config.announce) {
		ctx.systemPrompt.section({
			name: "browser-bridge:tools",
			order: config.sectionOrder,
			text: (context) => {
				const available = ["browser_navigate", "browser_evaluate", "browser_screenshot", "browser_dom", "browser_click", "browser_fill", "browser_select", "browser_press", "browser_hover", "browser_console", "browser_network", "browser_attach", "browser_emulate"].filter((toolName) => ctx.tools.get(toolName, context.scope) !== void 0);
				if (available.length === 0) return "";
				const builtinDefault = config.defaultTarget !== "managed";
				const head = builtinDefault
					? "可用浏览器控制工具（**默认驱动 DSH 桌面端内置浏览器面板**——右侧栏那个，用户可见、不弹外部窗口；面板未打开时 navigate 会自动打开；无需 CDP/attach）："
					: "可用浏览器控制工具（默认驱动一个**用户可见**的有头 Chrome，单例跨轮次复用，动作放慢便于用户旁观；登录态经持久 profile 跨会话保留）：";
				return [
					head,
					"",
					"- `browser_navigate(url)`：打开页面（省略 target 即在默认目标里打开）",
					"- `browser_dom(selector?)`：读页面摘要（标题/文本/输入框清单）或元素 outerHTML",
					"- `browser_evaluate(expression)`：页面里执行 JS，返回 JSON",
					"- `browser_click(selector)`：点击（内置通道为 CSS 选择器）",
					"- `browser_fill(selector, value)`：向输入框填文本（兼容 React/Vue 受控组件）",
					"- `browser_select(selector, value|label)`：下拉选择一项",
					"- `browser_press(key)`：按键（Enter/Tab/方向键…）",
					"- `browser_hover(selector)`：悬停（唤起悬浮菜单/提示）",
					"- `browser_console(limit?|level?)`：读页面 console 日志（研发看报错）",
					"- `browser_network(limit?)`：读网络请求（4xx/5xx 与慢请求）",
					"- `browser_screenshot(full_page?|selector?)`：截图落盘返回路径，需要看图用 read_image",
					"- `browser_emulate(device?|orientation?|width?|height?|dpr?|reset?|list?)`：设备仿真，机型库与 **Chrome DevTools 设备列表逐字段一致**（46 款：iPhone 16 / Pixel 9·10 / iPad / Galaxy Z Fold / 笔记本…）；`device=\"iPhone 16 Pro Max\"` 即可，`list=true` 列全部；reset 还原",
					"- `browser_attach(cdp_port?, url_prefix?)`：【备用通道，一般不用】仅在需要 CDP 深度调试时 attach 到带参重启的桌面端",
					"",
					"典型链路：navigate → dom（找表单/元素）→ click/evaluate（操作）→ screenshot（回证）。选择器选不中先用 browser_dom 看真实结构；内置通道只支持 CSS 选择器。",
					builtinDefault
						? "**页面调试硬规则**：调试本机页面一律用上面的 `browser_*` 工具且**不加 target**（即走内置浏览器面板）；**不要用 bash 打开外部浏览器**（`open -a \"Google Chrome\"/Chromium/Safari`、`npx playwright open`、`bsk session start` 等）做页面调试；仅当明确需要独立登录态/独立窗口时才显式传 target=managed。"
						: "**页面调试建议**：默认目标是托管 Chrome；如需在 DSH 内置浏览器面板（右侧栏）里调试，显式传 target=builtin。",
					"红线：不自动提交生产系统表单；登录内部系统先走 fe-local-autologin skill（凭据不进对话）；这些动作全部发生在用户屏幕上，保持可见、可中断。"
				].join("\n");
			}
		});
	}
	ctx.effect(function* () {
		for (const dispose of disposers) yield dispose;
		yield () => {
			disposeElectron();
			void client.stop();
		};
	}, "browser-bridge: registered browser tools");
}

export { Config, apply, inject, name };
