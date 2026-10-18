# dsh-session-cost · 会话花费与余额

DeepSeek Harness 的 UI 插件（bundle）：在对话框（composer）下方那一行的末尾加一个信息药丸，显示**本次会话已花多少钱**与**账户还剩多少钱**；悬浮或点击弹出明细面板。

注册位置：`conversation.composer.dock`（对话框卡片下方的环境条目行），与官方 Token 统计药丸、上下文占用环同排，排在行末（红框位置）。

## 显示内容

- **本次会话花费**：由本会话累计的 provider 用量（`tokenUsage` 投影：缓存未命中输入 / 缓存命中输入 / 缓存写入输入 / 输出）按模型单价计算。
- **剩余金额**：来自账户 Remote（`ctx.remote.account.getBalance`），与「设置 → 账户」页同一数据源。芯片显示**充值余额 + 赠金余额**的合计（平台扣费优先扣赠金，两者都可用），面板里再分别列出。

**悬浮 260ms 或点击芯片**会打开一个锚定在芯片上方（下方空间不足时自动翻转、并始终限制在视口内）的明细面板，样式沿用官方 `stat-dialog` 的设计语言（菜单表面 + 毛玻璃 + 描边阴影 + 12/18 字号 + 标签值网格），深浅色主题自动跟随：

```
[icon] 本次会话花费                    ¥1.63
────────────────────────────────────────────
计价模型            deepseek-flash
计价时段            空闲时段（高峰 ×2）
输入 · 缓存未命中    1,234,567 tok   ¥1.23
输入 · 缓存命中      10,000,000 tok  ¥0.20
输出                100,000 tok      ¥0.40
────────────────────────────────────────────
充值余额            ¥12.34
赠金余额            ¥3.00
可用合计            ¥15.34
────────────────────────────────────────────
按当前时段单价估算，仅供参考
```

交互：悬浮预览、移开 200ms 后关闭（鼠标可移入面板查看，不会闪断）；点击固定打开，再次点击 / 点击外部 / `Esc` 关闭；打开时芯片高亮，`aria-expanded` 同步。

## 安装（当前设备）

已安装到 `desktop` profile（`plugin_manager` 的 `install_bundle`，`application: applied`），以 `link:` 方式链接到本仓库目录：

```
+ @local/dsh-session-cost link:<本仓库克隆目录>
```

因此克隆目录就是运行中的插件目录：改 `client.js` 后由客户端 HMR 热更（或刷新页面）即刻生效，不必重装。**不要移动或删除该目录**，否则插件失效。

移除：`plugin_manager({ action: "remove_bundle", target: "@local/dsh-session-cost" })`。

## 在另一台设备上复用

前置条件：

- 已安装 DeepSeek Harness（开发验证于 `0.2.0-rc.2`，Desktop / Web 均可用）；
- profile 中带有账户能力（`@deepseek-ai/dsh-deepseek-account-platform` + `@deepseek-ai/dsh-api-account-controller`，桌面版默认带），并登录同一 DeepSeek 账号；否则芯片只显示花费，余额处显示「余额不可用」。

**方式 A：从 GitHub 直接安装（无需手动 clone）**

```
plugin_manager({ action: "install_bundle", target: "https://github.com/jqstrong/dsh-session-cost.git" })
```

**方式 B：先 clone 再按本地目录安装（推荐，便于改价格表后热更）**

```bash
git clone https://github.com/jqstrong/dsh-session-cost.git
```

```
plugin_manager({ action: "install_bundle", target: "<clone 目录的绝对路径>" })
```

装完立即生效（返回 `application: applied`）；若页面未刷新，手动刷新一次。`package.json` 里的 `private: true` 只阻止误发布到 npm，不影响 git 安装。

## 价格表与行为

`client.js` 顶部的常量是唯一配置面，改完保存并在页面刷新即可（`link:` 安装时无需重装）：

| 常量 | 含义 |
| --- | --- |
| `PRICES` | 每百万 tokens 的**空闲时段**单价：`{ 币种: { 模型: { cacheHit, cacheMiss, output } } }` |
| `PRICING_MODE` | `'auto'`（按北京时间判断高峰/空闲，默认）/ `'peak'` / `'idle'` |
| `PEAK_MULTIPLIER` | 高峰相对空闲的倍数（官方为 2） |
| `BALANCE_REFRESH_MS` | 余额自动刷新间隔（默认 60s） |
| `HOVER_OPEN_MS` / `HOVER_CLOSE_MS` | 悬浮打开 / 关闭延迟 |
| `PANEL_GAP` / `PANEL_MARGIN` | 面板与芯片的间距 / 距视口边缘的最小距离 |

出厂价格（每百万 tokens，空闲时段；高峰 ×2）：

| 币种 | 模型 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| CNY | `deepseek-flash` | 0.02 | 1 | 4 |
| CNY | `deepseek-v4-pro` | 0.15 | 4.5 | 13.5 |
| USD | `deepseek-flash` | 0.003 | 0.15 | 0.6 |
| USD | `deepseek-v4-pro` | 0.022 | 0.66 | 1.98 |

来源：[DeepSeek 官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。高峰时段为北京时间周一至周五（不含中国法定节假日）09:00–12:00 与 14:00–18:00，其余为空闲。表里没有的模型回退到 `default` 行。

## 已知取舍

- 会话花费是**近似值**：按当前时段单价对整个会话累计用量计价，跨高峰/空闲的会话不会逐请求分别计价；中国法定节假日未建模（节假日会按高峰计价，偏高）。
- 缓存写入 tokens 没有公布单价，按缓存未命中单价计入（偏保守）。
- 余额读取失败或未登录时，芯片降级为只显示花费，不会消失；点击芯片可重试，面板内会说明原因。
- 本插件是纯显示层：不注册工具、不写会话日志、不消耗模型 token。

## 仓库结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单：`dsh.bundle.patch` 挂载行、`dsh.client` 客户端半、显示元数据与图标 |
| `cordis.patch.yml` | bundle 补丁：插入 `session-cost` 行 |
| `index.js` | Host 半：仅 `export function apply() {}`，渲染全在客户端 |
| `client.js` | 客户端半：`conversation.composer.dock` 注册、花费计算、余额读取、锚定面板、样式与字典 |
| `locale/{zh,en}.json` | 插件列表里的标题 / 描述 |
| `icon.svg` | 插件图标 |
| `check.mjs` | 逻辑自检，`node check.mjs`（或 `npm run check`），需要 Node ≥ 18 |

## 验证

- `node check.mjs`：23 项全通过 —— 空闲/高峰单价、v4-pro 与未知模型回退、金额舍入、赠金合计、面板开合（点击 / 悬浮 / 再次点击 / `Esc`）、面板网格内容、失败 / 未登录 / 无账户命名空间降级、挂载即读取余额并落到状态、样式表注入与卸载。该自检在 Node VM 里用最小 React / react-dom 桩与记录监听器的 DOM 桩驱动真实交互路径，但**不渲染 CSS**。
- 运行时：`Slots.listSubTree` 显示 `conversation.composer.dock` 占用者含 `{ id: "session-cost", order: 50, active: true }`；`Config.listConfigs` 含 `include:session-cost`。
- 未做视觉快照验证（开发环境无浏览器控制能力），观感需在真实页面上确认。
