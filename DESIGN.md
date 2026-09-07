# Waveform Viewer — 设计文档

> 版本 1.1.5 · 对应源码 `src/content.js` (1671 行) / `src/page-hook.js` (235 行) / `src/background.js` (236 行)
> 仓库 <https://github.com/EricZhou866/waveform-viewer> · MIT

---

## 目录

1. [目标与非目标](#1-目标与非目标)
2. [总体架构](#2-总体架构)
3. [运行上下文与文件职责](#3-运行上下文与文件职责)
4. [音频发现](#4-音频发现)
5. [跨世界通信协议](#5-跨世界通信协议)
6. [Lane 生命周期](#6-lane-生命周期)
7. [去重：波形指纹](#7-去重波形指纹)
8. [时间轴模型](#8-时间轴模型)
9. [静音裁剪算法](#9-静音裁剪算法)
10. [播放引擎](#10-播放引擎)
11. [渲染管线](#11-渲染管线)
12. [交互设计](#12-交互设计)
13. [独立窗口与 Lane 移交](#13-独立窗口与-lane-移交)
14. [下载与 WAV 编码](#14-下载与-wav-编码)
15. [跨浏览器差异](#15-跨浏览器差异)
16. [权限与隐私](#16-权限与隐私)
17. [持久化 Schema](#17-持久化-schema)
18. [关键设计约束与取舍](#18-关键设计约束与取舍)
19. [踩坑档案](#19-踩坑档案)
20. [测试策略](#20-测试策略)
21. [构建与发布](#21-构建与发布)
22. [未来方向](#22-未来方向)

---

## 1. 目标与非目标

### 起因

PTE / 雅思一类口语练习的核心动作是**把范读和自己的录音放在一起比**。这件事光靠耳朵不够——听不出"我的停顿多了 180ms"、"我的重音落在第二个音节而不是第一个"。看波形能一眼看出来，但现有流程是：下载音频 → 打开 Audacity → 导入两条 → 手工对齐。太重，练一题不值得开一次桌面编辑器。

Waveform Viewer 把这套动作压到浏览器里：网页放什么，面板上就出现什么波形。

### 目标

| # | 目标 | 判定标准 |
|---|------|---------|
| G1 | 任何网页播放的音频都能画出波形 | 包括不创建 `<audio>` 元素、纯 Web Audio 的播放器 |
| G2 | 多条波形可叠放对比 | 共享时间轴，纵向对齐 |
| G3 | 对齐是一键的 | 不需要手工找起点 |
| G4 | 停顿时长可读数 | 毫秒级 |
| G5 | 可以搬到副屏 | 波形铺满屏幕而不是缩在角落 |
| G6 | 纯本地 | 不联网、不上报、无账号 |
| G7 | 双浏览器 | Chrome MV3 + Firefox MV2，同一份 `src/` |

### 非目标

- **不做音频编辑器**。不裁剪保存回原文件、不做淡入淡出、不做多轨混音。
- **不做声学分析**。不画频谱图、不标 F0 曲线、不算共振峰。这些留给专门工具；本扩展只解决"看波形"这一件事。
- **不做录音**。不申请麦克风权限。
- **不做云端**。没有服务器就没有隐私政策争议，也不需要用户注册。

---

## 2. 总体架构

三个隔离的 JS 世界 + 一个可选的独立窗口。

```mermaid
graph TB
  subgraph PW["页面世界 (Page World)"]
    HOOK["page-hook.js<br/>劫持 4 条音频路径"]
    SITE["网站自己的播放器"]
  end

  subgraph IW["隔离世界 (Isolated World)"]
    CS["content.js (IS_PANEL=false)<br/>面板 UI · Lane 管理 · 渲染 · 播放"]
  end

  subgraph BG["后台"]
    B["background.js<br/>开关 · CORS 代理 · 窗口所有权"]
  end

  subgraph WIN["独立扩展窗口 (可选)"]
    P["panel.html → content.js (IS_PANEL=true)"]
  end

  SITE -->|"调用被劫持的 API"| HOOK
  HOOK -->|"window.postMessage"| CS
  CS -->|"注入 script 标签"| HOOK
  CS <-->|"runtime.sendMessage"| B
  B <-->|"runtime.sendMessage"| P
  B -->|"windows.create"| P
  CS -.->|"Lane 描述符"| B
```

**为什么必须有三层？**

- `page-hook.js` 在页面世界，因为只有在那里才能替换掉页面即将调用的 `AudioContext.prototype.decodeAudioData`。内容脚本在隔离世界，改不到页面的原型链。
- `content.js` 在隔离世界，因为它需要 `chrome.*` API（storage、runtime、tabs 消息），而页面世界拿不到这些。
- `background.js` 存在的唯一硬理由是**它不受页面 CORS 限制**。音频常常从没有 CORS 头的 CDN 来，内容脚本 `fetch` 会被拦，后台不会。

---

## 3. 运行上下文与文件职责

### 3.1 `content.js` 的双重身份

同一个文件在两种环境下跑，靠协议判定：

```js
const IS_PANEL = /-extension:$/.test(location.protocol);
```

匹配 `chrome-extension:` 和 `moz-extension:`，同时兼容两个引擎。

| | 内容脚本模式 (`IS_PANEL=false`) | 面板窗口模式 (`IS_PANEL=true`) |
|---|---|---|
| 宿主 | 任意网页 | `panel.html` |
| 面板容器 | `position:fixed` 浮层 + Shadow DOM | 铺满整个窗口 |
| 音频来源 | 页面发现 + 本地文件 | Lane 移交 + 本地文件 |
| 有 `Rescan` / `Window` / 折叠按钮 | 是 | 否（`ensurePanel()` 里移除） |
| Lane 高度 | 用户按 `＋/－` 调 | `fitPanelWindow()` 按窗口高度自动均分 |
| 空格键 | 需要 Ctrl/Cmd 修饰 | 裸空格即可 |

这个复用不是省事，是必须：面板的渲染、播放、裁剪逻辑一行都不该有两份实现，否则副屏窗口和页内面板一定会行为漂移。

### 3.2 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/content.js` | 1671 | 面板 UI、Lane 管理、时间轴、裁剪、播放、渲染、下载、设置 |
| `src/page-hook.js` | 235 | 页面世界劫持，4 条发现路径 + 1 条补扫 |
| `src/background.js` | 236 | 工具栏开关、CORS 代理、独立窗口所有权 |
| `src/panel.html` | 13 | 独立窗口的空壳，只负责加载 `content.js` |
| `manifests/*.json` | — | 三份 manifest，构建时择一 |

---

## 4. 音频发现

这是整个扩展最难的部分。**大多数波形类扩展只查 `<audio>` 元素，所以在真实的播放器上什么都看不到**——因为很多播放器（wavesurfer.js、Howler、各类在线课程平台）根本不创建媒体元素，它们 `fetch` 到 ArrayBuffer，`decodeAudioData` 解码，然后走 `AudioBufferSourceNode` 播放。DOM 里干干净净。

所以做了 5 条独立路径，任何一条挂掉不影响其他（每条都包在 `try/catch` 里）。

### 4.1 路径 1 — 媒体元素

两侧都查：

- **内容脚本侧**：`document.querySelectorAll('audio, video')` 初扫 + `MutationObserver` 监听新增 + 捕获阶段监听 `loadedmetadata` / `play` / `canplay`。
- **页面世界侧**：包装 `window.Audio` 构造器和 `HTMLMediaElement.prototype.play/load`，覆盖 `new Audio()` 这种**永远不进 DOM** 的实例。

媒体元素本身跨不过世界边界，所以 hook 只把 `currentSrc || src` 送出来。

### 4.2 路径 2 — `decodeAudioData`（最关键）

```js
Base.prototype.decodeAudioData = function (buf, ok, bad) {
  // 同时处理 callback 和 Promise 两种调用形式
}
```

包装点选在 `BaseAudioContext.prototype`（回退 `AudioContext`），因为 `OfflineAudioContext` 也继承它。

**峰值就地计算**。拿到 `AudioBuffer` 后直接在页面世界算出 2048 桶的 min/max 数组发回来，内容脚本不需要再下载一次文件。这对 `blob:` URL 尤其重要——那种 URL 从扩展页面根本 fetch 不到。

回调和 Promise 两种形式都要包：老代码用 `decodeAudioData(buf, cb)`，新代码用 `await decodeAudioData(buf)`，漏一种就少一半站点。

### 4.3 路径 3 — `fetch`

包装 `window.fetch`，在 response 上判断：

```js
function isAudioUrl(u, ct) {
  if (ct && /^(audio\/|application\/ogg)/i.test(ct)) return true;   // Content-Type 优先
  if (u.indexOf('blob:') === 0 || u.indexOf('data:audio') === 0) return true;
  return AUDIO_RE.test(new URL(u, location.href).pathname);          // 再看扩展名
}
```

`AUDIO_RE` = `/\.(mp3|wav|m4a|mp4a|aac|ogg|oga|opus|flac|weba|webm)(\?|#|$)/i`。注意是拿 `pathname` 去测，避免 query string 里带 `.mp3` 的假阳性。

### 4.4 路径 4 — `XMLHttpRequest`

包装 `open`（记下 URL）+ `send`（挂 `load` 监听）。仍有站点用 XHR 拉音频，不能只顾 `fetch`。

### 4.5 路径 5 — 补扫（Performance API）

hook 注入时页面可能已经加载过音频了。用 `performance.getEntriesByType('resource')` 回溯，再挂一个 `PerformanceObserver({ buffered: true })` 接住后续的。这条路径是纯观察，不劫持任何东西。

### 4.6 状态可见性

面板底部有一行状态：`media 2 · url 3 · decoded 1 · hook ✓`。

这不是调试残留，是**产品功能**。当一个站点用了某种没覆盖到的方式播放音频，用户看到 `hook ✓ · decoded 0` 就知道"扩展装上了、注入成功了、但这个页面的解码路径没抓到"，而不是面对一个空面板猜是不是自己装错了。

---

## 5. 跨世界通信协议

### 5.1 为什么是 `postMessage`

第一版用的是 `window.__wfBus` + Firefox 的 `wrappedJSObject` 读页面变量。**这在 Chrome 上完全跑不起来**——Chrome 的内容脚本读不到页面世界的任何变量，`wrappedJSObject` 是 Gecko 独有的。

`window.postMessage` 是唯一在两个引擎上都能用的通道。代价是所有数据必须可结构化克隆，`Float32Array` 可以（会被克隆），DOM 元素不行。

### 5.2 消息表

**页面世界 → 隔离世界**（都带 `__wf: 1` 标记）

| `kind` | 载荷 | 含义 |
|--------|------|------|
| `ready` | — | hook 安装成功，用于点亮状态行的 `hook ✓` |
| `url` | `url` | 发现一个音频 URL |
| `decoded` | `id, url, duration, mins, maxs` | 解码事件，含 2048 桶峰值 |

**隔离世界 → 页面世界**

| 标记 | 含义 |
|------|------|
| `__wfCmd: 'rescan'` | 请求把已知的最近 8 个 URL 清掉节流重新广播 |

**内容脚本 ↔ 后台**

| `type` | 方向 | 含义 |
|--------|------|------|
| `wf:getEnabled` | CS → BG | 查全局开关 |
| `wf:fetch` | CS → BG | CORS 代理下载，返回 base64 |
| `wf:openPanel` | CS → BG | 开独立窗口，带 Lane 描述符 |
| `wf:getPanelData` | Panel → BG | 面板窗口启动时索取 Lane |
| `wf:panelLane` | CS → BG | 新发现的 Lane，转发给窗口 |
| `wf:collectLanes` | BG → CS | 向标签页要当前**活的** Lane 列表 |
| `wf:enabled` | BG → CS | 广播开关变化 |
| `wf:panelOpen` / `wf:panelClosed` | BG → CS | 页内面板让位 / 回来 |
| `wf:panelLaneFwd` | BG → Panel | 转发一条新 Lane |

### 5.3 输入即不可信

页面世界的消息**由网页控制**，必须当作敌意输入：

```js
if (e.source !== window) return;
const d = e.data;
if (!d || d.__wf !== 1 || typeof d.kind !== 'string') return;
```

再往下每个字段都重新构造（`Float32Array.from(d.mins)`、`Number(d.duration) || 0`），不直接采用页面给的对象。这些数据唯一的去向是画一条波形，不会用于任何决策。

后台的 `sanitizeLanes()` 同理：所有描述符在进 storage 前逐字段用 `String()` / `Number()` / `!!` 重建，无法转换的整条丢弃——**且任何一条坏数据都不允许阻止窗口打开**。

---

## 6. Lane 生命周期

Lane 是核心数据结构：一条波形轨。

```mermaid
stateDiagram-v2
  [*] --> 发现: offer(spec)
  发现 --> 垃圾过滤: isJunkSource()
  垃圾过滤 --> [*]: 命中，丢弃
  垃圾过滤 --> 已存在: lanes.has(key)
  已存在 --> 补全: 合并 el/buffer/peaks
  补全 --> 就绪
  垃圾过滤 --> 容量检查: 新 key
  容量检查 --> 停车场: 满且 whenFull='keep'
  停车场 --> 创建: flushParked()
  容量检查 --> 创建: 有空位
  创建 --> 加载: loadPeaks()
  加载 --> [*]: 解码失败/太短，dropLane
  加载 --> 去重: dedupe()
  去重 --> [*]: 指纹重复，dropLane
  去重 --> 就绪
  就绪 --> [*]: 用户关闭 / Clear / 扩展关闭
```

### 6.1 Lane 的键

| 前缀 | 场景 |
|------|------|
| `src:<url>` | URL 来源（媒体元素、fetch、XHR、hook） |
| `dec<n>` | 只有解码事件没有 URL 的 Web Audio |
| `file:<name>:<size>:<mtime>` | 本地打开的文件 |
| `bytes:<label>:<byteLength>` | 从字节移交进面板窗口的 |

### 6.2 容量与"停车场"

默认最多 4 条（1–8 可配）。满了以后有两种策略：

- **`keep`（默认）** — 新音频进 `parked[]` 排队，**绝不静默丢弃**。用户关掉一条或调高上限，`flushParked()` 立刻放行。
- **`replace`** — 淘汰最早的未 pin Lane；全都 pin 了就还是排队。

这是明确的产品决策。默认丢弃新音频会造成"我明明播了，为什么没出来"的困惑；默认淘汰旧的会把用户正在比对的东西挤掉。排队是唯一不会让人意外的行为。`PARK_MAX = 12`，超了从队头丢，避免长会话内存无限增长。

### 6.3 `pin`

每条 Lane 有 ☆ 按钮。pin 过的不会被 `replace` 策略淘汰。给"范读音频固定住，自己的录音一遍遍换"这个场景用的。

### 6.4 垃圾源过滤

很多播放器在每次播放前会先播一段静音的 `data:` URI，用来解锁浏览器的音频上下文（自动播放策略）。这会造成**每次播放都冒出一条 0.00s 的空 Lane**。

三层拦截：

```js
const TINY_DATA_URI = 3000;
function isJunkSource(url) {
  if (!url) return true;
  if (rejected.has(url)) return true;                          // ③ 记住失败过的
  if (url.startsWith('data:') && url.length < TINY_DATA_URI) return true;  // ① 长度启发
  return false;
}
```

外加 ② 解码后检查 `audio.duration < MIN_DUR (0.15s)` → `rejected.add(url)` + `dropLane()`。

`rejected` 这个 Set 是必需的：没有它，同一个坏源会在每次播放时被重新 fetch + 重新解码，白烧 CPU。

---

## 7. 去重：波形指纹

### 问题

站点每次播放同一个文件都会 mint 一个**新的 `blob:` URL**。所以 URL 不能当身份。同一段音频播三次 → 三条一模一样的 Lane。

更麻烦的是：同一段音频可能**同时**从两条路径进来（hook 的 `decoded` 事件 + 内容脚本自己 fetch 解码），而这两条路径给出的峰值**分辨率不同**——hook 是 2048 桶，自己解码是 8192 桶。按数组内容做哈希必然对不上。

### 解法

指纹必须与分辨率无关：

```js
function sigOf(peaks) {
  const B = 32;                          // 固定 32 桶，与输入分辨率解耦
  // 1) 找出整段的峰值，用于归一化
  // 2) 每个桶取该区间的最大绝对幅度，除以整段峰值 → 相对响度 r
  // 3) r 量化成 4 级：<0.08 静 | <0.35 弱 | <0.7 中 | 强
  // 4) FNV-1a 滚进哈希
  return duration.toFixed(2) + ':' + hash.toString(36);
}
```

`duration` 保留 2 位小数一起进指纹，作为强判别项。

**为什么是 32 桶 4 级？** 桶数太多 → 不同分辨率的边界效应会导致失配；太少 → 不同音频撞车。4 级量化是为了容忍两条路径在归一化上的微小差异。已用单元测试验证：同一段音频在 512 / 2048 / 8192 三种分辨率下产出相同指纹。

### 合并而非简单丢弃

`dedupe()` 命中时保留先到的那条，但**把后到的那条身上有而它没有的东西搬过去**：

```js
if (!other.buffer && lane.buffer) other.buffer = lane.buffer;      // 可播放性
if (!other.raw && lane.raw) { other.raw = lane.raw; ... }          // 原始字节，用于原样下载
if (other.peaks.mins.length < lane.peaks.mins.length) { ... }      // 用更高分辨率的峰值
```

典型场景：hook 先送来 2048 桶峰值（能画，但没有 AudioBuffer，播不了），随后自己解码拿到 8192 桶 + buffer + raw。合并后这条 Lane 画得更细、能播、能原样下载。

---

## 8. 时间轴模型

这是最容易做错的部分，也确实做错过一次。

### 8.1 规则

```js
function timeline() {
  let span = 0.1;
  for (const l of lanes.values()) span = Math.max(span, visDur(l));
  return { t0: 0, t1: span, span };
}
```

**可视跨度只由片段长度决定，绝不由 offset 决定。**

### 8.2 为什么

用户拖动 Shift 平移一条波形时，期望是：**坐标轴不动，波形在轴上滑**。

如果 span 跟着 offset 长（`span = max(offset + duration)`），那么每拖一个像素，整个时间轴就重新缩放一次，所有波形一起被压扁。视觉效果是波形纹丝不动、刻度在乱跳——完全是反的。

### 8.3 `visDur`

```js
function visDur(lane) {
  const full = lane.duration || (lane.el && lane.el.duration) || 0;
  if (lane.trimB == null) return full;              // 未裁剪：整段
  return Math.max(0.05, lane.trimB - lane.trimA);   // 已裁剪：只算保留段
}
```

裁剪后 span 会缩短，这是对的——裁掉静音后大家都变短了，轴应该跟着缩。

### 8.4 `t1` 的教训

`timeline()` 必须返回 `t1`。重构时曾经漏掉它，导致 `tickTransport()` 里的 `T.pos >= g.t1` 变成 `>= undefined`，**永远为 false**，播放循环永不结束 → Stop 按钮一直红着、播完不回到起点。见 [踩坑档案](#19-踩坑档案)。

---

## 9. 静音裁剪算法

`Align` 按钮做两件事：裁掉每条音频首尾的静音，然后让它们都从 0 开始。**裁剪本身就是对齐**——死气一去掉，"对齐了"和"都从 0 开始"是同一件事。

### 9.1 算法（`soundBounds`）

输入是峰值数组（不是原始采样，所以很快），四步：

**① 包络**

```js
env[i] = Math.max(maxs[i], -mins[i]);
```

**② 平滑** — 长度 `K = n/400`（约片段的 0.25%）的滑动平均。

单个爆音、一次咔哒声不该让两秒近似静音的尾巴活下来。不平滑的话，瞬时峰值判据会被任何一个杂散尖峰骗过。

**③ 阈值** — `thr = peak × cfg.trimThresh`，相对该片段自身的峰值，不是绝对值。默认 `0.08`。

用相对阈值是因为录音音量差异极大（手机录的和专业耳机录的差 20dB 不稀奇），绝对阈值没法通用。

**④ 持续判据** — 声音必须**连续保持** `run = n/200`（约 0.5%）以上才算真的开始：

```js
for (let i = 0; i + run <= n; i++) {
  let held = true;
  for (let j = i; j < i + run; j++) if (sm[j] <= thr) { held = false; break; }
  if (held) { a = i; break; }
}
```

这是第一版失败的关键修正。原来只判"第一个超过阈值的桶"，结果开头的一声轻微呼吸、结尾的一点底噪都能锚住边界，裁剪等于没做。加上持续判据后，实测构造样本（1.2s 静音 + 2s 纯音 + 1.5s 微弱噪声，共 4.70s）被正确裁到 **2.11s**。

**⑤ 安全边** — 前后各留 `pad = 0.05s`（不至于切掉爆破音的起始瞬态），裁完不足 0.15s 则放弃裁剪（拒绝荒谬结果）。

### 9.2 `trimA` / `trimB` 是视图状态

裁剪**不修改** `peaks` 数组，也不动 `buffer`。只在 Lane 上记两个数：

| 字段 | 含义 |
|------|------|
| `trimA` | 保留区起点（秒，文件坐标系） |
| `trimB` | 保留区终点；`null` = 未裁剪 |

渲染时按 `trimA/trimB` 换算成峰值数组下标区间；播放时 `src.start(when, trimA + into, visDur)`；下载时把选区时间加回 `trimA` 映射回文件坐标。

这样设计的好处：**Align 是可逆的**，再点一次全部 `trimB = null` 就恢复原状，不需要重新解码。`isTrimmed()` 遍历所有 Lane 判断当前处于哪个状态，按钮据此高亮。

### 9.3 关闭裁剪时的降级

设置里可以关掉 "Align crops silence"。此时 Align 退化为**按起音点平移对齐**：

```js
const target = Math.max(...info.map(x => x.onset));   // 对到最晚的那个起音点
info.forEach(x => { x.lane.offset = target - x.onset; });
```

仍然用 `soundBounds()` 找起音点，只是把结果用作 offset 而不是裁剪边界。

---

## 10. 播放引擎

用 Web Audio 的 `AudioBufferSourceNode`，不用 `<audio>` 元素。理由：需要**样本级的同步启动**，媒体元素的 `play()` 做不到。

### 10.1 同步启动

```js
const now = ctx.currentTime + 0.06;      // 60ms 调度余量
for (const l of lanes.values()) {
  if (!l.buffer || l.muted) continue;
  const s = l.offset, e = l.offset + visDur(l);
  if (pos >= e) continue;                                   // 已经放完了，跳过
  const src = ctx.createBufferSource();
  src.buffer = l.buffer;
  src.connect(ctx.destination);
  const into = (l.trimA || 0) + Math.max(0, pos - s);       // 从裁剪起点算起
  src.start(now + Math.max(0, s - pos),                     // 何时响
            into,                                            // 从文件的哪里开始
            Math.max(0.01, visDur(l) - Math.max(0, pos - s)) // 放多久
  );
}
```

60ms 的余量是给调度留的：所有 source 必须在同一个音频时钟基准上排好，然后一起响。少于这个量，节点多的时候会出现参差。

`src.start()` 的三个参数分别对应"什么时候响 / 从文件的哪个位置开始 / 放多长"，正是同时处理 offset 平移和 trim 裁剪所需要的全部信息。

### 10.2 播放位置

不用定时器累加，直接读音频时钟：

```js
T.pos = T.posStart + (ctx.currentTime - T.ctxStart);
```

`requestAnimationFrame` 只负责重画光标，不负责计时。定时器会漂，音频时钟不会。

### 10.3 `stopAll(rewind)` 的两种语义

| 调用 | 语义 | 用在 |
|------|------|------|
| `stopAll()` | 停下，**保持位置** | `playAll()` 开头（重启前先停）、静音切换 |
| `stopAll(true)` | 停下并**回到起点** | 播放自然结束、用户点 Stop |

区分这两者是必需的：`playAll()` 内部要先停掉正在响的，但绝不能把用户请求的播放位置抹掉。

### 10.4 让路

开始播放前把页面自己的播放器暂停：

```js
for (const l of lanes.values()) if (l.el && !l.el.paused) l.el.pause();
```

否则会听到两份重叠的声音。

### 10.5 静音的即时生效

```js
function setMute(lane, on) {
  ...
  if (T.playing) playAll(T.pos);   // 从当前位置重建整个播放图
}
```

播放中切静音，直接从当前位置重启所有 source。粗暴但正确，且因为是从 `T.pos` 重启，听感上是无缝的。做增益节点淡入淡出会更优雅，但复杂度不值得。

---

## 11. 渲染管线

Canvas 2D，每条 Lane 一块画布。

### 11.1 DPI

```js
const dpr = winOf().devicePixelRatio || 1;
cv.width  = Math.round(cssW * dpr);
cv.height = Math.round(cssH * dpr);
g.setTransform(dpr, 0, 0, dpr, 0, 0);
```

注意是 `winOf().devicePixelRatio` 而不是 `window.devicePixelRatio`。面板可以被搬到**另一块显示器**上，而两块屏的 DPI 常常不同（笔记本 Retina + 外接 1080p）。取错窗口 → 波形要么糊要么只画左上角四分之一。

```js
const winOf = () => (host && host.ownerDocument && host.ownerDocument.defaultView) || window;
```

所有涉及窗口的操作（rAF、事件监听、DPI、尺寸）都必须走 `winOf()`。

### 11.2 逐像素列绘制

```js
for (let x = L; x < R; x++) {
  const u = x - xa;
  const a = iA + Math.floor(u * iN / W);
  const b = Math.max(a + 1, iA + Math.floor((u + 1) * iN / W));
  // 该像素列覆盖的峰值区间取 min/max
  g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
}
```

每个屏幕像素列聚合它覆盖的所有峰值桶，取整体 min/max 画一条竖线。`Math.max(1, ...)` 保证极静的部分至少画出 1px 的中线，不会出现"断掉"的视觉。

`iA` / `iB` 是裁剪区间映射到峰值数组的下标——**峰值数组始终是整段的**，只是画的时候只画保留区。

### 11.3 死区

未被片段覆盖的时间用 `COLOR.dead (#39414f)` 填充。这样 offset 平移后能一眼看出"这条比那条晚开始多少"，而不是一片黑什么都看不出。

### 11.4 增益

```js
gainVal = cfg.gain === 'auto'
  ? Math.max(1, Math.min(12, peak > 0.001 ? 0.94 / peak : 1))
  : Number(cfg.gain) || 1;
```

Auto 模式取**所有 Lane 的全局峰值**算一个统一系数，让最响的那条几乎顶满（0.94），上限 ×12。

关键是**全局统一**：如果每条 Lane 各自归一化，两条响度差很多的录音会被画成一样高，音量差异这个重要信息就丢了。统一系数保证纵向可比。

### 11.5 刻度

```js
const cands = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
for (const c of cands) if (c / span * w >= 58) { major = c; break; }
const minor = major / 5;
```

选第一个能保证主刻度间距 ≥58px 的候选值。次刻度是主刻度的 1/5。span 小于 1 秒时标签显示 2 位小数，否则显示整数——练发音时经常在 0.3 秒的尺度上看，必须有小数刻度。

---

## 12. 交互设计

### 12.1 工具栏

按实际排列顺序：

| 按钮 | 动作 | 备注 |
|------|------|------|
| `▶ Play` / `■ Stop` | 同步播放全部未静音的轨 | 播放中变红 |
| `⇱ Align` | 裁静音 + 对齐 | 可切换，已裁剪时高亮；再点一次还原 |
| `↔ Shift` | 切换拖动模式 | 拖动时按住 Shift 键可临时反转 |
| `⊕ Files` | 打开本地文件 | 也支持拖拽到面板 |
| `＋ / －` | 调 Lane 高度 | 仅页内模式 |
| `⧉ Window` | 弹出到独立窗口 | 仅页内模式 |
| `Rescan` | 重扫 DOM + 请求 hook 重播 | 仅页内模式 |
| `Clear` | 清空全部（含停车场） | |
| `⚙` | 设置面板 | |

标题栏右侧另有 `－ / ＋` 折叠按钮，仅页内模式。

### 12.2 Lane 头部

`☆ pin` · 名称 · offset 读数（点击归零） · 选区读数 · 时长 · `⬇ 下载` · `◉ solo` · `🔊 静音` · `✕ 关闭`

### 12.3 鼠标

单条 `mousedown` 里根据模式分岔：

```js
const isMove = moveMode !== e.shiftKey;   // 异或：Shift 临时反转当前模式
```

| 操作 | 效果 |
|------|------|
| 拖动（选择模式） | 画选区，实时显示 `sel 0.437s` |
| 拖动（移动模式） | 平移该 Lane 的 offset，实时显示偏移量 |
| 单击（未拖动） | 定位播放头；播放中则跳转并继续播 |
| 双击 | 清除选区 |
| 点 offset 读数 | 归零 |

`Math.abs(dx) < 3` 的死区避免手抖把"点击定位"误判成"拖动"。

`mousemove` / `mouseup` 挂在 `winOf()` 上而非元素上，这样鼠标拖出画布外仍然跟手。

### 12.4 快捷键

只有一个：空格 = 播放/停止。

- 页内模式需要 `Ctrl/Cmd + Space`——裸空格是页面的（滚动、播放器自己的快捷键），不能抢。
- 面板窗口模式裸空格即可——那个窗口是我们的。

输入框内一律不响应：

```js
if (/INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable) return;
```

### 12.5 设置面板

| 项 | 默认 | 说明 |
|----|------|------|
| Max lanes | 4 | 1–8 |
| When full | Keep what is shown | 或 Replace the oldest |
| Shared time scale | on | 关掉则每条独立缩放 |
| Vertical zoom | Auto | 或 ×1 / ×2 / ×4 / ×8 |
| Align crops silence | on | 关掉则 Align 退化为起音点平移 |
| Crop strength | Normal (0.08) | Gentle 0.04 / Aggressive 0.15 |

设置改动立即 `saveSettings()` 写 storage，不需要"保存"按钮。

### 12.6 样式隔离

面板挂在 Shadow DOM（`mode: 'open'`）里，宿主元素带一串 `!important`：

```js
'position:fixed!important;z-index:2147483600!important;' +
'right:16px!important;bottom:16px!important;display:block!important;...'
```

`z-index` 取 `2147483600`（略低于 int32 上限，给页面上可能存在的模态框留一点余地）。Shadow DOM 保证页面 CSS 进不来，`!important` 保证页面 CSS 覆盖不掉宿主定位。这两层缺一不可——见过站点用 `div { position: static !important }` 这种全局规则。

---

## 13. 独立窗口与 Lane 移交

### 13.1 为什么不用 `window.open` + DOM 搬迁

第一版是把面板的 DOM 通过 `document.adoptNode()` 搬进 `window.open()` 出来的弹窗。Chrome 上能跑，**Firefox 上报 `Permission denied to access property "constructor"`**——跨窗口 DOM 收养在 Gecko 上受安全策略限制，不可移植。

现在的做法：后台用 `windows.create({ url: 'panel.html', type: 'popup' })` 开一个**真正的扩展页面**，那个页面加载同一份 `content.js`，以 `IS_PANEL=true` 模式跑。Lane 以**描述符**的形式移交。

好处不止是可移植：真正的浏览器窗口能拖到副屏、能被系统窗口管理器管理、且**独立于标签页存在**——标签页导航走了，窗口和里面的波形还在。

### 13.2 描述符与字节移交

```js
function laneDescriptor(l) {
  const d = { url, label, offset, muted };
  const refetchable = /^https?:/i.test(d.url);
  if (!refetchable) {
    const bytes = laneBytes(l);
    if (bytes) { d.b64 = bytes.b64; d.mime = bytes.mime; }
    else d.unavailable = true;
  }
  return d;
}
```

`http(s)` URL 只传 URL，窗口自己重新拉取（走后台代理，不受 CORS 限制）。

**`blob:` / `data:` / 本地文件必须传字节**——`blob:` URL 属于创建它的页面，扩展页面 fetch 不到。

`laneBytes()` 有两级回退：

1. 有原始字节（`l.raw`，≤12MB）→ 直接 base64。
2. 否则从 `AudioBuffer` **重新编码成单声道 WAV**再 base64。单声道是为了控体积。
3. 都不行 → `unavailable: true`，窗口里不显示这条，状态行提示用户重播或用 `⊕ Files`。

`XFER_MAX = 12MB` 是 base64 后仍能安全过消息通道的经验值（base64 会膨胀 4/3）。

### 13.3 活列表 vs 快照

窗口启动时不读后台缓存的快照，而是**向标签页要当前活的列表**：

```js
async function currentLanes() {
  if (panelTabId !== null) {
    const r = await api.tabs.sendMessage(panelTabId, { type: 'wf:collectLanes' });
    if (r && Array.isArray(r.lanes)) return sanitizeLanes(r.lanes);
  }
  // 标签页没了才回退到 storage 快照
  const { panelLanes } = await api.storage.local.get('panelLanes');
  return sanitizeLanes(panelLanes);
}
```

原因：后台原来维护一个**只增不减**的快照，被 `dedupe()` 合并掉的 Lane 仍然留在里面，窗口打开后会看到早就不存在的幽灵轨。向标签页要活列表是唯一正确的数据源。

### 13.4 窗口优先原则

```js
async function openPanel(lanes, tabId) {
  try { await showWindow(); }              // 先开窗
  catch (e) { return { ok: false, ... }; }
  try { await api.storage.local.set({ panelLanes: sanitizeLanes(lanes) }); }
  catch (e) { partial = true; ... }        // 载荷失败只是软提示
  return partial ? { ok: true, partial: true } : { ok: true };
}
```

用户点的是"给我一个窗口"。载荷出任何问题都不能导致窗口开不出来——最坏情况给一个空窗口加一句提示，也好过一个错误对话框。

`popOut()` 侧还有一层：如果带载荷的请求整个抛异常，就**不带载荷再请求一次**。

### 13.5 只有一个面板

窗口开着的时候，页内面板 `display: none`；窗口关掉（`windows.onRemoved`）时广播 `wf:panelClosed`，页内面板回来。

---

## 14. 下载与 WAV 编码

### 14.1 三种情况

| 状态 | 产物 | 文件名 |
|------|------|--------|
| 有选区 | 选区编码为 WAV | `name_1.23-4.56s.wav` |
| 已裁剪、无选区 | 保留段编码为 WAV | `name_trimmed.wav` |
| 原样 | 原始字节（有 `raw` 时） | `name.mp3` |
| 兜底 | 整段编码为 WAV | `name.wav` |

有原始字节时优先原样保存——重编码是有损的（解码→PCM→WAV 虽然 PCM 无损，但原文件的元数据、比特率信息都没了）。

### 14.2 坐标换算

选区时间是**可视时间轴**上的，写文件时要加回 `trimA` 换算到文件坐标：

```js
const a = Math.max(0, t0 + lane.selA);        // t0 = lane.trimA
const b = Math.min(lane.duration, t0 + lane.selB);
```

### 14.3 WAV 编码器

手写 44 字节 RIFF 头 + 16-bit PCM。`encodeWavBuffer()` **总是自己 `new ArrayBuffer()`**，返回的缓冲区不与 `AudioBuffer` 共享内存——这样结果可以安全地 base64、可以跨上下文传递，不会在任何引擎上触发跨域缓冲区的安全检查。

浮点转 16-bit 时非对称缩放：

```js
v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
```

负半轴用 32768、正半轴用 32767，这是 16-bit PCM 的正确映射（值域 −32768..32767 不对称）。

---

## 15. 跨浏览器差异

一份 `src/`，三份 manifest，构建时择一。

| | Chrome | Firefox |
|---|--------|---------|
| Manifest 版本 | MV3 | MV2（另备 MV3 版） |
| 后台 | `service_worker` | 持久 background page |
| 工具栏 API | `chrome.action` | `browser.browserAction` |
| 最低版本 | Chrome 109 | Firefox 140 / Android 142 |
| `web_accessible_resources` | 对象数组（带 `matches`） | 字符串数组 |
| 页面世界变量 | **完全读不到** | `wrappedJSObject`（未使用） |
| 跨窗口 DOM 收养 | 可以 | **禁止**（已弃用此方案） |
| 数据收集声明 | 审核表单里填 | manifest 里必须声明 |

### 15.1 兼容垫片

```js
const api = (typeof browser !== 'undefined') ? browser : chrome;
const action = api.action || api.browserAction;
```

### 15.2 Service Worker 的约束

MV3 的 service worker **会被随时终止**，所以后台**不缓存任何模块级状态**：

```js
async function isEnabled() {
  const r = await api.storage.local.get('enabled');   // 每次都从 storage 读
  return r.enabled !== false;
}
```

例外是 `panelWindowId` / `panelTabId`——它们的生命周期本来就绑在窗口上，worker 重启后窗口若还在，`windows.update()` 会失败并自动回落到重新创建。

### 15.3 消息通道的异步回复

```js
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'wf:fetch') {
    proxyFetch(msg.url).then(sendResponse);
    return true;                     // 两个引擎上都靠这个保持通道开启
  }
});
```

### 15.4 Firefox 的数据收集声明

Firefox 140+ 起，AMO 强制要求：

```json
"data_collection_permissions": { "required": ["none"] }
```

缺了这个键，AMO 校验直接报错拒收。这也是 `strict_min_version` 被顶到 140 / Android 142 的原因——这个键在更老的版本上不被识别。

---

## 16. 权限与隐私

### 16.1 申请了什么

| 权限 | 为什么 |
|------|--------|
| `storage` | 存两样东西：开关状态、面板的位置和尺寸、用户设置 |
| `<all_urls>` | ① 内容脚本必须在 `document_start` 就位于**用户当前所在的任意页面**——这个页面无法预先枚举；② 音频常从无 CORS 头的 CDN 来，重读字节必须在后台上下文进行 |

**没有申请**：`downloads`（用 `<a download>` + Blob URL 即可）、`tabs` 的敏感部分、`webRequest`、麦克风、剪贴板。

### 16.2 数据流

- 音频**在本地解码**，`AudioBuffer` 和峰值数组都只存在于内存。
- 扩展**不发起任何自己的网络请求**，除了重读页面已经加载过的音频文件。
- 无账号、无服务器、无遥测、无分析。
- `storage.local` 里没有任何用户内容或浏览历史。

### 16.3 CSP 与代码来源

- 无 `eval`、无远程脚本、无外部库。整个扩展零依赖。
- `page-hook.js` 通过 `web_accessible_resources` 暴露，用 `<script src>` 注入——这是扩展自己包内的文件，不是远程代码。
- 面板 UI 用 `createElement` 构建（早期用 `innerHTML` 被 addons-linter 报了 3 处警告，已全部改掉）。Lane 节点仍用 `innerHTML`，但模板是**完全静态的字面量**，无任何插值。

---

## 17. 持久化 Schema

`storage.local` 三个键：

```jsonc
{
  "enabled": true,                 // 全局开关，工具栏按钮控制

  "settings": {                    // 用户设置
    "maxLanes": 4,
    "whenFull": "keep",            // "keep" | "replace"
    "sync": true,
    "gain": "auto",                // "auto" | 1 | 2 | 4 | 8
    "trimOnAlign": true,
    "trimThresh": 0.08             // 0.04 | 0.08 | 0.15
  },

  "panelLanes": [                  // 独立窗口的载荷快照（回退用）
    { "url": "...", "label": "...", "offset": 0, "muted": false,
      "b64": "...", "mime": "audio/wav", "unavailable": false }
  ]
}
```

外加面板几何信息（页内模式的位置和尺寸），由 `saveGeometry()` / `restoreGeometry()` 维护。

关掉扩展时 `panelLanes` 会被清空——"off 必须不留任何东西"。

---

## 18. 关键设计约束与取舍

| 决策 | 取舍 |
|------|------|
| **峰值而非原始采样** | 所有分析（裁剪、指纹、渲染）都跑在 2048/8192 个峰值上，不碰几百万个采样点。快几个数量级，精度对本用途完全够。 |
| **裁剪是视图状态** | 不修改 buffer，所以可逆、零成本、不需要重解码。代价是每个消费点（渲染/播放/下载）都要自己做坐标换算。 |
| **满了排队而不是丢弃** | 用户明确要求"不要直接丢弃"。代价是需要维护停车场和 `flushParked()`。 |
| **全局统一增益** | 保住了响度的可比性，代价是特别小声的那条可能看不太清。 |
| **一份 `content.js` 双模式** | 面板窗口和页内面板永不行为漂移。代价是文件大（1671 行），且到处要判 `IS_PANEL`。 |
| **`postMessage` 而非 `wrappedJSObject`** | 可移植。代价是数据必须可克隆，且必须当作不可信输入校验。 |
| **不用外部库** | 包体 45KB，无供应链风险，商店审核简单。代价是 WAV 编码器、峰值计算、绘图全部手写。 |
| **Shadow DOM + `!important`** | 页面 CSS 打不进来。代价是调试时得展开 shadow root。 |
| **状态行是产品功能** | 页面用了没覆盖的播放方式时，用户能看懂发生了什么。代价是界面上多一行技术性文字。 |

---

## 19. 踩坑档案

这一节记录实际踩过的坑和修法，避免重犯。

### 19.1 装上了但什么都不显示

**现象**：扩展装好，目标站点上完全没反应。
**原因**：v1.0 只查 `<audio>` 元素。该站点是纯 Web Audio 播放器，DOM 里没有任何媒体元素。
**修法**：加了 `decodeAudioData` / `fetch` / `XHR` / Performance 四条路径，加状态行，内容脚本改到 `document_start` 注入。

### 19.2 Chrome 版完全不工作

**现象**：Firefox 正常，Chrome 一片空白。
**原因**：hook 把数据存在 `window.__wfBus`，内容脚本用 `window.wrappedJSObject` 读——**这是 Gecko 独有的**。Chrome 的内容脚本读不到页面世界的任何变量。
**修法**：全面改用 `window.postMessage`，接收侧做形状校验。

### 19.3 AMO 校验失败

**现象**：`The "data_collection_permissions" property is missing.`
**原因**：Firefox 140 起的新强制要求，训练数据里没有。
**修法**：查了官方 schema，加 `"data_collection_permissions": { "required": ["none"] }`，`strict_min_version` 提到 140 / Android 142；顺手把 3 处 `innerHTML` 警告改成 `createElement`。本地 `addons-linter` 验证 0 error / 0 warning / 0 notice。

### 19.4 Firefox 弹窗报 `Permission denied to access property "constructor"`

**原因**：跨窗口 `document.adoptNode()` 在 Gecko 上受限。
**修法**：改为 `windows.create` 开真正的扩展页面 + 描述符移交（见 §13）。同时让 `bufToB64` 永不抛异常，加 WAV 重编码回退，并且**先开窗再处理载荷**。

### 19.5 同一段音频出现多条重复波形

**原因**：站点每次播放 mint 新的 `blob:` URL。
**第一次尝试失败**：按峰值数组内容哈希——两条路径的分辨率不同（2048 vs 8192），永远对不上。
**修法**：32 桶 4 级的分辨率无关指纹（见 §7），并做了跨 512/2048/8192 的单元测试。

### 19.6 面板窗口里出现早已删掉的轨

**原因**：后台维护的是只增不减的快照，被 dedupe 合并掉的 Lane 仍在里面。
**修法**：改为向标签页要活列表（`wf:collectLanes`），storage 快照降级为标签页消失时的回退。

### 19.7 Shift 拖动时坐标轴在动、波形不动

**原因**：`timeline()` 的 span 跟着 offset 增长，导致每拖一像素整个轴就重新缩放。
**修法**：span 只由片段长度决定（见 §8）。

### 19.8 播完 Stop 按钮还是红的、不回起点

**原因**：这是我自己在 §19.7 的重构里引入的回归——新的 `timeline()` 漏了返回 `t1`，于是 `T.pos >= g.t1` 变成 `>= undefined`，恒为 false，播放循环永不结束。
**修法**：补回 `t1`；同时把 `stopAll()` 拆成 `stopAll()` / `stopAll(true)` 两种语义。
**教训**：改动一个被多处消费的返回结构时，要检查所有消费点，不能只看改动处能不能跑。

### 19.9 Align 裁不干净

**原因**：用瞬时峰值判据，任何一个杂散尖峰都能锚住边界。
**修法**：平滑包络 + 持续判据（见 §9）。构造样本验证：4.70s → 2.11s。

### 19.10 关掉一条轨后重新播放，波形不再出现

**原因**：`page-hook.js` 里的 `seenUrls` 是**永久**去重。轨被关掉后，同一个 URL 再也不会被广播，那段音频在页面刷新前都不可达。
**复现**：构造了一个在 hook 安装前就抓走原生 `decodeAudioData` 的页面（匹配他观察到的 `decoded 0`）。
**修法**：改成 900ms 的**节流**而非永久去重（去重交给面板自己判），并把 `Rescan` 接到 hook 的重播命令上。

### 19.11 每次播放都冒出一条空的 0.00s 轨

**原因**：站点在每次播放前放一段静音的 `data:` primer 解锁音频上下文。
**修法**：三层拦截——`data:` URI 长度启发、解码后 `MIN_DUR` 检查、`rejected` Set 记住失败源（见 §6.4）。

### 19.12 设置面板里出现一个多余的灰色小块

**原因**：CSS 类名撞车——设置里的 `<select class="sel">` 撞上了 Lane 头部选区读数的 `.sel`。
**修法**：设置里的改名 `.pick`。

---

## 20. 测试策略

没有单元测试框架。用 **Playwright + Chromium `--load-extension`** 驱动真实加载的扩展，对着构造的页面跑端到端断言。

理由：这个扩展的绝大多数 bug 都是**环境交互**问题（世界隔离、消息通道、CORS、DPI、站点的怪异播放方式），mock 掉这些正好把 bug 藏起来。

### 20.1 工作方法

固定三步，不跳步：

1. **先复现** — 构造一个匹配观察到的现象的最小页面（"decoded 0"、"每次播放多一条空轨"）。复现不了就不动手改。
2. **再修**。
3. **回归验证** — 跑全套。

### 20.2 回归套件

| 脚本 | 覆盖 |
|------|------|
| `regress.js` | 10 项基础检查 |
| `n1.js` | Align / Shift / 设置持久化 |
| `n2.js` | 容量上限与停车场队列 |
| `t.js` | 裁剪正确性 + 播放结束行为 |
| `v6.js` | 去重 / blob URL / 独立窗口 |
| `v7.js` | 关闭开关时所有窗口退出 |
| `fb.js` | 字节移交的回退路径 |
| `repro2.js` / `rescan.js` | 重播恢复 |
| `dp.js` / `dp2.js` | `data:` primer 过滤 |

v1.1.5 全部通过，零 JS 错误，AMO linter 0/0/0。

### 20.3 手工测试页

`test/demo.html`（`<audio>` 元素）和 `test/real.html`（Web Audio 路径），用于人工回归。

### 20.4 测试环境自身的坑

有几次"bug"其实出在测试脚手架上，记下来避免误判：

- 测试页里有一份**过期的本地 `content.js`**，遮蔽了扩展真正加载的那份。
- 像素探针把死区的灰色也算成了波形。
- 一个断言在队列已经排空之后才去检查 Lane 数量。

---

## 21. 构建与发布

### 21.1 `build.sh`

```
src/ + manifests/<target>.json  →  build/<target>/  →  dist/*.zip
```

四个产物：

| 产物 | 用途 |
|------|------|
| `waveform-viewer-chrome-<ver>.zip` | Chrome Web Store 提交 |
| `waveform-viewer-firefox-<ver>.zip` | AMO 提交（MV2） |
| `waveform-viewer-source-<ver>.zip` | AMO 要求的可复现构建源码（只含 `src` `manifests` `build.sh` `README.md` `LICENSE`） |
| `waveform-viewer-repo-<ver>.zip` | 完整仓库快照，用于同步工作副本 |

`firefox-mv3` 作为可选参数构建 MV3 变体。

版本号从 `manifests/chrome.json` 读，是唯一真实来源；发版时三份 manifest 一起改。

### 21.2 发布前检查

1. 三份 manifest 版本号一致
2. `npx addons-linter dist/waveform-viewer-firefox-<ver>.zip` → 0/0/0
3. 跑完整回归套件
4. 在两个浏览器里手工装一遍，过一遍 `test/real.html`

### 21.3 商店素材

`store/` 目录：`listing-en.md`（名称、简短描述、详细描述、权限说明）、`privacy-policy.md`、`reviewer-notes.md`、`screenshots/`。

权限说明必须写清楚 `<all_urls>` 的两个理由（见 §16.1），这是审核最容易卡的地方。

---

## 22. 未来方向

按价值排序，都还没做：

1. **A/B 循环播放** — 选一段反复播。练发音时最想要的功能。
2. **播放速率** — 0.5× / 0.75× 慢放，听清连读。
3. **音节核检测叠加** — 在波形上标出音节位置，直接看出重音落点。这是从 PTE 声学对比法里出来的需求，也是扩展最初的动机。
4. **导出对比图** — 把当前面板存成 PNG，便于记录练习进度。
5. **会话持久化** — 关掉页面后波形还在。需要把 buffer 落到 IndexedDB。
6. **键盘导航** — 现在只有空格，应该有逐帧/逐秒移动播放头。

明确**不做**的：频谱图、F0 曲线、多轨混音、录音功能。这些要么属于专业工具的领域，要么会把权限面扩大到得写真正的隐私政策。

---

*文档对应 v1.1.5。修改代码时请同步更新本文档中受影响的小节。*
