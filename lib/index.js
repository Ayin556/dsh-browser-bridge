import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region 插件元信息
/**
 * dsh-browser-bridge —— 给 agent 的浏览器控制工具（交接卡路线 B：托管可见 Chrome）。
 *
 * ## 解决的问题
 *
 * DSH 的 agent 工具全集里没有任何浏览器控制原语；内置浏览器面板
 * （`dsh-client-ui-sidebar-browser`）是给人看的 UI，agent 不可控。本插件按
 * `~/deepseekharness工作区/dsh-browser-control/开发交接卡.md` 的路线 B 补上：
 * 注册 `browser_navigate / browser_evaluate / browser_screenshot / browser_dom /
 * browser_click` 五个 server 工具，全部路由到一个**用户可见**的持久 Chrome——
 *
 * - 运行时零安装：不引 npm/浏览器二进制依赖，驱动 venv3 的 Python Playwright
 *   守护进程（`lib/browser_daemon.py`，NDJSON over stdio），channel=chrome 用
 *   系统浏览器，规避 Playwright 自带 chromium 的版本匹配问题；
 * - 单例 + 跨轮次复用：守护进程随插件进程常驻，会话轮次之间浏览器不关，用户全程旁观；
 * - 登录态持久化：`launch_persistent_context(profileDir)`，登录一次跨会话有效；
 * - slowMo 默认 250ms：动作放慢，用户肉眼可跟。
 *
 * ## 路线 C：驱动 DSH 内置浏览器面板
 *
 * 所有工具带可选 `target` 参数：`managed`（默认，本插件的托管 Chrome）| `builtin`
 * （DSH 桌面端内置浏览器面板）。`builtin` 走无 CDP 命令通道（2026-10-10 v5 定稿）：
 * 守护进程把命令入队 → 随桌面端 boot manifest 常驻的客户端扩展（client.cjs）轮询取
 * 命令、用 webview 原生 API（executeJavaScript/capturePage/loadURL）执行 → 回报结果。
 * 普通重启桌面端即可用（无需任何启动参数）；面板未打开时 navigate 会自动打开。CDP
 * attach（browser_attach）降级为备用通道，仅在需要深度调试时使用。
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
/** 所有工具共用的 `target` 参数（managed=托管 Chrome；builtin=DSH 内置浏览器面板）。 */
const TARGET_PARAM = {
	type: "string",
	enum: ["managed", "builtin"],
	description: "操作目标：managed=本插件托管的有头 Chrome（默认）；builtin=DSH 桌面端内置浏览器面板（普通重启即可用；面板未打开时 navigate 会自动打开；无需 9222/attach）。"
};

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
			description: "打开一个 URL。默认在托管的有头 Chrome（用户可见，动作放慢便于旁观）中打开；target=builtin 时驱动 DSH 桌面端内置浏览器面板（面板未打开会自动打开，无需 CDP/attach）。返回最终 URL/标题/HTTP 状态。",
			parameters: {
				url: { type: "string", required: true, description: "要打开的完整 URL（含 http(s):// 或 file://）。" },
				wait_until: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "导航等待策略，默认 load；SPA 慢页面可用 domcontentloaded。" },
				timeout_ms: { type: "number", description: "导航超时（毫秒），默认 30000。" },
				target: TARGET_PARAM
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
					target: args.target
				}, (args.timeout_ms ?? config.defaultTimeoutMs) + 30000);
				const text = `已导航：${result.url}\n标题：${result.title || "（无）"}${result.status ? `\nHTTP 状态：${result.status}` : ""}`;
				logger.info(`[browser-bridge] navigate → ${result.url}`);
				return { text };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_evaluate",
			description: "在托管 Chrome 的当前页里执行任意 JS 并返回 JSON 结果。传表达式（`document.title`）或函数体（`() => document.querySelector('h1')?.textContent`）；返回 Promise 会自动等待。页面上下文同步执行，别在这里放凭据。",
			parameters: {
				expression: { type: "string", required: true, description: "JS 表达式或 `() => {...}` 函数体；async 函数返回的 Promise 会被自动等待。" },
				target: TARGET_PARAM
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("evaluate", { expression: args.expression, target: args.target });
				const raw = JSON.stringify(result.value, null, 1) ?? "undefined";
				return { text: `求值结果：\n${clip(raw, config.maxResultChars)}` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_screenshot",
			description: "对托管 Chrome 当前页截图，PNG 落盘并返回绝对路径（需要看图时用 read_image 读该路径）。支持整页截图与按 CSS 选择器截元素。用户屏幕上正开着这个浏览器，截图即他所见。",
			parameters: {
				full_page: { type: "boolean", description: "是否整页滚动截图（默认 false，只截视口）。" },
				selector: { type: "string", description: "只截该 CSS 选择器命中的第一个元素。" },
				timeout_ms: { type: "number", description: "截图超时（毫秒），默认 15000。" },
				target: TARGET_PARAM
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
					target: args.target
				});
				return { text: `截图已保存：${result.path}（${Math.round(result.bytes / 1024)}KB）\n页面：${result.title || "（无标题）"} — ${result.url}\n需要看图时用 read_image 读该路径。` };
			}
		}),
		toolDef(ctx, client, config, {
			name: "browser_dom",
			description: "读取托管 Chrome 当前页的 DOM：不给选择器 → 页面摘要（标题/URL/可见文本/全部输入框清单，登录页直接拿表单结构）；给 CSS 选择器 → 该元素 outerHTML。选不到元素会报错并给出可尝试的建议。",
			parameters: {
				selector: { type: "string", description: "CSS 选择器；省略则返回页面摘要。" },
				max_chars: { type: "number", description: "结果最大字符数，默认 20000。" },
				target: TARGET_PARAM
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("dom", { selector: args.selector, max_chars: args.max_chars ?? config.maxResultChars, target: args.target });
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
			description: "点击托管 Chrome 当前页里的元素。selector 用 Playwright 选择器语法（CSS、text=登录、role=button[name=提交] 等）；点击后等 DOM 稳定并返回新 URL/标题。注意红线：不要在生产系统里自动提交表单。",
			parameters: {
				selector: { type: "string", required: true, description: "Playwright 选择器（支持 CSS / text=xxx / role=xxx[name=yyy] 等）。" },
				timeout_ms: { type: "number", description: "等待元素可点击的超时（毫秒），默认 15000。" },
				target: TARGET_PARAM
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("click", {
					selector: args.selector,
					timeout_ms: args.timeout_ms ?? 15000,
					target: args.target
				}, (args.timeout_ms ?? 15000) + 20000);
				return { text: `已点击：${result.clicked}\n当前页：${result.title || "（无标题）"} — ${result.url}` };
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
			description: "移动端设备仿真开关/调参：内置面板默认已按手机视口展示（390 锁宽 + 移动 UA，客户端扩展负责），本工具用于调整宽度/UA 或 reset 还原。managed 目标下等价于调整托管 Chrome 视口。",
			parameters: {
				width: { type: "number", description: "仿真视口宽，默认 390。" },
				height: { type: "number", description: "仿真视口高，默认 844。" },
				device_scale_factor: { type: "number", description: "设备缩放，默认 3。" },
				mobile: { type: "boolean", description: "是否移动模式（含触摸仿真），默认 true。" },
				ua: { type: "string", description: "可选：覆盖 User-Agent（不传则保留原 UA）。" },
				reset: { type: "boolean", description: "true = 清除仿真恢复面板原生视口。" },
				target: TARGET_PARAM
			},
			output: {
				schema: { type: "object", additionalProperties: true, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(client, config, args) {
				const result = await client.request("emulate", {
					width: args.width,
					height: args.height,
					deviceScaleFactor: args.device_scale_factor,
					mobile: args.mobile,
					ua: args.ua,
					reset: args.reset,
					target: args.target
				});
				const emu = result.emulated;
				const desc = emu === false ? "已清除仿真，恢复原生视口" : `仿真中：${emu.width}×${emu.height} dsf${emu.deviceScaleFactor ?? "-"} mobile=${emu.mobile}${emu.ua ? " + 自定义 UA" : ""}`;
				return { text: `${desc}\n当前页：${result.url ?? "（未知）"}` };
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
	for (const definition of buildTools(ctx, client, config)) {
		disposers.push(ctx.tools.register(definition));
	}
	logger.info(`[browser-bridge] 已注册浏览器工具：${disposers.length} 个（profile=${expandPath(config.profileDir)}，python=${config.pythonBin}）`);
	if (config.announce) {
		ctx.systemPrompt.section({
			name: "browser-bridge:tools",
			order: config.sectionOrder,
			text: (context) => {
				const available = ["browser_navigate", "browser_evaluate", "browser_screenshot", "browser_dom", "browser_click", "browser_attach", "browser_emulate"].filter((toolName) => ctx.tools.get(toolName, context.scope) !== void 0);
				if (available.length === 0) return "";
				return [
					"可用浏览器控制工具（默认驱动一个**用户可见**的有头 Chrome，单例跨轮次复用，动作放慢便于用户旁观；登录态经持久 profile 跨会话保留）：",
					"",
					"- `browser_navigate(url)`：打开页面（自动启动浏览器）",
					"- `browser_dom(selector?)`：读页面摘要（标题/文本/输入框清单）或元素 outerHTML",
					"- `browser_evaluate(expression)`：页面里执行 JS，返回 JSON",
					"- `browser_click(selector)`：点击（支持 CSS / text= / role= 选择器）",
					"- `browser_screenshot(full_page?|selector?)`：截图落盘返回路径，需要看图用 read_image",
					"- `browser_emulate(width?|height?|ua?|reset?)`：移动端仿真开关/调参（内置面板默认已是手机视口，本工具用于调整/还原）",
					"- `browser_attach(cdp_port?, url_prefix?)`：【备用通道，一般不用】仅在需要 CDP 深度调试时 attach 到带参重启的桌面端",
					"",
					"典型链路：navigate → dom（找表单/元素）→ click/evaluate（操作）→ screenshot（回证）。选择器选不中先用 browser_dom 看真实结构。用户要求“操作 DSH 内置浏览器/面板”时：直接用 target=builtin（普通重启即可用；navigate 会自动打开面板；无需 9222/attach）。",
					"红线：不自动提交生产系统表单；登录内部系统先走 fe-local-autologin skill（凭据不进对话）；这些动作全部发生在用户屏幕上，保持可见、可中断。"
				].join("\n");
			}
		});
	}
	ctx.effect(function* () {
		for (const dispose of disposers) yield dispose;
		yield () => {
			void client.stop();
		};
	}, "browser-bridge: registered browser tools");
}

export { Config, apply, inject, name };
