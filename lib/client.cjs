window.__ModuleLoader__.load({
	id: "dsh-browser-bridge",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-browser-bridge 客户端扩展 v5（2026-10-10 二轮加固）
		 * 内置浏览器面板的设备仿真（机型下拉，对齐 Chrome DevTools）+ 无 CDP 命令通道（agent 驱动面板）。
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
			// （旧的单钮手机/电脑切换已由机型下拉取代，2026-10-14 删除）

			// ── 机型下拉（2026-10-14 加；对齐 Chrome DevTools 设备工具栏）──
			// 数据来自 daemon 的 GET /devices（源头是插件的 lib/devices.js，单一数据源）。
			// 下发的"完美仿真"由 daemon 走 CDP（需已 browser_attach）；拿不到就本地 CSS 近似 + 徽标如实标注。
			var DEVICE_ROWS = null;   // 缓存；**空表不缓存**（daemon 可能还没收到 config 下发）
			var DEVICE_GROUPS = [["phone", "手机"], ["tablet", "平板"], ["notebook", "笔记本"], ["smart-display", "智能屏"]];
			var CSS_DEV_SELECT = "font-size:12px;height:26px;max-width:168px;border:1px solid #d8d8d8;border-radius:6px;background:#fff;color:#222;flex:none;";
			var CSS_DEV_ROTATE = "width:26px;text-align:center;font-size:15px;line-height:26px;cursor:pointer;user-select:none;flex:none;";
			var CSS_DEV_BADGE = "font-size:11px;line-height:16px;padding:1px 6px;border-radius:9px;margin-left:5px;flex:none;white-space:nowrap;cursor:default;";
			var DEVICE_BADGE = {
				cdp: { bg: "#e6f6ea", fg: "#1a7f37", text: "CDP" },
				css: { bg: "#fff4e5", fg: "#9a5b00", text: "CSS" },
				off: { bg: "#eef1f5", fg: "#3c4655", text: "原生" }
			};

			// 设备选择的"粘性"（跨 webview / 跨重启）：与 Chrome DevTools 一致——机型是全局设置，
			// 不是每 tab 一份。否则用户在面板里选了"原生·PC"，新开一个页面（新 webview）又会
			// 回到默认 390 手机视口，看起来像"选了 PC 但还是移动端"。
			var CHOICE_KEY = "dsh-bridge-device-choice-v1";
			var LAST_CHOICE = loadChoice();

			function loadChoice() {
				try {
					var raw = window.localStorage ? window.localStorage.getItem(CHOICE_KEY) : null;
					if (raw) {
						var o = JSON.parse(raw);
						if (o && typeof o.value === "string" && o.value) {
							return { value: o.value, orientation: o.orientation === "horizontal" ? "horizontal" : "vertical" };
						}
					}
				} catch (e) { /* localStorage 不可用（隐私模式等）→ 用默认 */ }
				return { value: "default390", orientation: "vertical" };
			}

			function saveChoice(value, orientation) {
				LAST_CHOICE = { value: String(value), orientation: orientation === "horizontal" ? "horizontal" : "vertical" };
				try { if (window.localStorage) window.localStorage.setItem(CHOICE_KEY, JSON.stringify(LAST_CHOICE)); } catch (e) { /* 忽略 */ }
			}
			var DOM_SUMMARY_JS = "(() => { const inputs = [...document.querySelectorAll('input,textarea,select')].slice(0, 40).map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || null, id: el.id || null, name: el.name || null, placeholder: el.placeholder || null, value: el.type === 'password' ? null : (el.value || null) })); return { title: document.title, url: location.href, text: document.body ? document.body.innerText : '', inputs }; })()";

			// 诊断仪表（CDP 可读）
			var stats = { scans: 0, applyChrome: 0, creates: 0, reloads: 0 };
			try { window.__dshBridgeStats = stats; } catch (e) {}

			function uaOf(wv) { try { return wv.getUserAgent() || null; } catch (e) { return null; } }

			// 目标 UA 的三级优先：机型 UA（下拉选了具体机型）＞ 默认移动 UA ＞ 原生 UA。
			// 引入 __dshDeviceUa 的原因：选了 iPhone 就不能被 MOBILE_UA(默认 Pixel/Android) 覆盖。
			function desiredUa(wv, mobile) {
				if (mobile && wv.__dshDeviceUa) return wv.__dshDeviceUa;
				return mobile ? MOBILE_UA : (wv.__dshOrigUa || uaOf(wv));
			}

			// UA 仿真：mobile=true 换移动 UA，false 还原原 UA；doReload=true 时重载立即生效
			function syncUa(wv, mobile, doReload) {
				var cur = uaOf(wv);
				if (cur === null) return;
				if (mobile && !wv.__dshOrigUa) wv.__dshOrigUa = cur;
				var want = desiredUa(wv, mobile);
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
				// isNative 是双保险：即便 dshBridgeMobile 标记缺失，原生态也绝不做"移动 UA 重载"
				if (isNative(wv) || wv.dataset.dshBridgeMobile === "0" || wv.dataset.dshBridgeUaApplied === "1") return;
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
				// isNative 是双保险（2026-10-14 加的）：原生态下 **绝不**把 UA 改回移动 UA。
				// 之前只判 dshBridgeMobile，一旦该标记被清掉就会误判成移动模式 → 用户选的"原生·PC"被静默改回移动端。
				if (isNative(wv) || wv.dataset.dshBridgeMobile === "0") return Promise.resolve(false);
				var cur = uaOf(wv);
				var want = desiredUa(wv, true);
				if (!cur || cur === want) return Promise.resolve(false);
				if (!wv.__dshOrigUa) wv.__dshOrigUa = cur;
				try { wv.setUserAgent(want); } catch (e) { return Promise.resolve(false); }
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

			// ── PC 大视口降级仿真（2026-10-22 加，修"内置面板布局尺寸限制"bug）──
			// 背景：web profile / 非 Electron 宿主下没有 CDP，此前 PC 自定义视口（1440/1600 等）
			// 走到 applyChrome 的 PC 分支被直接清空样式 → webview 永远撑满面板物理宽度（≈1043px），
			// 响应式站点（SSO 登录页等）按窄屏退化布局渲染，页面里预挂的验证码 SDK 让 agent
			// 反复误判"有滑块要处理"。修法与 Chrome DevTools responsive 模式同款：
			// webview 真实宽度=W + transform: scale(面板宽/W) 缩回显示 → 页面 innerWidth 即真实 W，
			// 桌面布局正常渲染。dpr / touch / Client Hints 仍不保真（只有 CDP 能给）。
			function stopPcScaleWatch(wv) {
				if (wv.__dshScaleRO) { try { wv.__dshScaleRO.disconnect(); } catch (e) {} wv.__dshScaleRO = null; }
				if (wv.__dshScaleRaf) { try { cancelAnimationFrame(wv.__dshScaleRaf); } catch (e) {} wv.__dshScaleRaf = 0; }
			}
			function schedulePcScale(wv, W) {
				if (wv.__dshScaleRaf) return;
				wv.__dshScaleRaf = requestAnimationFrame(function () {
					wv.__dshScaleRaf = 0;
					var p = wv.parentElement;
					if (!p || !W) return;
					var pw = 0, ph = 0;
					try { pw = p.clientWidth; ph = p.clientHeight; } catch (e) {}
					if (pw && W > pw) {
						var s = pw / W;
						wv.style.transform = "scale(" + s + ")";
						if (ph) wv.style.height = Math.round(ph / s) + "px";
					}
				});
			}
			function applyPcScaleWatch(wv, parent, W) {
				wv.__dshScaleW = W;
				if (wv.__dshScaleRO || typeof ResizeObserver === "undefined") return;
				var ro = new ResizeObserver(function () { schedulePcScale(wv, wv.__dshScaleW); });
				ro.observe(parent);
				wv.__dshScaleRO = ro;
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
					// P2-c：设备外壳观感（2026-10-23 加）——仿真手机/平板时，让 webview 在面板里
					// 呈现"悬浮的设备"（圆角 + 黑边 + 阴影 + 深色画布留白），而非铺满面板。
					// 纯 style.* 写（attribute，不进 childList 记录，observer 无风暴）；不新增 DOM 节点。
					// ⚠ 与 SHOW_APPBAR 分支互斥：显示模拟导航栏时不再套设备黑边（导航栏在设备之上）。
					if (!SHOW_APPBAR) {
						wv.style.borderRadius = "20px";
						wv.style.border = "7px solid #1b1b1f";
						wv.style.boxShadow = "0 10px 34px rgba(0,0,0,0.5)";
						wv.style.background = "#fff";
						wv.style.margin = "24px auto";   // 水平居中 + 上下留白（画布感）
						if (parent) {
							if (parent.style.background !== "#2a2a2e") parent.style.background = "#2a2a2e";
							if (parent.style.padding !== "8px") parent.style.padding = "8px";
						}
					} else {
						wv.style.borderRadius = "";
						wv.style.border = "";
						wv.style.boxShadow = "";
						wv.style.background = "";
						wv.style.margin = "";
					}
					if (SHOW_APPBAR) {
						wv.style.marginTop = BAR_H;
						wv.style.height = "calc(100% - " + BAR_H + ")";
					} else {
						wv.style.marginTop = "";
						wv.style.height = "";
					}
				} else {
					var pw = 0;
					try { pw = parent.clientWidth; } catch (e) {}
					if (W && pw && W > pw + 2) {
						// PC 大视口：锁宽 + 缩放（页面 innerWidth=真实 W，响应式站点走桌面布局）
						var sc = pw / W;
						wv.style.width = W + "px";
						wv.style.maxWidth = W + "px";
						wv.style.minWidth = W + "px";
						wv.style.flex = "0 0 " + W + "px";
						wv.style.transformOrigin = "0 0";
						wv.style.transform = "scale(" + sc + ")";
						var ph = 0;
						try { ph = parent.clientHeight; } catch (e) {}
						if (ph) wv.style.height = Math.round(ph / sc) + "px";
						wv.style.marginTop = "";
						applyPcScaleWatch(wv, parent, W);
					} else {
						wv.style.width = "";
						wv.style.maxWidth = "";
						wv.style.minWidth = "";
						wv.style.flex = "";
						wv.style.marginTop = "";
						wv.style.height = "";
						wv.style.transform = "";
						wv.style.transformOrigin = "";
						// P2-c：还原设备外壳观感（清掉 mobile 分支设置的圆角/黑边/阴影/画布）
						wv.style.borderRadius = "";
						wv.style.border = "";
						wv.style.boxShadow = "";
						wv.style.background = "";
						wv.style.margin = "";
						try { if (parent.style.background === "#2a2a2e") parent.style.background = ""; } catch (e) {}
						try { if (parent.style.padding === "8px") parent.style.padding = ""; } catch (e) {}
						stopPcScaleWatch(wv);
					}
				}
				// 工具栏：机型下拉 + 旋转 + 通道徽标（插在"这个面板自己的"工具栏 form 里）
				var root = wv.closest('[class*="_root"]') || document;
				var form = root.querySelector("form");
				if (form) {
					var dv = wv.__dshToggle;
					if (!dv || !dv.isConnected) {
						dv = document.createElement("div");
						dv.className = "dsh-bridge-devtoggle";
						var btns = form.querySelectorAll("button");
						var last = btns[btns.length - 1];
						if (last && last.parentElement === form) form.insertBefore(dv, last);
						else form.appendChild(dv);
						stats.creates++;
					}
					wv.__dshToggle = dv;
					var hostCss = "display:flex;align-items:center;flex:none;";
					if (dv.style.cssText !== hostCss) dv.style.cssText = hostCss;
					// 旋转：横屏/竖屏（对当前选中的机型重下发）
					if (!wv.__dshRotate || !wv.__dshRotate.isConnected) {
						var rot = document.createElement("div");
						rot.className = "dsh-bridge-rotate";
						rot.style.cssText = CSS_DEV_ROTATE;
						rot.textContent = "\u21C4";
						rot.title = "旋转：横屏 / 竖屏（对当前机型重下发）";
						rot.onclick = function () {
							var next = (wv.__dshOrient === "horizontal") ? "vertical" : "horizontal";
							applyDeviceChoice(wv, (wv.__dshSelect && wv.__dshSelect.value) || "default390", next);
						};
						dv.appendChild(rot);
						wv.__dshRotate = rot;
					}
					// 机型下拉（选项由 daemon 的 GET /devices 提供，源头是插件的 lib/devices.js）
					if (!wv.__dshSelect || !wv.__dshSelect.isConnected) {
						var sel = document.createElement("select");
						sel.className = "dsh-bridge-device";
						sel.style.cssText = CSS_DEV_SELECT;
						sel.title = "设备仿真（与 Chrome DevTools 同一套 CDP 命令）";
						sel.onchange = function () { applyDeviceChoice(wv, sel.value, wv.__dshOrient); };
						// 机型表可能因 daemon 还没收到 config 而暂时为空 → 用户点开时重取一次（空表不缓存）
						sel.onmousedown = function () { if (!deviceRows().length) rebuildDeviceOptions(wv); };
						dv.appendChild(sel);
						wv.__dshSelect = sel;
						rebuildDeviceOptions(wv);
					}
					// 通道徽标：CDP=完美 / CSS=近似 / 原生
					if (!wv.__dshBadge || !wv.__dshBadge.isConnected) {
						var bd = document.createElement("span");
						bd.className = "dsh-bridge-badge";
						dv.appendChild(bd);
						wv.__dshBadge = bd;
					}
					syncUi(wv);
				}
			}

			function setMobile(wv, mobile, width, fromUser) {
				wv.dataset.dshBridgeMobile = mobile ? "1" : "0";
				if (width) wv.dataset.dshBridgeWidth = String(width);
				applyChrome(wv, mobile, width);
				syncUa(wv, mobile, !!fromUser); // 用户点击 → UA + reload 立即生效；agent 驱动 → 只换 UA 不 reload
			}

			function resetChrome(wv) {
				delete wv.__dshDeviceUa;
				// 2026-10-14 修（用户实测：选"原生·PC"后页面仍是移动端）：
				//  ① **不再设 dshBridgeDisabled="1"** —— scan() 会跳过这类 webview，面板一重渲染下拉框就消失；
				//  ② **走 setMobile(false)** 而不是手动清样式 —— 它写入 dshBridgeMobile="0"（PC 模式的既有语义，
				//     autoReloadOnce / fixUaAfterNav 靠它判断），还原原生 UA **并 reload 一次**。
				//     只改 UA 不重载 → 已打开的页面仍按移动 UA 渲染，看起来"没切成 PC"。
				//  ③ 原生态只由 dshBridgeDevice="native" 表达（isNative() 据此判断）。
				wv.dataset.dshBridgeDevice = "native";
				saveChoice("native", wv.__dshOrient);   // 粘性：后开的新页面也保持原生态
				var parent = wv.parentElement;
				if (parent && parent.dataset.dshBridgePos) { delete parent.dataset.dshBridgePos; parent.style.position = ""; }
				// P2-c：清掉设备外壳观感（画布背景/内边距）
				if (parent) {
					try { if (parent.style.background === "#2a2a2e") parent.style.background = ""; } catch (e) {}
					try { if (parent.style.padding === "8px") parent.style.padding = ""; } catch (e) {}
				}
				setMobile(wv, false, null, true); // 置 PC 语义 + 还原 UA + reload
				if (wv.__dshBar) { try { wv.__dshBar.remove(); } catch (e) {} wv.__dshBar = null; }
				delete wv.dataset.dshBridgeWidth;
				setBadge(wv, "off", "面板原生视口（未仿真，已恢复原生 UA）");
			}

			// ── 机型下拉：面板手工切设备（与 agent 的 browser_emulate 共用同一套 CDP 下发）──

			function deviceRows() { return DEVICE_ROWS || []; }

			function fetchDeviceRows() {
				if (DEVICE_ROWS && DEVICE_ROWS.length) return Promise.resolve(DEVICE_ROWS);
				return fetchWithTimeout(CTRL + "/devices", {}, 6000)
					.then(function (res) { return res.json(); })
					.then(function (data) {
						var rows = (data && data.devices) || [];
						if (rows.length) DEVICE_ROWS = rows;   // 空表不缓存（daemon 可能还没收到 config）
						return rows;
					})
					.catch(function () { return []; });
			}

			function escHtml(s) {
				return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
			}

			// 与 lib/devices.js 的 buildSpec 同口径（只做"取竖/横屏框 + 读能力位"，不做名字匹配）
			function specFromRow(row, orientation) {
				var dir = orientation === "horizontal" ? "horizontal" : "vertical";
				var box = row[dir] || row.vertical;
				var caps = row.capabilities || [];
				return {
					preset: row.title,
					orientation: dir,
					width: box.width,
					height: box.height,
					dpr: row.dpr,
					mobile: caps.indexOf("mobile") >= 0,
					touch: caps.indexOf("touch") >= 0,
					ua: row.ua || null,
					uaMeta: row.uaMeta || null,
					screenWidth: box.width,
					screenHeight: box.height
				};
			}

			function setBadge(wv, kind, title) {
				var b = wv.__dshBadge;
				if (!b || !b.isConnected) return;
				var cfg = DEVICE_BADGE[kind] || DEVICE_BADGE.off;
				var css = CSS_DEV_BADGE + "background:" + cfg.bg + ";color:" + cfg.fg + ";";
				if (b.style.cssText !== css) b.style.cssText = css;
				if (b.textContent !== cfg.text) b.textContent = cfg.text;
				if (b.title !== title) b.title = title;
			}

			// 是否"原生态"（用户选了 原生 · PC）。注意：不能用 dshBridgeMobile 判断——笔记本/平板
			// 这类机型的 mobile 能力位本来就可能是 0，但那仍是"在仿真某个机型"，不是原生。
			function isNative(wv) {
				return (wv.dataset.dshBridgeDevice || "default390") === "native";
			}

			function rebuildDeviceOptions(wv) {
				var sel = wv.__dshSelect;
				if (!sel) return;
				fetchDeviceRows().then(function (rows) {
					if (!wv.__dshSelect || wv.__dshSelect !== sel) return;   // 元素已被重建
					var html = '<option value="default390">默认 · 手机 390</option><option value="native">原生 · PC（不仿真）</option>';
					if (!rows.length) {
						html += '<option value="" disabled>（机型表未就绪）</option>';
					} else {
						for (var g = 0; g < DEVICE_GROUPS.length; g++) {
							var key = DEVICE_GROUPS[g][0], items = [];
							for (var i = 0; i < rows.length; i++) if ((rows[i].type || "phone") === key) items.push(rows[i]);
							if (!items.length) continue;
							html += '<optgroup label="' + DEVICE_GROUPS[g][1] + '">';
							for (var j = 0; j < items.length; j++) {
								var r = items[j];
								html += '<option value="' + escHtml(r.title) + '">'
									+ escHtml(r.title + " · " + r.vertical.width + "\u00D7" + r.vertical.height) + "</option>";
							}
							html += "</optgroup>";
						}
					}
					if (sel.innerHTML !== html) sel.innerHTML = html;
					syncUi(wv);
				});
			}

			function syncUi(wv) {
				var want = isNative(wv) ? "native" : (wv.dataset.dshBridgeDevice || "default390");
				if (wv.__dshSelect && wv.__dshSelect.value !== want) {
					try { wv.__dshSelect.value = want; } catch (e) { /* 选项缺失（机型表未就绪）时忽略 */ }
				}
				if (want === "native") setBadge(wv, "off", "面板原生视口（未仿真）");
				else if (wv.dataset.dshBridgeBadge) setBadge(wv, wv.dataset.dshBridgeBadge, wv.dataset.dshBridgeBadgeTitle || "");
			}

			function askDaemonEmulate(payload) {
				return fetchWithTimeout(CTRL + "/ui/emulate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload)
				}, 8000).then(function (res) { return res.json(); })
					.catch(function (e) { return { applied: false, engine: "none", reason: String((e && e.message) || e) }; });
			}

			function applyDeviceChoice(wv, value, orientation, fromUser) {
				var orient = orientation || wv.__dshOrient || "vertical";
				wv.__dshOrient = orient;
				// fromUser=false 用于"新 webview 首挂"：只套用状态不重载（避免与地址栏首航竞态）
				var doReload = fromUser !== false;
				saveChoice(value, orient);   // 粘性：新开页面沿用
				if (value === "native") {
					askDaemonEmulate({ reset: true });
					resetChrome(wv);
					return;
				}
				if (value === "default390") {
					delete wv.__dshDeviceUa;
					askDaemonEmulate({ reset: true });
					delete wv.dataset.dshBridgeDisabled;
					wv.dataset.dshBridgeDevice = "default390";
					wv.dataset.dshBridgeBadge = "css";
					wv.dataset.dshBridgeBadgeTitle = "默认手机视口：锁宽 " + VIEWPORT_W + " + 默认移动 UA（从下拉里选具体机型可做与 DevTools 等价的仿真）";
					setMobile(wv, true, VIEWPORT_W, doReload);
					setBadge(wv, "css", wv.dataset.dshBridgeBadgeTitle);
					return;
				}
				var rows = deviceRows(), row = null;
				for (var i = 0; i < rows.length; i++) if (rows[i].title === value) { row = rows[i]; break; }
				if (!row) return;
				var spec = specFromRow(row, orient);
				if (!wv.__dshOrigUa) wv.__dshOrigUa = uaOf(wv);
				wv.__dshDeviceUa = spec.ua || null;
				delete wv.dataset.dshBridgeDisabled;
				wv.dataset.dshBridgeDevice = row.title;
				// 先做本地"外观"（锁宽到机型宽度 + 机型 UA，立即可见），再请 daemon 上 CDP 求完美保真
				setMobile(wv, spec.mobile, spec.width, doReload);
				setBadge(wv, "css", "正在下发仿真…");
				askDaemonEmulate({ spec: spec }).then(function (out) {
					if (out && out.applied && out.engine === "cdp-attach") {
						wv.dataset.dshBridgeBadge = "cdp";
						wv.dataset.dshBridgeBadgeTitle = "CDP 下发（Emulation.setDeviceMetricsOverride / setUserAgentOverride / setTouchEmulationEnabled）——与 Chrome DevTools 等价：viewport / dpr / touch / Client Hints 全部保真";
					} else {
						wv.dataset.dshBridgeBadge = "css";
						wv.dataset.dshBridgeBadgeTitle = "CSS 近似：已锁宽 + 覆盖 UA；dpr / touch / (pointer: coarse) / Client Hints 未仿真。原因："
							+ ((out && out.reason) || "无 CDP 通道") + "。要完美仿真：先 browser_attach（一次带参重启）或改用 target=managed";
					}
					setBadge(wv, wv.dataset.dshBridgeBadge, wv.dataset.dshBridgeBadgeTitle);
				});
			}

			function ensureWebview(wv) {
				if (wv.dataset.dshBridgeReady === "1") {
					// 已就管：只刷新容器（面板重渲染可能重排）
					// 锁宽条件 = 非原生 且 机型本身是 mobile（笔记本机型不该被锁宽）
					applyChrome(wv, !isNative(wv) && wv.dataset.dshBridgeMobile !== "0", parseInt(wv.dataset.dshBridgeWidth || "0", 10) || null);
					return;
				}
				wv.dataset.dshBridgeReady = "1";
				wv.dataset.dshBridgeWidth = String(VIEWPORT_W);
				// agent 自动开面板产生的首个 webview：跳过"首挂自动重载"（避免与首航竞态）
				if (window.__dshBridgeSuppressNext) {
					delete window.__dshBridgeSuppressNext;
					wv.dataset.dshBridgeUaApplied = "1";
				}
				wv.addEventListener("dom-ready", function () { autoReloadOnce(wv); });
				// ── console 读取（P2-b）：webview 的 console-message 事件 → 环形缓冲 ──
				wv.__dshConsole = [];
				wv.addEventListener("console-message", function (ev) {
					var msg = "";
					var level = "log";
					try {
						// Electron 新旧两套签名都兼容：event 对象（新版）或 (level, message) 位置参数
						if (ev && typeof ev === "object" && ("message" in ev)) {
							msg = String(ev.message || "");
							var lv = ev.level;
							level = lv === 1 ? "info" : lv === 2 ? "warning" : lv === 3 ? "error" : lv === 0 ? "verbose" : "log";
						} else {
							msg = String(arguments[1] || "");
							level = String(arguments[0] || "log");
						}
					} catch (e) { msg = String(ev); }
					if (!wv.__dshConsole) wv.__dshConsole = [];
					wv.__dshConsole.push({ level: level, message: msg.slice(0, 2000), ts: Date.now() });
					if (wv.__dshConsole.length > 300) wv.__dshConsole.splice(0, wv.__dshConsole.length - 300);
				});
				// ── 网络捕获（P2-b）：注入一次 fetch/XHR 包装，失败请求记到 __dshNetFails ──
				if (!wv.__dshNetHooked) {
					wv.__dshNetHooked = true;
					runInGuestQuiet(wv, "(() => { "
						+ "if (window.__dshNetHookedFlag) return; window.__dshNetHookedFlag = true; "
						+ "window.__dshNetFails = window.__dshNetFails || []; "
						+ "const rec = (url, status, type) => { window.__dshNetFails.push({url:String(url).slice(0,500), status: status || null, type: type || '', ts: Date.now()}); if (window.__dshNetFails.length > 200) window.__dshNetFails.splice(0, window.__dshNetFails.length - 200); }; "
						+ "const of = window.fetch; if (of && !of.__dshHooked) { window.fetch = function () { const url = arguments[0]; return of.apply(this, arguments).then(r => { if (r && r.status >= 400) rec(typeof url === 'string' ? url : (url && url.url), r.status, 'fetch'); return r; }).catch(e => { rec(typeof url === 'string' ? url : (url && url.url), null, 'fetch'); throw e; }); }; window.fetch.__dshHooked = true; } "
						+ "const oo = XMLHttpRequest.prototype.open; if (oo && !oo.__dshHooked) { const os = XMLHttpRequest.prototype.send; "
						+ "XMLHttpRequest.prototype.open = function (m, u) { this.__dshUrl = u; this.__dshMethod = m; return oo.apply(this, arguments); }; "
						+ "XMLHttpRequest.prototype.send = function () { this.addEventListener('load', () => { if (this.status >= 400) rec(this.__dshUrl, this.status, 'xhr'); }); this.addEventListener('error', () => rec(this.__dshUrl, null, 'xhr')); return os.apply(this, arguments); }; "
						+ "XMLHttpRequest.prototype.open.__dshHooked = true; } "
						+ "return true; })()", 8000, "net hook");
				}
				// 首挂即套用**上次的设备选择**（跨 webview / 跨重启粘性，与 DevTools 的全局设备设置一致）：
				// 否则用户在面板里选了"原生·PC"，新开一个页面（= 新 webview）又会回到默认 390 手机视口
				// —— 这正是"选了 PC 但打开的系统页面还是移动端"的成因之一。
				var initChoice = LAST_CHOICE.value;
				if (initChoice === "native") {
					wv.__dshOrigUa = uaOf(wv) || void 0;   // 记住原生 UA，供以后切回机型时还原
					resetChrome(wv);
				} else if (initChoice === "default390") {
					var cur = uaOf(wv);
					if (cur && cur !== MOBILE_UA) { wv.__dshOrigUa = cur; try { wv.setUserAgent(MOBILE_UA); } catch (e) {} }
					wv.dataset.dshBridgeDevice = "default390";
					setMobile(wv, true, VIEWPORT_W, false); // 默认手机视口（移动端 H5 调试优先）
				} else {
					applyDeviceChoice(wv, initChoice, LAST_CHOICE.orientation, false); // 首挂不重载，避免与首航竞态
				}
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

			// ---- 面板句柄上报（供插件层走 Electron 主进程原生 CDP）----
			// `getWebContentsId()` 是渲染进程唯一能拿到的跨进程句柄：插件层（Electron 主进程）
			// 用它 `webContents.fromId(id).debugger` 打通 Emulation.*，做与 DevTools 等价的仿真。
			function safeWcId(wv) {
				try { return (wv && typeof wv.getWebContentsId === "function") ? wv.getWebContentsId() : null; } catch (e) { return null; }
			}

			function infoOp() {
				var wv = pickWebview();
				var list = [];
				try {
					list = [].map.call(allWebviews(), function (w) {
						var u = ""; try { u = w.getURL() || ""; } catch (e) {}
						return { id: safeWcId(w), url: u };
					});
				} catch (e) { /* 宿主态异常不阻塞上报 */ }
				return Promise.resolve({
					webviewCount: list.length,
					webContentsId: safeWcId(wv),
					url: wv ? (wv.getURL() || "") : "",
					title: wv ? (wv.getTitle() || "") : "",
					webviews: list,
					hostDpr: window.devicePixelRatio || 1
				});
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

			// runInGuest 的静默版：失败不抛（只打日志），用于"尽力而为"的注入（如 net hook 在导航竞态下失败不影响命令本身）。
			function runInGuestQuiet(wv, code, ms, label) {
				return withTimeout(wv.executeJavaScript(code), ms, label || "guest 执行")
					.then(function (v) { return v === undefined ? null : v; })
					.catch(function (e) {
						// 不抛：console/network 采集属于尽力而为，失败不应让主命令失败
						if (typeof console !== "undefined") console.warn("[dsh-bridge] " + (label || "guest") + " 静默失败：" + String(e && e.message || e).slice(0, 200));
						return null;
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
				// info 即使没有 webview 也要能答（插件层要靠它区分"面板没开"和"通道不通"）
				if (op === "info") return infoOp();
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
				if (op === "fill") {
					// 兼容 React/Vue 受控组件：用 native setter 改 value，再派发 input/change。
					// 只对 input/textarea/contenteditable 生效；select 走 select op。
					var fsel = JSON.stringify(p.selector);
					var fval = JSON.stringify(String(p.value == null ? "" : p.value));
					var fcode = "(() => { const el = document.querySelector(" + fsel + "); if (!el) throw new Error('未找到元素'); "
						+ "const tag = el.tagName ? el.tagName.toLowerCase() : ''; "
						+ "if (tag === 'input' || tag === 'textarea') { "
						+ "  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; "
						+ "  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; "
						+ "  el.focus(); setter.call(el, " + fval + "); "
						+ "  el.dispatchEvent(new Event('input', {bubbles:true})); "
						+ "  el.dispatchEvent(new Event('change', {bubbles:true})); "
						+ "} else if (el.isContentEditable) { "
						+ "  el.focus(); el.textContent = " + fval + "; "
						+ "  el.dispatchEvent(new InputEvent('input', {bubbles:true, data:" + fval + "})); "
						+ "} else { throw new Error('fill 仅支持 input/textarea/contenteditable，当前是 <' + tag + '>'); } "
						+ "return el.value || el.textContent; })()";
					return runInGuest(wv, fcode, 15000, "fill")
						.then(function (v) { return { selector: p.selector, value: v, url: wv.getURL() || "", title: wv.getTitle() || "" }; });
				}
				if (op === "select") {
					// select 下拉：value 或 label 匹配；找不到精确 value 时按文本找 option。
					var ssel = JSON.stringify(p.selector);
					var sval = JSON.stringify(String(p.value == null ? "" : p.value));
					var slabel = p.label != null ? JSON.stringify(String(p.label)) : "null";
					var scode = "(() => { const el = document.querySelector(" + ssel + "); if (!el) throw new Error('未找到元素'); "
						+ "if (!(el instanceof HTMLSelectElement)) throw new Error('select 目标不是 <select>'); "
						+ "let opt = null; "
						+ "if (" + slabel + " !== null) { opt = [...el.options].find(o => o.text.trim() === " + slabel + "); } "
						+ "if (!opt) { opt = [...el.options].find(o => o.value === " + sval + "); } "
						+ "if (!opt) { const idx = parseInt(" + sval + ", 10); if (!isNaN(idx) && el.options[idx]) opt = el.options[idx]; } "
						+ "if (!opt) throw new Error('选项不存在：value/label=' + " + sval + " + '/' + " + slabel + "'); "
						+ "el.value = opt.value; "
						+ "el.dispatchEvent(new Event('change', {bubbles:true})); "
						+ "el.dispatchEvent(new Event('input', {bubbles:true})); "
						+ "return { value: opt.value, text: opt.text }; })()";
					return runInGuest(wv, scode, 15000, "select")
						.then(function (v) { return { selector: p.selector, selected: v, url: wv.getURL() || "", title: wv.getTitle() || "" }; });
				}
				if (op === "press") {
					// 按键：key 优先（如 Enter/Tab/Escape），fallback 单字符输入到焦点元素。
					var psel = JSON.stringify(p.selector || "document.activeElement");
					var pkey = JSON.stringify(String(p.key || ""));
					var pcode = "(() => { const el = document.querySelector(" + psel + ") || document.activeElement; if (!el) throw new Error('未找到元素'); "
						+ "const key = " + pkey + "; "
						+ "const keyMap = { 'Enter':[13,'Enter'], 'Tab':[9,'Tab'], 'Escape':[27,'Escape'], 'Backspace':[8,'Backspace'], "
						+ "  'ArrowUp':[38,'ArrowUp'], 'ArrowDown':[40,'ArrowDown'], 'ArrowLeft':[37,'ArrowLeft'], 'ArrowRight':[39,'ArrowRight'], "
						+ "  'Home':[36,'Home'], 'End':[35,'End'], 'PageUp':[33,'PageUp'], 'PageDown':[34,'PageDown'], 'Delete':[46,'Delete'], "
						+ "  'Space':[32,' '], 'Control':[17,'Control'], 'Shift':[16,'Shift'], 'Alt':[18,'Alt'], 'Meta':[91,'Meta'] }; "
						+ "const special = keyMap[key] || (key.length === 1 ? null : [key.toUpperCase().charCodeAt(0) || 0, key]); "
						+ "if (key.length === 1) { "
						+ "  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'INPUT' ? HTMLInputElement.prototype : null); "
						+ "  if (proto) { const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; "
						+ "    setter.call(el, (el.value || '') + key); } "
						+ "  el.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true})); "
						+ "  el.dispatchEvent(new InputEvent('input', {bubbles:true, data:key})); "
						+ "  el.dispatchEvent(new KeyboardEvent('keyup', {key, bubbles:true})); "
						+ "} else if (special) { "
						+ "  const [kc, code] = special; "
						+ "  el.dispatchEvent(new KeyboardEvent('keydown', {key, code, keyCode:kc, which:kc, bubbles:true, cancelable:true})); "
						+ "  el.dispatchEvent(new KeyboardEvent('keyup', {key, code, keyCode:kc, which:kc, bubbles:true})); "
						+ "} else { throw new Error('未知按键：' + key); } "
						+ "return { key }; })()";
					return runInGuest(wv, pcode, 15000, "press")
						.then(function (v) { return { selector: p.selector || null, pressed: v, url: wv.getURL() || "", title: wv.getTitle() || "" }; });
				}
				if (op === "hover") {
					var hsel = JSON.stringify(p.selector);
					var hcode = "(() => { const el = document.querySelector(" + hsel + "); if (!el) throw new Error('未找到元素'); "
						+ "el.scrollIntoView({block:'center', inline:'center'}); "
						+ "const r = el.getBoundingClientRect(); const cx = r.left + r.width/2, cy = r.top + r.height/2; "
						+ "['mouseover','mouseenter','mousemove'].forEach(t => el.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy}))); "
						+ "return true; })()";
					return runInGuest(wv, hcode, 15000, "hover")
						.then(function () { return { selector: p.selector, hovered: true, url: wv.getURL() || "", title: wv.getTitle() || "" }; });
				}
				if (op === "console") {
					// 读面板 webview 的 console 环形缓冲（由 ensureWebview 的 console-message 监听填充）
					var logs = (wv.__dshConsole || []).slice(-(p.limit || 100));
					return Promise.resolve({ logs: logs, url: wv.getURL() || "", title: wv.getTitle() || "" });
				}
				if (op === "network") {
					// 读 performance 资源条目（已完成请求的 URL/类型/耗时/大小）+ 注入的失败请求清单
					var ncode = "(() => { "
						+ "const entries = (performance && performance.getEntriesByType ? performance.getEntriesByType('resource') : []).map(e => ({ name: e.name.slice(0,500), initiatorType: e.initiatorType || '', duration: Math.round(e.duration), transferSize: e.transferSize || 0, status: null })); "
						+ "const fails = (window.__dshNetFails || []).slice(); "
						+ "return { entries: entries.slice(-" + (p.limit || 80) + "), fails: fails }; })()";
					return runInGuestQuiet(wv, ncode, 10000, "network")
						.then(function (v) {
							v = v || { entries: [], fails: [] };
							return { entries: v.entries || [], fails: v.fails || [], url: wv.getURL() || "", title: wv.getTitle() || "" };
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
					// 降级通道：只做「锁宽 + 覆盖 UA」的 CSS 近似。真正与 Chrome DevTools 等价的
					// 完美仿真（devicePixelRatio / touch / (pointer: coarse) / Client Hints）
					// 必须走 CDP，由插件层经 Electron 主进程下发，不经过这里。
					if (p.reset) {
						resetChrome(wv);
						return Promise.resolve({ emulated: false, engine: "css", url: wv.getURL() || "" });
					}
					var spec = p.spec || (p.width ? { width: p.width, mobile: p.mobile !== false, ua: p.ua } : {});
					if (!spec.width) return Promise.reject(new Error("emulate 需要 spec（机型规格）或 width"));
					setMobile(wv, spec.mobile !== false, spec.width, false);
					if (spec.ua) { try { wv.setUserAgent(spec.ua); } catch (e) { /* 个别版本只读 */ } }
					return Promise.resolve({
						emulated: {
							preset: spec.preset || null,
							width: spec.width,
							height: spec.height || null,
							deviceScaleFactor: spec.dpr || null,
							mobile: spec.mobile !== false,
							touch: spec.touch === true,
							orientation: spec.orientation || "vertical"
						},
						engine: "css",
						url: wv.getURL() || "",
						degraded: "降级 CSS 近似：viewport 宽度真实生效（PC 大视口经锁宽+缩放，页面 innerWidth=目标宽）；devicePixelRatio / touch / (pointer: coarse) / Client Hints 未仿真（需 CDP）"
					});
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
					return Promise.resolve(execCmdInner(cmd)).then(function (r) {
						// 顺手把面板句柄挂到每个结果上：插件层不必额外询问就能拿到 webContents id
						try {
							if (r && typeof r === "object" && r.webContentsId === undefined) {
								var wv = pickWebview();
								if (wv) r.webContentsId = safeWcId(wv);
							}
						} catch (e) { /* 宿主态异常不影响结果 */ }
						return r;
					});
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
