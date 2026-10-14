/**
 * 机型库 —— 与 Chrome DevTools 的设备仿真列表**逐字段对齐**（46 款）。
 *
 * 数据源（权威，非手工誊抄）：npm `chrome-devtools-frontend@1.0.1716465` 的
 * `front_end/models/emulation/EmulatedDevices.ts` 里 `// DEVICE-LIST-BEGIN..END` 段。
 * 该段在 Chromium 中由 `embed_mobile_devices_in_cpp.py` 与 chromedriver 原生列表保持同步，
 * 因此它就是 Chrome DevTools 设备工具栏里那一份的同一来源（含真实 UA 与 Client Hints）。
 *
 * 字段：
 *   title / type / default    名称、类别、是否在 DevTools 下拉里默认显示
 *   capabilities              含 'mobile' → CDP mobile=true；含 'touch' → 开触摸仿真
 *   dpr                       device-pixel-ratio（→ CDP deviceScaleFactor）
 *   vertical / horizontal     竖屏 / 横屏的 CSS 像素尺寸（→ CDP width/height）
 *   ua / uaMeta               真实 UA 串 + Client Hints（→ CDP userAgentMetadata）
 *
 * 本文件只做「数据 + 解析」；真正的仿真下发在 index.js（builtin → Electron CDP）
 * 与 browser_daemon.py（managed → Playwright CDP session）两处执行。
 */

/** 机型表（顺序与 DevTools 一致）。 */
export const DEVICES = [
 {
  "order": 10,
  "title": "iPhone SE",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 375,
   "height": 667
  },
  "horizontal": {
   "width": 667,
   "height": 375
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 12,
  "title": "iPhone XR",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 414,
   "height": 896
  },
  "horizontal": {
   "width": 896,
   "height": 414
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 14,
  "title": "iPhone 12 Pro",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 390,
   "height": 844
  },
  "horizontal": {
   "width": 844,
   "height": 390
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 15,
  "title": "iPhone 14",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 390,
   "height": 844
  },
  "horizontal": {
   "width": 844,
   "height": 390
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 16,
  "title": "iPhone 14 Plus",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 428,
   "height": 926
  },
  "horizontal": {
   "width": 926,
   "height": 428
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 17,
  "title": "iPhone 14 Pro",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 393,
   "height": 852
  },
  "horizontal": {
   "width": 852,
   "height": 393
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 18,
  "title": "iPhone 14 Pro Max",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 430,
   "height": 932
  },
  "horizontal": {
   "width": 932,
   "height": 430
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 19,
  "title": "iPhone 15",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 393,
   "height": 852
  },
  "horizontal": {
   "width": 852,
   "height": 393
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 20,
  "title": "iPhone 15 Plus",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 430,
   "height": 932
  },
  "horizontal": {
   "width": 932,
   "height": 430
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 21,
  "title": "iPhone 15 Pro",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 393,
   "height": 852
  },
  "horizontal": {
   "width": 852,
   "height": 393
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 22,
  "title": "iPhone 15 Pro Max",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 430,
   "height": 932
  },
  "horizontal": {
   "width": 932,
   "height": 430
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 23,
  "title": "iPhone 16e",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 390,
   "height": 844
  },
  "horizontal": {
   "width": 844,
   "height": 390
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 24,
  "title": "iPhone 16",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 393,
   "height": 852
  },
  "horizontal": {
   "width": 852,
   "height": 393
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 25,
  "title": "iPhone 16 Plus",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 430,
   "height": 932
  },
  "horizontal": {
   "width": 932,
   "height": 430
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 26,
  "title": "iPhone 16 Pro",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 402,
   "height": 874
  },
  "horizontal": {
   "width": 874,
   "height": 402
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 27,
  "title": "iPhone 16 Pro Max",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 440,
   "height": 956
  },
  "horizontal": {
   "width": 956,
   "height": 440
  },
  "ua": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPhone",
   "mobile": true
  }
 },
 {
  "order": 30,
  "title": "Pixel 7",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 915
  },
  "horizontal": {
   "width": 915,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "13",
   "architecture": "",
   "model": "Pixel 7",
   "mobile": true
  }
 },
 {
  "order": 31,
  "title": "Pixel 8",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 915
  },
  "horizontal": {
   "width": 915,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 8",
   "mobile": true
  }
 },
 {
  "order": 32,
  "title": "Pixel 8 Pro",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 448,
   "height": 997
  },
  "horizontal": {
   "width": 997,
   "height": 448
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 8 Pro",
   "mobile": true
  }
 },
 {
  "order": 33,
  "title": "Pixel 8a",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 915
  },
  "horizontal": {
   "width": 915,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 8a",
   "mobile": true
  }
 },
 {
  "order": 34,
  "title": "Pixel 9",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 924
  },
  "horizontal": {
   "width": 924,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 9",
   "mobile": true
  }
 },
 {
  "order": 35,
  "title": "Pixel 9 Pro",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 427,
   "height": 952
  },
  "horizontal": {
   "width": 952,
   "height": 427
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 9 Pro",
   "mobile": true
  }
 },
 {
  "order": 36,
  "title": "Pixel 9 Pro XL",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 448,
   "height": 997
  },
  "horizontal": {
   "width": 997,
   "height": 448
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 9 Pro XL",
   "mobile": true
  }
 },
 {
  "order": 37,
  "title": "Pixel 10",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 924
  },
  "horizontal": {
   "width": 924,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "16",
   "architecture": "",
   "model": "Pixel 10",
   "mobile": true
  }
 },
 {
  "order": 38,
  "title": "Samsung Galaxy S8+",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 4,
  "vertical": {
   "width": 360,
   "height": 740
  },
  "horizontal": {
   "width": 740,
   "height": 360
  },
  "ua": "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "8.0.0",
   "architecture": "",
   "model": "SM-G955U",
   "mobile": true
  }
 },
 {
  "order": 39,
  "title": "Samsung Galaxy S20 Ultra",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3.5,
  "vertical": {
   "width": 412,
   "height": 915
  },
  "horizontal": {
   "width": 915,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "13",
   "architecture": "",
   "model": "SM-G981B",
   "mobile": true
  }
 },
 {
  "order": 43,
  "title": "Surface Pro 7",
  "type": "tablet",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 912,
   "height": 1368
  },
  "horizontal": {
   "width": 1368,
   "height": 912
  },
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  "uaMeta": null
 },
 {
  "order": 40,
  "title": "iPad Mini",
  "type": "tablet",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 768,
   "height": 1024
  },
  "horizontal": {
   "width": 1024,
   "height": 768
  },
  "ua": "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPad",
   "mobile": true
  }
 },
 {
  "order": 42,
  "title": "iPad Pro 13",
  "type": "tablet",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 1032,
   "height": 1376
  },
  "horizontal": {
   "width": 1376,
   "height": 1032
  },
  "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  "uaMeta": {
   "platform": "iOS",
   "platformVersion": "18.5",
   "architecture": "",
   "model": "iPad",
   "mobile": true
  }
 },
 {
  "order": 43,
  "title": "Surface Pro 10",
  "type": "tablet",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 960,
   "height": 1440
  },
  "horizontal": {
   "width": 1440,
   "height": 960
  },
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  "uaMeta": null
 },
 {
  "order": 44,
  "title": "Surface Duo",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.5,
  "vertical": {
   "width": 540,
   "height": 720
  },
  "horizontal": {
   "width": 720,
   "height": 540
  },
  "ua": "Mozilla/5.0 (Linux; Android 11.0; Surface Duo) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "11.0",
   "architecture": "",
   "model": "Surface Duo",
   "mobile": true
  }
 },
 {
  "order": 38,
  "title": "Samsung Galaxy A55",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.25,
  "vertical": {
   "width": 360,
   "height": 800
  },
  "horizontal": {
   "width": 800,
   "height": 360
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "SM-A556B",
   "mobile": true
  }
 },
 {
  "order": 45,
  "title": "Pixel 9 Pro Fold",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 922
  },
  "horizontal": {
   "width": 922,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro Fold) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "Pixel 9 Pro Fold",
   "mobile": true
  }
 },
 {
  "order": 46,
  "title": "Galaxy Z Fold 6",
  "type": "phone",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 968
  },
  "horizontal": {
   "width": 968,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 14; SM-F956U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "14",
   "architecture": "",
   "model": "SM-F956U",
   "mobile": true
  }
 },
 {
  "order": 46,
  "title": "Galaxy Z Fold 5",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 344,
   "height": 882
  },
  "horizontal": {
   "width": 882,
   "height": 344
  },
  "ua": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "10.0",
   "architecture": "",
   "model": "SM-F946U",
   "mobile": true
  }
 },
 {
  "order": 47,
  "title": "Asus Zenbook Fold",
  "type": "tablet",
  "default": false,
  "capabilities": [
   "touch"
  ],
  "dpr": 1.5,
  "vertical": {
   "width": 853,
   "height": 1280
  },
  "horizontal": {
   "width": 1280,
   "height": 853
  },
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  "uaMeta": {
   "platform": "Windows",
   "platformVersion": "11.0",
   "architecture": "",
   "model": "UX9702AA",
   "mobile": false
  }
 },
 {
  "order": 48,
  "title": "Samsung Galaxy A51/71",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.625,
  "vertical": {
   "width": 412,
   "height": 914
  },
  "horizontal": {
   "width": 914,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 8.0.0; SM-G955U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "8.0.0",
   "architecture": "",
   "model": "SM-G955U",
   "mobile": true
  }
 },
 {
  "order": 52,
  "title": "Nest Hub Max",
  "type": "smart-display",
  "default": true,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2,
  "vertical": {
   "width": 1280,
   "height": 800
  },
  "horizontal": {
   "width": 1280,
   "height": 800
  },
  "ua": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 CrKey/1.54.250320",
  "uaMeta": null
 },
 {
  "order": null,
  "title": "Galaxy Tab S4",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 2.25,
  "vertical": {
   "width": 712,
   "height": 1138
  },
  "horizontal": {
   "width": 1138,
   "height": 712
  },
  "ua": "Mozilla/5.0 (Linux; Android 8.1.0; SM-T837A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "8.1.0",
   "architecture": "",
   "model": "SM-T837A",
   "mobile": false
  }
 },
 {
  "order": 1,
  "title": "JioPhone 2",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 1,
  "vertical": {
   "width": 240,
   "height": 320
  },
  "horizontal": {
   "width": 320,
   "height": 240
  },
  "ua": "Mozilla/5.0 (Mobile; LYF/F300B/LYF-F300B-001-01-15-130718-i;Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "",
   "architecture": "",
   "model": "LYF/F300B/LYF-F300B-001-01-15-130718-i",
   "mobile": true
  }
 },
 {
  "order": null,
  "title": "Laptop with touch",
  "type": "notebook",
  "default": false,
  "capabilities": [
   "touch"
  ],
  "dpr": 1,
  "vertical": {
   "width": 950,
   "height": 1280
  },
  "horizontal": {
   "width": 1280,
   "height": 950
  },
  "ua": "",
  "uaMeta": null
 },
 {
  "order": null,
  "title": "Laptop with HiDPI screen",
  "type": "notebook",
  "default": false,
  "capabilities": [],
  "dpr": 2,
  "vertical": {
   "width": 900,
   "height": 1440
  },
  "horizontal": {
   "width": 1440,
   "height": 900
  },
  "ua": "",
  "uaMeta": null
 },
 {
  "order": null,
  "title": "Laptop with MDPI screen",
  "type": "notebook",
  "default": false,
  "capabilities": [],
  "dpr": 1,
  "vertical": {
   "width": 800,
   "height": 1280
  },
  "horizontal": {
   "width": 1280,
   "height": 800
  },
  "ua": "",
  "uaMeta": null
 },
 {
  "order": null,
  "title": "Moto G4",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3,
  "vertical": {
   "width": 360,
   "height": 640
  },
  "horizontal": {
   "width": 640,
   "height": 360
  },
  "ua": "Mozilla/5.0 (Linux; Android 6.0.1; Moto G (4)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "6.0.1",
   "architecture": "",
   "model": "Moto G (4)",
   "mobile": true
  }
 },
 {
  "order": null,
  "title": "Moto G Power",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 1.75,
  "vertical": {
   "width": 412,
   "height": 823
  },
  "horizontal": {
   "width": 823,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "11",
   "architecture": "",
   "model": "moto g power (2022)",
   "mobile": true
  }
 },
 {
  "order": 200,
  "title": "Facebook on Android",
  "type": "phone",
  "default": false,
  "capabilities": [
   "touch",
   "mobile"
  ],
  "dpr": 3.5,
  "vertical": {
   "width": 412,
   "height": 892
  },
  "horizontal": {
   "width": 892,
   "height": 412
  },
  "ua": "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SQ3A.220705.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/%s Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/407.0.0.0.65;]",
  "uaMeta": {
   "platform": "Android",
   "platformVersion": "12",
   "architecture": "",
   "model": "Pixel 6",
   "mobile": true
  }
 }
];

/** 按 DevTools 的展示顺序返回机型：默认显示的在前。 */
export function listDevices() {
	return [...DEVICES].sort((a, b) => Number(b.default) - Number(a.default) || (a.order ?? 0) - (b.order ?? 0));
}

/** 规格化名字：忽略大小写、空格、连字符、下划线与中英文括号。 */
function normName(s) {
	return String(s).toLowerCase().replace(/[\s_\-()（）]/g, "");
}

/**
 * 模糊解析机型名，允许简写（"iphone16pro" / "pixel9" / "zfold6"）。
 * 先全等、再前缀、最后包含；无匹配返回 undefined。
 */
export function matchDevice(query) {
	if (typeof query !== "string" || query.trim() === "") return void 0;
	const q = normName(query);
	return DEVICES.find((d) => normName(d.title) === q)
		?? DEVICES.find((d) => normName(d.title).startsWith(q))
		?? DEVICES.find((d) => normName(d.title).includes(q));
}

/**
 * 把机型（或显式参数）解析成**与目标无关的仿真规格**，供两条通道分别落地：
 *   builtin → Electron 主进程 CDP `Emulation.*`（DevTools 同款，完美仿真）
 *   managed → Playwright CDP session `Emulation.*`（同上）
 *
 * 不传 device 而传 width/height/dpr → 等价于 DevTools 的 "Responsive / 自定义尺寸"。
 *
 * @param {{device?: string, orientation?: string, overrides?: object}} options
 * @returns {{spec: object|null, device?: object, error?: string}}
 */
export function buildSpec({ device, orientation, overrides = {} } = {}) {
	const preset = device === void 0 ? void 0 : matchDevice(device);
	if (device !== void 0 && preset === void 0) {
		return { spec: null, error: `未知机型 ${JSON.stringify(device)}；用 browser_emulate(list=true) 查看可用机型` };
	}
	const dir = orientation === "horizontal" ? "horizontal" : "vertical";
	const box = preset ? preset[dir] : {};
	const width = overrides.width ?? box.width;
	const height = overrides.height ?? box.height;
	if (width === void 0 || height === void 0) {
		return { spec: null, error: "需要 device 机型名，或同时给 width 与 height（自定义视口）" };
	}
	const caps = preset ? preset.capabilities : [];
	const spec = {
		preset: preset ? preset.title : "custom",
		orientation: dir,
		width,
		height,
		dpr: overrides.dpr ?? preset?.dpr ?? 1,
		mobile: overrides.mobile ?? (preset ? caps.includes("mobile") : false),
		touch: overrides.touch ?? (preset ? caps.includes("touch") : false),
		ua: overrides.ua ?? preset?.ua ?? null,
		uaMeta: preset?.uaMeta ?? null,
		screenWidth: preset ? box.width : width,
		screenHeight: preset ? box.height : height
	};
	return { spec, device: preset };
}
