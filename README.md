# dsh-session-cost · 会话花费与余额

DeepSeek Harness 的 UI 插件（bundle）：在对话框（composer）下方那一行的末尾加一个信息药丸，显示**本次会话（含子代理 / 团队会话）已花多少钱**与**账户还剩多少钱**；悬浮或点击弹出明细面板，可看到总花费的构成（主会话 + 每个子代理会话）。

注册位置：`conversation.composer.dock`（对话框卡片下方的环境条目行），与官方 Token 统计药丸、上下文占用环同排，排在行末（红框位置）。

## 显示内容

- **本次会话花费（含子代理会话）**：Agent Team 的队友与子代理在 DSH 里是**独立的 Session**（会话头部记录 `parentSession`），所以「本次会话」的真实花费 = 本会话 + 它的整棵子代理会话树。Host 半通过一个同源只读路由（`GET /api/plugin/session-cost?sessionId=…`）汇总每个会话的 `sessionCost` 投影返回，浏览器端按**每个会话自己的模型**分别计价后求和。面板用「**费用构成**」一节把这个总数拆开：`主会话` + `子代理会话（N 个）` + 每个子代理会话各自一行 + `合计`，因此总数和每一部分一眼可对。每个会话内部仍按**每笔用量实际发生的时段**分别计价：高峰样本按高峰价（空闲 ×2），空闲样本按空闲价，因此数字不会因为时钟跨过时段边界而跳变。Host 路由不可用时（旧 Host / 尚未重载 Host 半）自动退回「仅本会话」口径。
- **剩余金额**：来自账户 Remote（`ctx.remote.account.getBalance`），与「设置 → 账户」页同一数据源。芯片显示**充值余额 + 赠金余额**的合计（平台扣费优先扣赠金，两者都可用），面板里再分别列出。余额是**整个账户共用**的（其他会话、子代理、其他工具、另一台设备都会扣同一个余额），而本插件展示的是「本次会话花费」；页面打开前或不属于本会话树的扣费不会显示在这里。

**悬浮 260ms 或点击芯片**会打开一个锚定在芯片上方（下方空间不足时自动翻转、并始终限制在视口内）的明细面板，样式沿用官方 `stat-dialog` 的设计语言（菜单表面 + 毛玻璃 + 描边阴影 + 12/18 字号 + 标签值网格），深浅色主题自动跟随。面板先给「费用构成」拆分，再按时段分节展示 token 与金额，鼠标移入可查看：

```
[icon] 本次会话花费                    ¥6.89
────────────────────────────────────────────
计价模型            deepseek-flash
计价口径            按每笔用量发生的时段（高峰 ×2）
费用构成
  主会话                                ¥4.83
  子代理会话（3 个）                    ¥2.06
    · 独立审计                          ¥0.90
    · 测试补全                          ¥0.70
    · 独立复核                          ¥0.46
  合计                                  ¥6.89
高峰时段（×2）
  输入 · 缓存未命中    2,000,000 tok   ¥4.00
  输入 · 缓存命中      10,000,000 tok  ¥0.40
  输出                100,000 tok      ¥0.80
  小计                                ¥5.20
空闲时段（×1）
  输入 · 缓存未命中    1,234,567 tok   ¥1.23
  输出                115,000 tok      ¥0.46
  小计                                ¥1.69
────────────────────────────────────────────
充值余额            ¥12.34
赠金余额            ¥3.00
可用合计            ¥15.34
────────────────────────────────────────────
按每笔用量发生的时段计价，仅供参考
```

芯片形态是 `花费 ¥6.89 · 余额 ¥15.34`。

交互：悬浮预览、移开 200ms 后关闭（鼠标可移入面板查看，不会闪断）；点击固定打开，再次点击 / 点击外部 / `Esc` 关闭；打开时芯片高亮，`aria-expanded` 同步。

> Host 投影不可用（例如 Host 进程还是旧版本、未加载本插件的新 Host 半）时，芯片降级为按当前时段估算，数字前加 `≈`，面板「计价口径」一行会说明原因，因而此时仍会随边界变化——这是有意的显式降级，不会伪装成精确值。会话树路由不可用时，芯片只显示本会话花费（v1.1 口径），不会报错。

## 安装（当前设备）

已安装到 `desktop` profile（`plugin_manager` 的 `install_bundle`，`application: applied`），以 `link:` 方式链接到本仓库目录：

```
+ @local/dsh-session-cost link:<本仓库克隆目录>
```

因此克隆目录就是运行中的插件目录：改 `client.js` 后刷新页面即刻生效，不必重装；改 `index.js` / `host/`（Host 半）后需要让 Host 重新载入一次插件（见「已知取舍」）。**不要移动或删除该目录**，否则插件失效。

移除：`plugin_manager({ action: "remove_bundle", target: "@local/dsh-session-cost" })`。

## 在另一台设备上复用

前置条件：

- 已安装 DeepSeek Harness（开发验证于 `0.2.0-rc.2`，Desktop / Web 均可用）；
- profile 中带有账户能力（`@deepseek-ai/dsh-deepseek-account-platform` + `@deepseek-ai/dsh-api-account-controller`，桌面版默认带），并登录同一 DeepSeek 账号；否则芯片只显示花费，余额处显示「余额不可用」。

**方式 A：从 GitHub 直接安装（无需手动 clone）**

```
plugin_manager({ action: "install_bundle", target: "https://github.com/jqstrong/dsh-session-cost.git" })
```

若该设备直连 `github.com` 的 HTTPS 不通（连接被重置 / 超时），安装时可改用 SSH 形式（要求该设备已配置 GitHub SSH key；`ssh.github.com:443` 也适用）：

```
plugin_manager({ action: "install_bundle", target: "git+ssh://git@github.com/jqstrong/dsh-session-cost.git" })
```

**方式 B：先 clone 再按本地目录安装（推荐，便于改价格表后热更）**

```bash
git clone https://github.com/jqstrong/dsh-session-cost.git
# HTTPS 不通时：git clone ssh://git@github.com/jqstrong/dsh-session-cost.git
```

```
plugin_manager({ action: "install_bundle", target: "<clone 目录的绝对路径>" })
```

装完立即生效（返回 `application: applied`）；若页面未刷新，手动刷新一次。`package.json` 里的 `private: true` 只阻止误发布到 npm，不影响 git 安装。

## 计价口径与价格表

**Host 半**（`index.js`）向会话投影注册一个私有键 `sessionCost`，它把每条 provider 用量样本按**该样本所在会话事件的 `time`** 折进 `peak` / `off` 两个桶（整份持久日志、不受分页与压缩影响），并把结果以整值 wire view 推给浏览器。它逐条镜像官方 `tokenUsage` 单元的口径（同样的 `assistant/message` / `assistant/attempt` 来源、同样的重试占位规则），所以两个单元的总量恒等 —— 区别只是多了时段维度。

**Client 半**（`client.js`）把两个桶分别按各自单价计价再求和：

- `'auto'`（默认）：`peak` 桶 × `PEAK_MULTIPLIER`，`off` 桶 × 1 —— 即按实际发生时段计价。
- `'peak'` / `'idle'`：把全部用量固定按高峰 / 空闲价计（调试或特殊计价口径用）。

`client.js` 顶部常量是唯一配置面，改完保存后由插件热载/页面刷新生效：

| 常量 | 含义 |
| --- | --- |
| `PRICES` | 每百万 tokens 的**空闲时段**单价：`{ 币种: { 模型: { cacheHit, cacheMiss, output } } }` |
| `PRICING_MODE` | `'auto'`（每笔按自己发生的时段，默认）/ `'peak'` / `'idle'` |
| `PEAK_MULTIPLIER` | 高峰相对空闲的倍数（官方为 2） |
| `BALANCE_REFRESH_MS` | 余额自动刷新间隔（默认 60s） |
| `TREE_REFRESH_MS` | 会话树（含子代理会话）花费的刷新间隔（默认 20s） |
| `HOVER_OPEN_MS` / `HOVER_CLOSE_MS` | 悬浮打开 / 关闭延迟 |
| `PANEL_GAP` / `PANEL_MARGIN` | 面板与芯片的间距 / 距视口边缘的最小距离 |

高峰时段在 Host 半按北京时间判定：周一至周五 09:00–12:00 与 14:00–18:00（`index.js` 的 `PEAK_MORNING` / `PEAK_AFTERNOON`）。改价格表之外的时段规则时两个文件都要同步改。

出厂价格（每百万 tokens，空闲时段；高峰 ×2）：

| 币种 | 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| CNY | `deepseek-flash` | 0.02 | 1 | 4 |
| CNY | `deepseek-v4-pro` | 0.15 | 4.5 | 13.5 |
| USD | `deepseek-flash` | 0.003 | 0.15 | 0.6 |
| USD | `deepseek-v4-pro` | 0.022 | 0.66 | 1.98 |

来源：[DeepSeek 官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。表里没有的模型回退到 `default` 行。

## 已知取舍

- 会话花费是**按样本时段分摊的近似值**：每条用量样本的整笔用量归入该样本事件所在时段（真实的按请求计费也以请求时刻为准，两者在边界秒级上可能差一条请求的用量）。中国法定节假日未建模（节假日会按高峰计价，偏高）。
- 余额可能下降而「本次会话花费」没有增加：余额是**账户级**的，本机没有记录/其他窗口的会话、其他工具/API key、另一台设备、赠金过期等都会扣同一个余额。本插件只展示**本次会话树**的花费，不展示账户级总扣费；对照账户余额变化时请留意这一点。
- 会话树的子代理部分由 Host 半的只读路由（`GET /api/plugin/session-cost`）汇总：最多遍历 40 个会话、跳过读不到投影的会话（超过上限时尾部子会话可能缺失，`truncated` 目前不在 UI 里显示）；标题生成、会话初始化这类**不写入会话 token 用量**的请求不计入树（金额极小）。不属于本会话树的并发会话（另一个窗口/设备、其他工具）也不在芯片内。
- 混合模型的子代理会话按各自模型精确计入合计，但面板按时段的「小计」用当前显示模型计价，标题合计与各小计之和可能相差几分。
- Host 半的改动需要插件重新载入：修改 `index.js` / `host/` 后在当前 DSH 里由 HMR 重载 profile（修改 profile patch 触发一次 recomposition）或执行一次 `plugin_manager` 的 `set_bundle`（`target: "@local/dsh-session-cost", enabled: true`）；不支持热载的旧版本需要重启 Harness。**v1.1→v1.2 的会话树路由属于 Host 半**，只刷新页面不会启用；未重载时客户端自动退回 v1.1 的「仅本会话」口径。只改 `client.js` 时刷新页面即可。
- 缓存写入 tokens 没有公布单价，按缓存未命中单价计入（偏保守）。
- 余额读取失败或未登录时，芯片降级为只显示花费，不会消失；点击芯片可重试，面板内会说明原因。
- 本插件是纯显示层：不注册工具、不写会话日志、不消耗模型 token；会话树路由是只读 GET（同源、在 Host 认证围栏内），不落盘、不访问外部网络。`sessionCost` 单元的状态会进入会话投影缓存（`<DSH_HOME>/storages/session_projcache`），随会话一起持久化。

## 仓库结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单：`dsh.bundle.patch` 挂载行、`dsh.client` 客户端半、显示元数据与图标 |
| `cordis.patch.yml` | bundle 补丁：插入 `session-cost` 行 |
| `index.js` | Host 半：注册 `sessionCost` 会话投影单元（按事件时间把用量折进高峰 / 空闲桶，镜像官方 `tokenUsage` 口径），并注册 `/api/plugin/session-cost` 只读路由 |
| `host/tree.js` | Host 半的会话树查询：用 `sessionQuery` 观察本会话与全部子代理会话，按 `sessionCost` 投影汇总（`subagents` 服务优先、`subagentCatalog` 投影兜底，≤40 个会话） |
| `client.js` | 客户端半：`conversation.composer.dock` 注册、分时段计价、会话树合计与费用构成、余额读取、锚定面板、样式与字典 |
| `locale/{zh,en}.json` | 插件列表里的标题 / 描述 |
| `icon.svg` | 插件图标 |
| `check.mjs` | 逻辑自检，`node check.mjs`（或 `npm run check`），需要 Node ≥ 18 |

## 验证

- `node check.mjs`：**64 项全通过**。
  - Host 半（23 项）：投影单元注册契约、空日志初值、峰值/空闲入桶、时段边界（09:00 / 12:00 / 14:00 / 18:00、周末）、重试与同 step 替换、`assistant/attempt` 流内用量、两桶之和恒等于官方 `tokenUsage` 总量、状态与 wire schema 的接受/拒绝、清空重试槽不产生新 wire 值、wire 值为纯 JSON；**会话树路由**（路由注册/卸载、`sessionId` 校验、`sessionQuery` + `subagents.listDescendants` 路径、`subagentCatalog` 递归兜底、40 会话上限与 `truncated`、不可读子会话跳过、观测对象释放、405/400/200/500 错误映射、无 connection 的降级组合）。
  - Client 半（41 项）：分时段计价与金额、**时钟跨边界不改变显示金额**（本次修复的回归项）、无分时段数据时的 `≈` 估算与说明、模型价格行回退、赠金合计、面板分节内容（标题 / 各行 / 小计 / 余额分节）、开合交互（点击 / 悬浮 / 再点 / `Esc` / 外部点击）、余额失败/未登录/无账户命名空间降级、挂载即读取余额、**乱序返回的旧余额响应不会回退显示**（最新请求优先）、样式表注入与卸载；**会话树与费用构成**（树合计替换芯片金额、`主会话` + `子代理会话（N 个）` + 每个子代理一行 + `合计` 的可加总拆分、子代理标签 18 字截断与完整 `title`、无标签时回退 id、英文文案、20s 刷新与旧响应丢弃、卸载中止请求、fetch 缺失/失败/非 2xx/`ok:false` 时静默退回仅本会话口径、面板顺序 top → 费用构成 → 时段分节 → 余额）。
- 运行时（本机实测，2026-10-25 **会话树**）：触发一次 HMR 重载后 `GET /api/plugin/session-cost?sessionId=<本会话>` 返回 HTTP 200，`value.root` + 3 个 `children`（`mode` / `depth` / `activity` / `model` / `split` 均正确）；同一时刻的树合计 = 本会话 **¥1.56715424** + 子代理会话 **¥0.59409520 / ¥0.65312704 / ¥0.81434604** = **¥3.62872252**，与用户观察到的当日账户消费 ~¥3.61 一致（采样时刻相差几十秒），其余零头来自平台 1–2 分钟结算批次与标题生成等未写入会话 token 的请求。这也解释了「今天只用了当前会话」的直觉：GUI 只展示根会话，而 Agent Team 的队友是 `parentSession` 指向本会话的隐藏子会话，各自独立计费 —— v1.2 把它们并入「本次会话花费」。
- 面板「费用构成」实测（用户 2026-10-25 截图）：本次会话花费 **¥6.47 = 主会话 ¥2.79 + 子代理会话（3 个）¥3.68**（面板里每个子代理会话各一行，可逐项相加）。
- 与**真实平台账单**对账（本机，2026-10 数据，见下）——证明插件计价口径与官方扣费一致，同时复现了「余额掉 3 块但芯片只显示 1 块」的真正原因：
  - 高峰 ×2：2026-10-23（周五）16:00–17:00（北京时间）平台账单 tokens 为缓存命中 7,446,144 / 缓存未命中 120,756 / 输出 238,038，按高峰价（0.04 / 2 / 8 元每百万）算得 **¥2.44366176**，与账单 Paid + Granted 两笔之和分毫不差；17:00–18:00 同样精确等于 **¥5.61758328**。
  - 周末空闲：2026-10-24（周六）09:00–10:00 命中 18,880,512 / 未命中 19,007 / 输出 65,091，按空闲价算得 **¥0.65698124**，与账单一致（周末全天不计高峰，与官方文档一致）。
  - 复现用户现象：2026-10-24 19:00–20:00 账户实际扣费 **¥4.22746892**（DSH App-managed key）；同一时段 `session-b1e2be43`（社会奖学金会话，19:06–19:49）自己的芯片金额为 **¥0.9897 ≈ ¥1**，但当时还有 lead 会话 `session-fa719047` 与子代理 `a62da1b5`、`fbb09d84` 以及 19:38 起跑的 miyun 团队在同时计费，所以余额在这段时间掉了约 3–4 元 —— 芯片显示的是「本会话」，余额减少的是「整个账户」。其中同一会话树的子代理已由 v1.2 并入「本次会话花费」；不属于本会话树的并发会话/工具仍不在芯片内，对照余额时需注意。
  - 同一账户还被其他工具/API key 使用（如 `OpenDesign`、普通 `dsh` key），也会造成余额下降而本会话芯片不动。
- 运行时（本机实测）：会话投影缓存 `<DSH_HOME>/storages/session_projcache/sessions/session-<本会话>.json` 中出现 `"sessionCost": {"ver":1,"seq":…,"val":{"peak":…,"off":…,"last":…}}`，且 `peak + off` 与同一文件里 `"tokenUsage"` 的 totals **逐字段相等**（本会话周六进行，全部落在 `off` 桶，`peak` 为 0）——证明 Host 半已热载并正确折叠。
- `Slots.listSubTree` 显示 `conversation.composer.dock` 占用者含 `{ id: "session-cost", order: 50, active: true }`；`Config.listConfigs` 含 `include:session-cost`。
- 未做视觉快照验证（开发环境无浏览器控制能力），观感需在真实页面上确认。
