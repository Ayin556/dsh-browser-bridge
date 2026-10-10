window.__ModuleLoader__.load({
	id: "dsh-browser-bridge",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-browser-bridge 客户端扩展 v5（2026-10-10 二轮加固）
		 * 内置浏览器面板的设备仿真切换（📱/🖥）+ 无 CDP 命令通道（agent 驱动面板）。
		 *
		 * v5 变更（无 CDP 驱动面板收尾）：
		 *  1) 命令通道加固：execCmd 同步异常也回报（不再让 daemon 空等超时）；fetch 全量超时
		 *     护栏；面板未打开时 navigate 自动开面板（sidebarRight 服务 / data-* DOM 双路回退）；
		 *  2) panel 诊断 op：宿主态快照（webviews/地址栏/引导瓦片/bridge stats），无 CDP 排障。
		 *
		 * v4 变更（连续两次桌面端冻结后的防冻加固包）：
		 *  1) 扫描节流：observer 回调只入 100ms 合并队列，不再同步跑 scan——即便未来某次
		 *     DOM 写漏了幂等护栏，风暴也退化成 10 次/秒的可呼吸循环（冻不死桌面端）；
		 *  2) 自动重载熔断：全局 reload 次数上限 RELOAD_CAP，防"webview 重挂载→新元素→
		 *     再重载"死循环；单元素仍由 dshBridgeUaApplied 保证至多一次；
		 *  3) 诊断仪表：window.__dshBridgeStats = {scans, applyChrome, creates, reloads}，
		 *     再冻结时经 CDP 读数即可定位循环类型；
		 *  4) 模拟 APP 导航栏默认关闭（用户裁决：视觉噪音），SHOW_APPBAR=true 可开回。
		 *
		 * ⚠ 冻结红线（2026-10-10 实录 ×2）：本文件运行在全树 childList observer 的回调链上，
		 * 任何"无条件 DOM 写"都会自我触发 observer 形成微任务风暴、冻死整个桌面端。
		 * 铁律：textContent / insertBefore / appendChild 一律先比较、变了才写；
		 * style.* 属 attribute 写不进 childList 记录，可放宽。
		 */
		function apply(ctx) {
			var VIEWPORT_W = 390;
			var BAR_H = "44px";
			var SHOW_APPBAR = false;
			var RELOAD_CAP = 10;
			var SCAN_THROTTLE_MS = 100;
			var MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
			var CSS_BACK = "width:44px;text-align:center;font-size:22px;line-height:44px;color:#222;flex:none;cursor:pointer;user-select:none;";
			var CSS_TITLE = "flex:1;text-align:center;font-size:16px;font-weight:500;color:#222;line-height:44px;margin:0 44px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
			var CSS_TOGGLE = "width:44px;text-align:center;font-size:17px;line-height:44px;cursor:pointer;user-select:none;flex:none;";
			var DOM_SUMMARY_JS = "(() => { const inputs = [...document.querySelectorAll('input,textarea,select')].slice(0, 40).map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || null, id: el.id || null, name: el.name || null, placeholder: el.placeholder || null, value: el.type === 'password' ? null : (el.value || null) })); return { title: document.title, url: location.href, text: document.body ? document.body.innerText : '', inputs }; })()";

			// 诊断仪表（CDP 可读）
			var stats = { scans: 0, applyChrome: 0, creates: 0, reloads: 0 };
			try { window.__dshBridgeStats = stats; } catch (e) {}

			function uaOf(wv) { try { return wv.getUserAgent() || null; } catch (e) { return null; } }

			// UA 仿真：mobile=true 换移动 UA，false 还原原 UA；doReload=true 时重载立即生效
			function syncUa(wv, mobile, doReload) {
				var cur = uaOf(wv);
				if (cur === null) return;
				if (mobile && !wv.__dshOrigUa) wv.__dshOrigUa = cur;
				var want = mobile ? MOBILE_UA : (wv.__dshOrigUa || cur);
				if (cur !== want) {
					try { wv.setUserAgent(want); } catch (e) { return; }
					if (doReload) {
						wv.dataset.dshBridgeUaApplied = mobile ? "1" : "";
						try { wv.reload(); } catch (e) { /* guest 未就绪 */ }
					}
				}
			}

			// 首挂 dom-ready 自动重载一次（HTML 请求可能赶在 setUserAgent 之前发出）；
			// 全局熔断防"重挂载→新元素→再重载"风暴
			function autoReloadOnce(wv) {
				if (wv.dataset.dshBridgeMobile === "0" || wv.dataset.dshBridgeUaApplied === "1") return;
				var u = "";
				try { u = wv.getURL() || ""; } catch (e) {}
				// v5.2：about:blank 的 dom-ready 不重载也不标记（重载空白无意义，且会与 agent 首航竞态）
				if (u === "" || u.indexOf("about:blank") === 0) return;
				if (stats.reloads >= RELOAD_CAP) return;
				wv.dataset.dshBridgeUaApplied = "1";
				stats.reloads++;
				try { wv.reload(); } catch (e) { /* guest 未就绪 */ }
			}

			// v5.3：命令流首航可能赶在 setUserAgent 之前发出（扫描节流 + 地址栏首航竞态）→
			// 在安全时机（导航完成、无进行中的导航）补设移动 UA 并 reload 一次，让页面以移动
			// UA 重新加载。此后 UA 已正确，不再触发。PC 模式（mobile=0）不动。
			function fixUaAfterNav(wv) {
				if (wv.dataset.dshBridgeMobile === "0") return Promise.resolve(false);
				var cur = uaOf(wv);
				if (!cur || cur === MOBILE_UA) return Promise.resolve(false);
				if (!wv.__dshOrigUa) wv.__dshOrigUa = cur;
				try { wv.setUserAgent(MOBILE_UA); } catch (e) { return Promise.resolve(false); }
				wv.dataset.dshBridgeUaApplied = "1";
				try { wv.reload(); } catch (e) { return Promise.resolve(false); }
				stats.reloads++;
				// 等 reload 结束（isLoading 转 false）；失败静默，不阻塞 navigate 结果
				return waitFor(function () { try { return wv.isLoading() ? null : true; } catch (e) { return true; } }, 10000, 250)
					.then(function () { return true; })
					.catch(function () { return false; });
			}
			function ensureChild(parent, cls, css, text) {
				var el = parent.querySelector("." + cls);
				if (!el) { el = document.createElement("div"); el.className = cls; parent.appendChild(el); stats.creates++; }
				if (el.style.cssText !== css) el.style.cssText = css;
				if (text !== void 0 && text !== null && el.textContent !== text) el.textContent = text;
				return el;
			}

			function applyChrome(wv, mobile, width) {
				stats.applyChrome++;
				var W = width || VIEWPORT_W;
				var parent = wv.parentElement;
				if (!parent) return;
				if (getComputedStyle(parent).position === "static") {
					parent.dataset.dshBridgePos = "1";
					parent.style.position = "relative";
				}
				// 容器栏：每个 webview 一份（class 定位，expando 持引用）；SHOW_APPBAR=false 不建，
				// 并清掉 daemon 遗留路径可能注入的旧 bar（agent 会话内历史注入）
				var bar = wv.__dshBar;
				if (!SHOW_APPBAR) {
					if (bar) { try { bar.remove(); } catch (e) {} wv.__dshBar = null; }
					try {
						var legacyBar = parent.querySelector(":scope > .dsh-bridge-appbar, :scope > #dsh-bridge-appbar");
						if (legacyBar) { try { legacyBar.remove(); } catch (e) {} }
					} catch (e) { /* :scope 不可用时忽略 */ }
				} else {
					if (!bar || !bar.isConnected) {
						bar = document.createElement("div");
						bar.className = "dsh-bridge-appbar";
						bar.style.cssText = "position:absolute;top:0;left:0;height:" + BAR_H + ";background:#fff;border-bottom:1px solid #eee;display:flex;align-items:center;box-sizing:border-box;z-index:9;";
						parent.insertBefore(bar, wv);
						stats.creates++;
					} else if (bar.parentElement !== parent) {
						parent.insertBefore(bar, wv);
					}
					wv.__dshBar = bar;
					bar.style.position = "absolute";
					bar.style.top = "0";
					bar.style.left = "0";
					bar.style.width = mobile ? W + "px" : "100%";
					var back = ensureChild(bar, "dsh-bridge-back", CSS_BACK, "\u2039");
					var title = ensureChild(bar, "dsh-bridge-title", CSS_TITLE, null);
					ensureChild(bar, "dsh-bridge-toggle", "display:none;", null);
					back.onclick = function () { try { if (wv.canGoBack()) wv.goBack(); } catch (e) { /* guest 未就绪 */ } };
					// 标题只在变化时写（写审计幂等，防 observer 风暴）
					var t = wv.title || "";
					if (title.textContent !== t) title.textContent = t;
				}
				if (mobile) {
					wv.style.width = W + "px";
					wv.style.maxWidth = W + "px";
					wv.style.minWidth = W + "px";
					wv.style.flex = "0 0 " + W + "px";
					if (SHOW_APPBAR) {
						wv.style.marginTop = BAR_H;
						wv.style.height = "calc(100% - " + BAR_H + ")";
					} else {
						wv.style.marginTop = "";
						wv.style.height = "";
					}
				} else {
					wv.style.width = "";
					wv.style.maxWidth = "";
					wv.style.minWidth = "";
					wv.style.flex = "";
					wv.style.marginTop = "";
					wv.style.height = "";
				}
				// 工具栏切换钮：插在"这个面板自己的"工具栏 form 里
				var root = wv.closest('[class*="_root"]') || document;
				var form = root.querySelector("form");
				if (form) {
					var dv = wv.__dshToggle;
					if (!dv || !dv.isConnected) {
						dv = document.createElement("div");
						dv.className = "dsh-bridge-devtoggle";
						dv.style.cssText = CSS_TOGGLE;
						var btns = form.querySelectorAll("button");
						var last = btns[btns.length - 1];
						if (last && last.parentElement === form) form.insertBefore(dv, last);
						else form.appendChild(dv);
						stats.creates++;
					}
					wv.__dshToggle = dv;
					var dt = mobile ? "\uD83D\uDDA5" : "\uD83D\uDCF1"; // 🖥 / 📱（点它切到另一态）
					if (dv.textContent !== dt) dv.textContent = dt;
					var dtitle = mobile ? "切换为 PC 视图" : "切换为手机视图";
					if (dv.title !== dtitle) dv.title = dtitle;
					dv.onclick = function () { setMobile(wv, !mobile, null, true); };
				}
			}

			function setMobile(wv, mobile, width, fromUser) {
				wv.dataset.dshBridgeMobile = mobile ? "1" : "0";
				if (width) wv.dataset.dshBridgeWidth = String(width);
				applyChrome(wv, mobile, width);
				syncUa(wv, mobile, !!fromUser); // 用户点击 → UA + reload 立即生效；agent 驱动 → 只换 UA 不 reload
			}

			function resetChrome(wv) {
				var keys = ["width", "maxWidth", "minWidth", "flex", "marginTop", "height"];
				for (var i = 0; i < keys.length; i++) wv.style[keys[i]] = "";
				if (wv.__dshBar) { try { wv.__dshBar.remove(); } catch (e) {} wv.__dshBar = null; }
				if (wv.__dshToggle) { try { wv.__dshToggle.remove(); } catch (e) {} wv.__dshToggle = null; }
				var parent = wv.parentElement;
				if (parent && parent.dataset.dshBridgePos) { delete parent.dataset.dshBridgePos; parent.style.position = ""; }
				if (wv.__dshOrigUa) { try { wv.setUserAgent(wv.__dshOrigUa); } catch (e) {} }
				wv.dataset.dshBridgeDisabled = "1"; // scan 不再接管
				delete wv.dataset.dshBridgeMobile;
				delete wv.dataset.dshBridgeReady;
				delete wv.dataset.dshBridgeUaApplied;
				delete wv.dataset.dshBridgeWidth;
			}

			function ensureWebview(wv) {
				if (wv.dataset.dshBridgeReady === "1") {
					// 已就管：只刷新容器（面板重渲染可能重排）
					applyChrome(wv, wv.dataset.dshBridgeMobile !== "0", parseInt(wv.dataset.dshBridgeWidth || "0", 10) || null);
					return;
				}
				wv.dataset.dshBridgeReady = "1";
				wv.dataset.dshBridgeWidth = String(VIEWPORT_W);
				// agent 自动开面板产生的首个 webview：跳过"首挂自动重载"（避免与首航竞态）
				if (window.__dshBridgeSuppressNext) {
					delete window.__dshBridgeSuppressNext;
					wv.dataset.dshBridgeUaApplied = "1";
				}
				// 首挂即备好移动 UA（后续导航/重定向即生效）
				var cur = uaOf(wv);
				if (cur && cur !== MOBILE_UA) { wv.__dshOrigUa = cur; try { wv.setUserAgent(MOBILE_UA); } catch (e) {} }
				wv.addEventListener("dom-ready", function () { autoReloadOnce(wv); });
				setMobile(wv, true, VIEWPORT_W, false); // 默认手机视口（移动端 H5 调试优先）
				// daemon（agent 的 browser_emulate 工具）委托入口
				wv.addEventListener("dsh-bridge-emulate", function (e) {
					var d = (e && e.detail) || {};
					if (d.mode === "reset") { resetChrome(wv); return; }
					setMobile(wv, d.mode !== "pc", d.width || null, false);
				});
			}

			function scan() {
				stats.scans++;
				var wvs = document.querySelectorAll("webview[data-sidebar-browser-frame=webview]");
				for (var i = 0; i < wvs.length; i++) {
					if (wvs[i].dataset.dshBridgeDisabled === "1") continue;
					try { ensureWebview(wvs[i]); } catch (e) { /* 面板渲染中间态，下轮再补 */ }
				}
			}

			// 节流扫描：observer 只入 100ms 合并队列——任何残留的非幂等写最多造成
			// 10 次/秒的循环（可呼吸），不会再微任务风暴冻死桌面端
			var scanQueued = false;
			function queueScan() {
				if (scanQueued) return;
				scanQueued = true;
				setTimeout(function () { scanQueued = false; scan(); }, SCAN_THROTTLE_MS);
			}

			scan();
			var observer = new MutationObserver(function () { queueScan(); });
			observer.observe(document.documentElement, { childList: true, subtree: true });
			// 兜底轮询（低频）：容器样式被宿主应用重渲染覆盖 / 可见 webview 切换时自动修复
			setInterval(function () { scan(); }, 3000);

			// ---- 无 CDP 命令通道 v5（2026-10-10 二轮加固）----
			// agent（server 侧）→ daemon 命令队列（9330 控制端口）→ 本扩展轮询取命令
			// → 用 <webview> 原生 API（executeJavaScript/capturePage/loadURL/goBack…）执行
			// → POST /cmd/result 回报。彻底摆脱 --remote-debugging-port 带参重启。
			// v5 修复：① execCmd 全链路保证返回 Promise（此前同步 throw 会让命令永不回报、
			//   daemon 空等超时——"browser_navigate 卡死"的元凶之一）；② 面板未打开时自动打开
			//   （官方 sidebarRight 服务优先 + data-* DOM 回退），navigate 冷启动即可用；
			//   ③ panel 诊断 op（宿主态快照，无 CDP 排障）；④ fetch 加超时防半连接拖死轮询。
			// ⚠ 铁律：所有 webview API 调用一律包 withTimeout 超时护栏（capturePage 曾实测
			//   卡宿主 20s+），失败回报可读错误、绝不让宿主挂起。
			var CTRL = "http://127.0.0.1:9330";
			var POLL_MS = 200;

			// 官方 sidebarRight 服务（懒绑定；拿不到就只走 DOM 回退路径）
			var sidebarRight = null;
			try {
				if (ctx && typeof ctx.inject === "function") {
					ctx.inject(["sidebarRight"], function (sctx) {
						try { sidebarRight = (sctx && sctx.sidebarRight) || null; } catch (e) { sidebarRight = null; }
					});
				}
			} catch (e) { /* 服务不可用：DOM 回退兜底 */ }

			function withTimeout(promise, ms, label) {
				return Promise.race([
					promise,
					new Promise(function (_, rej) {
						setTimeout(function () { rej(new Error(label + " 超时(" + ms + "ms)")); }, ms);
					})
				]);
			}

			function fetchWithTimeout(url, opts, ms) {
				var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
				var o = opts || {};
				if (ctl) o.signal = ctl.signal;
				var timer = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (e) {} } }, ms);
				return fetch(url, o).then(
					function (r) { clearTimeout(timer); return r; },
					function (e) { clearTimeout(timer); throw e; }
				);
			}

			function waitFor(fn, timeoutMs, stepMs) {
				var deadline = Date.now() + timeoutMs;
				return new Promise(function (resolve, reject) {
					(function tick() {
						var v = null;
						try { v = fn(); } catch (e) {}
						if (v) { resolve(v); return; }
						if (Date.now() > deadline) { reject(new Error("等待超时(" + timeoutMs + "ms)")); return; }
						setTimeout(tick, stepMs || 200);
					})();
				});
			}

			function allWebviews() {
				return document.querySelectorAll("webview[data-sidebar-browser-frame=webview]");
			}

			function pickWebview() {
				var wvs = allWebviews();
				var fallback = null;
				for (var i = 0; i < wvs.length; i++) {
					if (wvs[i].dataset.dshBridgeDisabled === "1") { if (!fallback) fallback = wvs[i]; continue; }
					return wvs[i];
				}
				return fallback; // 全被 resetChrome 标记过也兜底：命令通道仍可驱动
			}

			// ---- 面板自动打开（仅 navigate 在无 webview 时触发）----
			function findAddressInput() {
				var inputs = document.querySelectorAll("input[class*='_address']");
				var first = null;
				for (var i = 0; i < inputs.length; i++) {
					var el = inputs[i];
					try { if (el.closest("[hidden], [aria-hidden='true']")) continue; } catch (e) {}
					if (!first) first = el;
					if (el.offsetWidth > 0) return el;
				}
				return first;
			}

			function fillAddressAndGo(input, url) {
				return new Promise(function (resolve, reject) {
					try {
						var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
						setter.call(input, url);
						input.dispatchEvent(new Event("input", { bubbles: true }));
					} catch (e) { reject(new Error("地址栏填充失败：" + (e && e.message || e))); return; }
					setTimeout(function () {
						try {
							var form = input.closest("form");
							var go = form ? form.querySelector("button[class*='_addressGo'], button[type='submit']") : null;
							if (!go) { reject(new Error("未找到面板地址栏「前往」按钮")); return; }
							go.click();
							resolve({ ok: true });
						} catch (e) { reject(e); }
					}, 120);
				});
			}

			// 服务通道单次尝试：先展开（如收起；toggleExpanded 内含 flushSync 提交），再取
			// "新鲜 target" 开浏览器标签。⚠ target 有新鲜度（occurrence 对象做身份比较）：
			// 收起态捕获的 target 在展开重渲染后失效、openTabFromTarget 会静默不做事 →
			// 必须先展开再取；返回 true 仅表示"发起过"，最终由地址栏出现与否裁决。
			function openViaService() {
				if (!sidebarRight || typeof sidebarRight.openTabFromTarget !== "function") return false;
				try {
					if (typeof sidebarRight.isExpanded === "function" && !sidebarRight.isExpanded()) sidebarRight.toggleExpanded();
					var target = typeof sidebarRight.commandTarget === "function" ? sidebarRight.commandTarget(null) : void 0;
					if (!target) return false;
					sidebarRight.openTabFromTarget("browser", target);
					return true;
				} catch (e) {
					return false;
				}
			}

			// 双通道重试：服务通道（≤2 次，第二次在 1.5s 后兜底）+ DOM 通道（展开钮 +
			// 「浏览器」引导瓦片；每 tick 幂等，瓦片按节点身份去重防重复开）。谁先把浏览器
			// 标签开出来（地址栏出现）算谁；trace 供失败时报错定位。
			function openPanelSmart() {
				var trace = [];
				var tileClicked = null;
				var tries = 0, MAX = 12; // 12 × 250ms ≈ 3s
				var t0 = Date.now(), svcCount = 0, nextSvcAt = 0;
				function tick() {
					if (findAddressInput() || pickWebview()) return; // 成功/已有页面：收工
					tries++;
					var ms = Date.now() - t0;
					if (svcCount < 2 && ms >= nextSvcAt) {
						svcCount++;
						nextSvcAt = svcCount === 1 ? 1500 : 1e9;
						trace.push("svc" + svcCount + "=" + openViaService());
					}
					try {
						var expand = document.querySelector("[data-sidebar-right-expand]");
						if (expand) { expand.click(); trace.push("expand"); }
						var tile = document.querySelector("button[data-sidebar-right-guide-entry='browser']");
						if (tile && tile !== tileClicked) { tileClicked = tile; tile.click(); trace.push("tile"); }
					} catch (e) { trace.push("domErr:" + (e && e.message || e)); }
					if (tries < MAX) setTimeout(tick, 250);
				}
				tick();
				return trace;
			}

			// 打开面板到"有地址栏"；url 非空时经地址栏发起首航（不依赖既有 webview）
			function ensurePanel(url) {
				if (pickWebview()) return Promise.resolve({ opened: "existing-webview", trace: [] });
				var existing = findAddressInput();
				if (existing) {
					if (!url) return Promise.resolve({ opened: "existing-tab", trace: [] });
					return fillAddressAndGo(existing, url).then(function () { return { opened: "existing-tab", trace: [] }; });
				}
				window.__dshBridgeSuppressNext = true; // 抑制该 tab 首挂自动重载（防首航竞态）
				var trace = openPanelSmart();
				return waitFor(findAddressInput, 7000, 150)
					.then(function (input) {
						var via = trace.some(function (t) { return t.indexOf("svc") === 0; }) ? "service+dom" : "dom";
						if (!url) return { opened: via, trace: trace };
						return fillAddressAndGo(input, url).then(function () { return { opened: via, trace: trace }; });
					})
					.catch(function () {
						throw new Error("内置浏览器面板未打开且自动打开失败（trace: " + trace.join("|") + "）；请确认 DSH 里有打开的会话，或手动在右侧栏打开「浏览器」面板后再试");
					});
			}

			// navigate 且无 webview：自动开面板（地址栏首航）→ 等 webview 挂载
			function ensureWebviewReady(url) {
				var wv = pickWebview();
				if (wv) return Promise.resolve(wv);
				return ensurePanel(url).then(function (info) {
					return waitFor(pickWebview, 10000, 200).catch(function () {
						throw new Error("面板已打开（" + info.opened + "）但页面 webview 未在 10s 内挂载（地址栏自动填充可能未生效）");
					});
				});
			}

			function wrapEval(expr) {
				var s = (expr || "").trim();
				if (/^async\b/.test(s) || s.indexOf("function") === 0 || (s.charAt(0) === "(" && s.indexOf("=>") > -1)) {
					return "(" + s + ")()";
				}
				return s;
			}

			// executeJavaScript 在 guest 里求值；返回结构化克隆值。函数体形态已补调用。
			function runInGuest(wv, code, ms, label) {
				return withTimeout(wv.executeJavaScript(code), ms, label || "guest 执行")
					.then(function (v) { return v === undefined ? null : v; })
					.catch(function (e) {
						throw new Error(label + "：" + String(e && e.message || e).slice(0, 300));
					});
			}

			// 宿主态诊断 / 显式开面板（不要求已有 webview）
			function panelOp(p) {
				var action = (p && p.action) || "state";
				if (action === "state") {
					var wv = pickWebview();
					var out = {
						webviews: allWebviews().length,
						disabled: document.querySelectorAll("webview[data-sidebar-browser-frame=webview][data-dsh-bridge-disabled='1']").length,
						addressInput: !!findAddressInput(),
						guideTile: !!document.querySelector("button[data-sidebar-right-guide-entry='browser']"),
						guideEntries: [].map.call(document.querySelectorAll("[data-sidebar-right-guide-entry]"), function (el) { return el.getAttribute("data-sidebar-right-guide-entry"); }),
						expandBtn: !!document.querySelector("[data-sidebar-right-expand]"),
						sidebarRight: !!sidebarRight,
						url: wv ? (wv.getURL() || "") : "",
						title: wv ? (wv.getTitle() || "") : "",
						stats: window.__dshBridgeStats || null
					};
					return Promise.resolve(out);
				}
				if (action === "open") {
					return ensurePanel((p && p.url) || null).then(function (r) { return { opened: r.opened }; });
				}
				return Promise.reject(new Error("未知 panel action：" + action));
			}

			// v5.3.4：导航自愈版——loadURL 的 Promise 与实际导航状态在高竞态下会分叉
			// （重启自恢复/地址栏首航相遇）：被顶掉（ERR_ABORTED / (-3)）不报错，交给
			// 轮询自愈（3s 补发一次）；成功判据="目标被加载 或 页面已离开原址"；其余
			// 错误如实上报；deadline 兜底返回当前实况（绝不空转挂起）。
			function doNavigate(wv, p) {
				var t0 = Date.now();
				var target = p.url;
				var cur0 = wv.getURL() || "";
				var hadPage = !(cur0 === "" || cur0.indexOf("about:blank") === 0);
				function urlMatchesTarget(u) {
					return u === target || u.indexOf(target) === 0 || target.indexOf(u) === 0;
				}
				var chain = withTimeout(wv.loadURL(target), (p.timeout_ms || 30000), "loadURL").catch(function (e) {
					var msg = String(e && e.message || e);
					if (msg.indexOf("ERR_ABORTED") >= 0 || msg.indexOf("(-3)") >= 0) return "aborted";
					throw e;
				});
				return chain.then(function () {
					var deadline = Date.now() + (p.timeout_ms || 30000);
					var kicked = false; // 3s 仍空白/仍停在原页 → 补发一次 loadURL
					function wait() {
						return runInGuest(wv, "document.readyState", 5000, "readyState")
							.catch(function () { return null; }) // 导航中 executeJavaScript 可能挂起/瞬态失败 → 视为"未完成"继续轮询
							.then(function (st) {
								var u = wv.getURL() || "";
								var blank = u === "" || u.indexOf("about:blank") === 0;
								if (st === "complete" && !blank && (u !== cur0 || urlMatchesTarget(u))) {
									return { url: u, title: wv.getTitle() || "", ms: Date.now() - t0, hadPage: hadPage };
								}
								var stuck = blank || u === cur0; // 空白 或 还停在命令前的页面 = 没生效
								if (!kicked && stuck && Date.now() > t0 + 3000) {
									kicked = true;
									try { wv.loadURL(target); } catch (e) {}
								}
								if (Date.now() > deadline) {
									return { url: u || target, title: wv.getTitle() || "", ms: Date.now() - t0, hadPage: hadPage, note: "等待超时（当前：" + (u || "空白") + "）" };
								}
								return new Promise(function (res) { setTimeout(function () { res(wait()); }, 300); });
							});
					}
					return wait();
				}).then(function (result) {
					// v5.3：首航后补 UA（若首航请求用了旧 UA）——reload 一次后返回最终结果
					return fixUaAfterNav(wv).then(function () { return result; });
				});
			}

			function imageToBase64(img) {
				if (!img) throw new Error("截图未返回图像");
				if (typeof img.toDataURL === "function") {
					var d = img.toDataURL();
					var idx = d.indexOf("base64,");
					if (idx >= 0) return d.slice(idx + 7);
					throw new Error("toDataURL 未返回 base64");
				}
				if (typeof img.toPNG === "function") {
					var buf = img.toPNG();
					var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
					var chunk = 32768;
					var out = "";
					for (var i = 0; i < bytes.length; i += chunk) {
						out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
					}
					return btoa(out);
				}
				throw new Error("截图对象无 toDataURL/toPNG 方法");
			}

			function execCmdInner(cmd) {
				var op = cmd.op, p = cmd.params || {};
				if (op === "panel") return panelOp(p);
				var wv = pickWebview();
				if (!wv) {
					if (op === "navigate") {
						return ensureWebviewReady(p.url).then(function (w) { return doNavigate(w, p); });
					}
					return Promise.reject(new Error("未找到面板 webview（先在内置浏览器面板里打开一个页面；navigate 可自动打开面板）"));
				}
				if (op === "navigate") return doNavigate(wv, p);
				if (op === "evaluate") {
					return runInGuest(wv, wrapEval(p.expression), 20000, "evaluate")
						.then(function (v) { return { value: v }; });
				}
				if (op === "dom") {
					var maxChars = p.max_chars || 20000;
					if (p.selector) {
						var sel = JSON.stringify(p.selector);
						return runInGuest(wv,
							"document.querySelector(" + sel + ") ? document.querySelector(" + sel + ").outerHTML : ''",
							15000, "dom(selector)").then(function (html) {
								if (!html) throw new Error("未找到元素：" + p.selector + "（用不带 selector 的 dom 摘要看看真实结构）");
								var s = String(html);
								return { selector: p.selector, html: s.slice(0, maxChars), html_length: s.length, truncated: s.length > maxChars, url: wv.getURL() || "" };
							});
						}
						return runInGuest(wv, DOM_SUMMARY_JS, 15000, "dom 摘要")
							.then(function (info) {
								info = info || {};
								var text = String(info.text || "");
								info.text = text.slice(0, maxChars);
								info.text_truncated = text.length > maxChars;
								info.url = wv.getURL() || "";
								return info;
							});
				}
				if (op === "click") {
					var csel = JSON.stringify(p.selector);
					var code = "(() => { const el = document.querySelector(" + csel + "); if (!el) throw new Error('未找到元素'); "
						+ "el.scrollIntoView({block:'center', inline:'center'}); "
						+ "el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window})); return true; })()";
					return runInGuest(wv, code, 15000, "click")
						.then(function () {
							return new Promise(function (res) {
								setTimeout(function () {
									res({ clicked: p.selector, url: wv.getURL() || "", title: wv.getTitle() || "" });
								}, 400);
							});
						});
				}
				if (op === "screenshot") {
					// ⚠ capturePage 曾实测卡宿主：必须护栏（6s），失败报可读错
					var pre = Promise.resolve(null);
					if (p.selector) {
						var ssel = JSON.stringify(p.selector);
						var rectJs = "(() => { const el = document.querySelector(" + ssel + "); if (!el) throw new Error('未找到元素：' + " + ssel + "); el.scrollIntoView({block:'center', inline:'center'}); const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()";
						// 页面导航中 executeJavaScript 可能瞬态失败（GUEST_VIEW_MANAGER_CALL）→ 重试一次
						pre = runInGuest(wv, rectJs, 8000, "selector rect")
							.catch(function () {
								return new Promise(function (res) { setTimeout(res, 500); })
									.then(function () { return runInGuest(wv, rectJs, 8000, "selector rect(重试)"); });
							});
					}
					return pre.then(function (rect) {
						var cap = rect ? wv.capturePage(rect) : wv.capturePage();
						return withTimeout(cap, 6000, "capturePage");
					}).then(function (img) {
						return { base64: imageToBase64(img), url: wv.getURL() || "", title: wv.getTitle() || "" };
					}).catch(function (e) {
						throw new Error("capturePage 截图失败：" + String(e && e.message || e).slice(0, 200));
					});
				}
				if (op === "emulate") {
					if (p.reset) { resetChrome(wv); }
					else { setMobile(wv, p.mobile !== false, p.width || null, false); if (p.ua) { try { wv.setUserAgent(p.ua); } catch (e) {} } }
					return Promise.resolve({ emulated: { width: p.width || 390, mobile: p.mobile !== false }, url: wv.getURL() || "" });
				}
				if (op === "back") {
					try { if (wv.canGoBack()) wv.goBack(); } catch (e) { /* guest 未就绪 */ }
					return new Promise(function (res) {
						setTimeout(function () { res({ back: true, url: wv.getURL() || "", title: wv.getTitle() || "" }); }, 400);
					});
				}
				return Promise.reject(new Error("未知命令 op：" + op));
			}

			// 同步异常也保证返回 rejected Promise（否则命令永不回报 → daemon 空等超时）
			function execCmd(cmd) {
				try {
					return Promise.resolve(execCmdInner(cmd));
				} catch (e) {
					return Promise.reject(e);
				}
			}

			function reportResult(id, ok, payload) {
				return fetchWithTimeout(CTRL + "/cmd/result", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(ok ? { id: id, ok: true, result: payload } : { id: id, ok: false, error: String(payload && payload.message || payload) })
				}, 8000).catch(function () { /* 回报失败静默，下轮重试取新命令 */ });
			}

			function pollLoop() {
				fetchWithTimeout(CTRL + "/cmd/poll", { cache: "no-store" }, 8000)
					.then(function (r) { return r.json(); })
					.then(function (data) {
						var cmd = data && data.cmd;
						if (!cmd) { setTimeout(pollLoop, POLL_MS); return; }
						execCmd(cmd)
							.then(
								function (res) { return reportResult(cmd.id, true, res); },
								function (err) { return reportResult(cmd.id, false, err && err.message || String(err)); }
							)
							.then(
								function () { setTimeout(pollLoop, POLL_MS); },
								function () { setTimeout(pollLoop, POLL_MS); }
							);
					})
					.catch(function () { setTimeout(pollLoop, 600); });
			}
			pollLoop();

		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
