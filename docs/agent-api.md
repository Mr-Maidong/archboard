# 控制台接口（Agent API）

页面加载后会在 `window` 上挂一个 `archboard`（别名 `agent`）。它是给模型和脚本用的：**JSON 进、JSON 出**，所有写操作都走撤销历史与本地存储 —— 也就是说不光模型能用，你在控制台里手敲也一样，画完还能用 ⌘Z 反悔。

接口是 UI 内部那套函数的薄封装：用接口画出来的东西，和用鼠标画出来的完全一样，图层树、检查器、导出、存盘全都认。

## 快速开始

```js
archboard.help()    // 工具清单 + 参数说明
archboard.guide()   // 一段给模型看的操作提示（纯文本）
archboard.state()   // 当前画布、元素、选中、缩放
```

调用的两种写法等价：

```js
archboard.create({ type: 'card', x: 0, y: 0, title: '网关' })
archboard.call('create', { type: 'card', x: 0, y: 0, title: '网关' })
```

通过 chrome-devtools MCP 驱动时，一次 `evaluate_script` 就是一次工具调用：

```js
() => archboard.call('create', { type: 'panel', label: '接入层', x: 0, y: 0 })
```

## 约定

| 项 | 说明 |
|---|---|
| 坐标 | 画布像素，原点在画布左上角，y 向下；元素以**左上角**定位 |
| 尺寸 | 层带面板 1800×140、卡片 390×92、文字 420×44、图片 96×96 |
| 颜色 | `#rrggbb` 或 `#rrggbbaa`（带透明度） |
| 成功返回 | `{ ok: true, ... }` |
| 失败返回 | `{ ok: false, error: { code, message, hint } }`，不抛异常 |
| 错误码 | `bad_tool` / `bad_type` / `bad_args` / `bad_mode` / `not_found` / `need_confirm` / `exception` |

## 工具一览

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `state` | 读画布、元素、选中、缩放 | — |
| `find` | 按类型或文案筛元素 | `type`, `text` |
| `create` | 新建元素，返回新 id | `type`, `x`, `y`, `w`, `h`, 以及该类字段（`title`/`label`/`text`…） |
| `update` | 批量改样式，只认该类支持的字段 | `ids`, `patch` |
| `remove` | 删除元素（连带删掉挂在它身上的连线） | `ids` |
| `duplicate` | 复制，可带偏移 | `ids`, `dx`, `dy` |
| `select` | 设置选中 | `ids`, `reveal` |
| `align` | 对齐到选区外接框 | `ids`, `mode`: `left`/`cx`/`right`/`top`/`cy`/`bottom` |
| `distribute` | 水平或垂直等距（≥3 个） | `ids`, `axis`: `h`/`v`, `gap` |
| `layout` | 按行或列依次排开 | `ids`, `dir`: `row`/`column`, `gap`, `x`, `y` |
| `connect` | 两个元素之间连线 | `from`, `to`, `mode`, `dash`, `head`, `color` |
| `view` | 视图：适应窗口 / 指定缩放 / 聚焦选区 | `fit`, `zoom`, `ids` |
| `exportPNG` | 导出 PNG，返回 dataURL | `scale`（默认 2） |
| `exportJSON` | 导出工程 JSON 字符串 | — |
| `importJSON` | 载入工程 JSON（整体替换） | `json` |
| `undo` / `redo` | 撤销 / 重做一步 | — |
| `clear` | 清空全部元素 | `confirm: true`（必填，防误触） |
| `run` | 顺序执行多个调用 | `ops: [{ tool, args }]` |
| `help` / `guide` | 清单 / 操作提示 | — |

`update` 的 `patch` 接受哪些字段，按类型白名单校验（不在白名单里的字段会被忽略，并在返回的 `ignored` 里列出来，不会静默写坏数据）：

- **面板**：`label` `labelSize` `labelColor` `accent` `stroke` `fillColor` `fillAlpha` `bg` `radius` `shadow` `corners` `x` `y` `w` `h` `opacity`
- **卡片**：`title` `sub` `titleSize` `titleColor` `subSize` `subColor` `accent` `stroke` `fill` `icon` `layout` `radius` `shadow` `corners` `x` `y` `w` `h` `opacity`
- **文字**：`text` `size` `color` `weight` `align` `x` `y` `w` `h` `opacity`
- **图片**：`src` `fit` `x` `y` `w` `h` `opacity`
- **连线**：`from` `to` `fromSide` `toSide` `mode` `dash` `head` `double` `color` `strokeW`

## 典型脚本：两层架构图

```js
const ab = window.archboard;

ab.clear({ confirm: true });

ab.create({ type: 'text', x: 60, y: 20, w: 900, h: 48, text: '示例架构', size: 30 });

const p1 = ab.create({ type: 'panel', x: 60, y: 90, w: 1500, h: 160, label: '接入层' }).id;
const p2 = ab.create({ type: 'panel', x: 60, y: 300, w: 1500, h: 160, label: '服务层' }).id;

const mk = (t, y, sub) => ['移动端', '控制台', 'API'].map((n, i) =>
  ab.create({ type: 'card', x: 120 + i * 470, y, w: 400, h: 90, title: n + t, sub }).id);

const top = mk('', 130, '接入通道');
const bot = mk('', 340, '处理逻辑');

ab.layout({ ids: top, dir: 'row', gap: 70, x: 120, y: 130 });
ab.layout({ ids: bot, dir: 'row', gap: 70, x: 120, y: 340 });
top.forEach((id, i) => ab.connect({ from: id, to: bot[i], mode: 'straight' }));

ab.update({ ids: [...top, ...bot], patch: { shadow: 2 } });
ab.view({ fit: true });
```

## 怎么接到真正的 MCP

`archboard` 本身只是页面里的一个对象，要变成 MCP 工具，外面套一层 CDP 桥即可：

```js
// bridge.js —— Node 侧，用 chrome-remote-interface 连到已经打开的浏览器
import CDP from 'chrome-remote-interface';

const client = await CDP({ port: 9222 });
const { Runtime } = client;
await Runtime.enable();

const evalInPage = async (expr) =>
  (await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true })).result.value;

// tools/list：直接来自页面
const { tools } = await evalInPage('archboard.help()');

// tools/call：
const callTool = (name, args) =>
  evalInPage(`archboard.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
```

`help()` 返回的 `tools` 是可以直接映射成 MCP `tools/list` 的：`name` 对应 `name`，`desc` 对应 `description`，`args` 是参数结构。

## 安全与边界

- 接口不联网、不读文件，只操作当前页面里的模型；数据仍然只存在浏览器本地。
- `clear` 必须显式传 `confirm: true`，避免模型在未确认时把画布清空。
- 不需要这个能力时，删掉 `app.js` 末尾「智能体接口」那一段即可，UI 不受影响。
