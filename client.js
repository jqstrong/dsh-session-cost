/**
 * Client half of `@local/dsh-session-cost`.
 *
 * One chip in `conversation.composer.dock` — the ambient row directly below the
 * composer card — showing what this session has cost so far and how much
 * balance the signed-in DeepSeek account has left. Hovering or clicking the
 * chip opens a trigger-anchored details panel in the same visual language as
 * the shipped token-stat dialogs (menu surface, elevated stroke, 12/18 type,
 * label/value grid).
 *
 * Data sources
 * - Session spend: the session's `tokenUsage` projection (four disjoint
 *   provider-reported buckets) priced through the table below.
 * - Active model: the session's `modelSelection` projection, so the price row
 *   follows the model the next request will use.
 * - Remaining balance: `ctx.remote.account.getBalance`, the same Host Remote
 *   the Settings → Account page reads. A failed or signed-out read degrades to
 *   the spend figure alone; it never removes the chip.
 *
 * No Harness Client package is imported: React and react-dom come from the
 * page's module table, the icons are inline SVG, and every style reads theme
 * tokens only.
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-session-cost',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace whose dictionaries carry every visible string. */
		const NS = 'session-cost';
		/** Identity the account Remote carries for this UI. */
		const CLIENT_VERSION = '1.0.0';
		/** Currency assumed when the account reports no wallet. */
		const DEFAULT_CURRENCY = 'CNY';
		/** Balance re-read cadence, and the shortest gap between two reads. */
		const BALANCE_REFRESH_MS = 60000;
		const BALANCE_MIN_GAP_MS = 10000;
		/** Hover opens the panel after this dwell; leaving closes it after this grace period. */
		const HOVER_OPEN_MS = 260;
		const HOVER_CLOSE_MS = 200;
		/** Panel placement: gap to the trigger, and the viewport margin it is clamped to. */
		const PANEL_GAP = 8;
		const PANEL_MARGIN = 12;

		/**
		 * `'auto'` follows the published peak/off-peak clock (peak = 2x off-peak);
		 * `'peak'` and `'idle'` pin one rate for the whole session total.
		 */
		const PRICING_MODE = 'auto';
		const PEAK_MULTIPLIER = 2;

		/**
		 * Unit prices per 1,000,000 tokens, OFF-PEAK, keyed by currency and model
		 * id; `default` prices any model the table does not name. Edit the rows
		 * here and reload to follow a price change.
		 *
		 * Official rates, off-peak (peak hours are twice these):
		 *   CNY — deepseek-flash:   hit 0.02  miss 1    out 4
		 *         deepseek-v4-pro:  hit 0.15  miss 4.5  out 13.5
		 *   USD — deepseek-flash:   hit 0.003 miss 0.15 out 0.6
		 *         deepseek-v4-pro:  hit 0.022 miss 0.66 out 1.98
		 * See https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
		 */
		const PRICES = {
			CNY: {
				'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
				'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
				'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
				default: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
			},
			USD: {
				'deepseek-flash': { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
				'deepseek-v4-pro': { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
				'deepseek-v4-flash': { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
				default: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
			},
		};

		/** Empty provider-reported usage. */
		const NO_USAGE = {
			uncachedInputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
		};

		const zh = {
			chip: '花费 {spend} · 余额 {balance}',
			chipNoBalance: '花费 {spend} · 余额不可用',
			chipLoading: '花费 {spend} · 余额读取中…',
			chipSignedOut: '花费 {spend} · 未登录账号',
			panelTitle: '本次会话花费',
			rowModel: '计价模型',
			rowModelDefault: '默认模型',
			rowPeriod: '计价时段',
			rowMiss: '输入 · 缓存未命中',
			rowHit: '输入 · 缓存命中',
			rowWrite: '输入 · 缓存写入',
			rowOut: '输出',
			rowTopUp: '充值余额',
			rowBonus: '赠金余额',
			rowAvailable: '可用合计',
			periodValue: '{period}（高峰 ×{factor}）',
			periodPeak: '高峰时段',
			periodIdle: '空闲时段',
			balanceLoading: '正在读取账户余额…',
			balanceUnavailable: '账户余额不可用',
			balanceSignedOut: '未登录 DeepSeek 账号，无法读取余额',
			balanceFailed: '余额读取失败，点击芯片可重试',
			footer: '按当前时段单价估算，仅供参考',
		};

		const en = {
			chip: 'Spent {spend} · Balance {balance}',
			chipNoBalance: 'Spent {spend} · Balance unavailable',
			chipLoading: 'Spent {spend} · reading balance…',
			chipSignedOut: 'Spent {spend} · not signed in',
			panelTitle: 'This session cost',
			rowModel: 'Model',
			rowModelDefault: 'default',
			rowPeriod: 'Rate period',
			rowMiss: 'Input · cache miss',
			rowHit: 'Input · cache hit',
			rowWrite: 'Input · cache write',
			rowOut: 'Output',
			rowTopUp: 'Topped up',
			rowBonus: 'Granted',
			rowAvailable: 'Available',
			periodValue: '{period} (peak ×{factor})',
			periodPeak: 'peak',
			periodIdle: 'off-peak',
			balanceLoading: 'Reading the account balance…',
			balanceUnavailable: 'Account balance unavailable',
			balanceSignedOut: 'Not signed in to DeepSeek, so no balance is available',
			balanceFailed: 'Balance read failed — click the chip to retry',
			footer: 'Estimated at the current rate period',
		};

		const CSS = [
			/* Chip: the shipped dock pill's geometry, type and hover language. */
			'.dshSessionCost_chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;',
			'max-width:100%;padding:1px 8px;border:none;border-radius:999px;background:0 0;',
			'color:var(--dsw-alias-label-tertiary);font:inherit;',
			'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
			'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
			'font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;',
			/* Sit after the shipped stats pills and the context ring, at the end of the row. */
			'order:1}',
			'.dshSessionCost_chip:hover,.dshSessionCost_chip[aria-expanded=true]{',
			'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.dshSessionCost_chip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.dshSessionCost_chip svg{flex:none;width:14px;height:14px}',
			'.dshSessionCost_label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
			/* Panel: the shipped stat-dialog surface, geometry and type scale. */
			'.dshSessionCost_panel{z-index:1100;box-sizing:border-box;position:fixed;',
			'width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);',
			'border:0;border-radius:var(--dsw-radius-lg);padding:16px;',
			'background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);',
			'--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);',
			'color:var(--dsw-alias-label-secondary);cursor:default;font-size:12px;line-height:18px}',
			'.dshSessionCost_panelTitle{display:flex;justify-content:space-between;gap:16px;',
			'margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}',
			'.dshSessionCost_panelTitleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}',
			'.dshSessionCost_panelTitleLabel svg{flex:none;width:14px;height:14px}',
			'.dshSessionCost_panelTitleValue{font-variant-numeric:tabular-nums}',
			'.dshSessionCost_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
			'.dshSessionCost_panelSection{border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}',
			'.dshSessionCost_details{display:grid;grid-template-columns:minmax(96px,auto) minmax(0,1fr);',
			'gap:6px 16px;margin:0;color:var(--dsw-alias-label-tertiary)}',
			'.dshSessionCost_details dt,.dshSessionCost_details dd{min-width:0;margin:0}',
			'.dshSessionCost_details dd{color:var(--dsw-alias-label-secondary);',
			'font-variant-numeric:tabular-nums;text-align:right}',
			'.dshSessionCost_details dd em{font-style:normal;color:var(--dsw-alias-label-tertiary);margin-right:6px}',
			'.dshSessionCost_details .dshSessionCost_available{color:var(--dsw-alias-label-primary);font-weight:500}',
			'.dshSessionCost_note{color:var(--dsw-alias-label-tertiary)}',
			'.dshSessionCost_footer{display:flex;justify-content:space-between;gap:12px;',
			'margin-top:2px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);',
			'color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;line-height:16px}',
			'@media (width<=480px){.dshSessionCost_footer{display:block}}',
		].join('');

		/** Group digits without depending on the page locale. */
		function group(value) {
			return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
		}

		/** Symbol for one wallet currency. */
		function symbolOf(currency) {
			return currency === 'USD' ? '$' : '¥';
		}

		/** One money string under a sub-unit precision floor. */
		function amountText(value, currency, subUnitFloor) {
			const amount = Number.isFinite(value) ? value : 0;
			const abs = Math.abs(amount);
			const digits = abs > 0 && abs < subUnitFloor ? 4 : 2;
			return `${symbolOf(currency)}${amount.toFixed(digits)}`;
		}

		/** Spend text: four decimals below one unit, two above. */
		function money(value, currency) {
			return amountText(value, currency, 1);
		}

		/** Balance text, mirroring the platform's two-decimal and sub-cent rule. */
		function balanceMoney(value, currency) {
			return amountText(value, currency, 0.01);
		}

		/** Money text at an explicit precision, so one column of figures lines up. */
		function detailMoney(value, currency, digits) {
			const amount = Number.isFinite(value) ? value : 0;
			return `${symbolOf(currency)}${amount.toFixed(digits)}`;
		}

		/**
		 * Whether the published peak window covers the given instant: Beijing
		 * time, Monday to Friday, 09:00-12:00 and 14:00-18:00. Chinese public
		 * holidays are not modelled, so a holiday reads as a peak window.
		 * @param now - epoch milliseconds.
		 * @returns true inside a peak window.
		 */
		function isPeakBeijing(now) {
			const beijing = new Date(now + 8 * 3600 * 1000);
			const weekday = beijing.getUTCDay();
			if (weekday === 0 || weekday === 6) return false;
			const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
			return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
		}

		/** The off-peak row for one currency and model id, with `default` as the fallback. */
		function priceRow(currency, model) {
			const table = PRICES[currency] ?? PRICES[DEFAULT_CURRENCY];
			return table[model] ?? table.default;
		}

		/** The row above scaled by the rate period in effect. */
		function effectivePrice(currency, model, now) {
			const base = priceRow(currency, model);
			const peak = PRICING_MODE === 'peak'
				|| (PRICING_MODE === 'auto' && isPeakBeijing(now));
			const factor = peak ? PEAK_MULTIPLIER : 1;
			return {
				cacheHit: base.cacheHit * factor,
				cacheMiss: base.cacheMiss * factor,
				output: base.output * factor,
				peak,
			};
		}

		/**
		 * Spend of one usage total under one price row.
		 *
		 * Cache-write tokens have no published rate of their own and are charged
		 * at the cache-miss rate, which is the conservative reading.
		 * @param usage - the session's `tokenUsage` projection value.
		 * @param price - the row in effect.
		 * @returns money in the wallet's currency.
		 */
		function spendOf(usage, price) {
			const miss = usage.uncachedInputTokens + usage.cacheWriteTokens;
			return (miss * price.cacheMiss
				+ usage.cacheReadTokens * price.cacheHit
				+ usage.outputTokens * price.output) / 1e6;
		}

		/** The topped-up wallets the account reported. */
		function walletsOf(balance) {
			return balance.status === 'ready' ? balance.wallets : [];
		}

		/**
		 * Remaining money per currency: topped-up plus granted, because platform
		 * deductions spend the granted balance first and both are still spendable.
		 * @param balance - the resolved balance state.
		 * @returns one row per currency carrying its top-up and granted parts.
		 */
		function availableTotals(balance) {
			const rows = new Map();
			const add = (wallet, granted) => {
				const amount = Number(wallet.balance);
				const row = rows.get(wallet.currency) ?? { currency: wallet.currency, topUp: 0, granted: 0 };
				if (granted) row.granted += Number.isFinite(amount) ? amount : 0;
				else row.topUp += Number.isFinite(amount) ? amount : 0;
				rows.set(wallet.currency, row);
			};
			for (const wallet of walletsOf(balance)) add(wallet, false);
			for (const wallet of balance.status === 'ready' ? balance.bonusWallets : []) add(wallet, true);
			return [...rows.values()].map((row) => ({ ...row, total: row.topUp + row.granted }));
		}

		/** Local fallback translator, used only when the locale seat is absent. */
		function fallbackTranslate(key, params) {
			const template = zh[key] ?? key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
		}

		/** The wallet icon, sized by the caller's CSS. */
		function walletIcon() {
			return h(
				'svg',
				{ viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
				h('path', {
					fill: 'currentColor',
					d: 'M2.5 4.5A1.5 1.5 0 0 1 4 3h7a1.5 1.5 0 0 1 1.5 1.5v.5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 13H4a1.5 1.5 0 0 1-1.5-1.5v-7Zm1.2 2.1a.6.6 0 0 0 0 1.2h8.6a.6.6 0 0 0 0-1.2H3.7Zm8.1 2.6a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z',
				}),
			);
		}

		/** Unplaced portal panel: hidden but laid out, so the first measure is real. */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

		/**
		 * Trigger-anchored placement for a portaled panel: preferred above the
		 * trigger, flipped below when the viewport has no room, always clamped to
		 * a margin. Re-measures on every render while open, so late content (a
		 * balance arriving, a label wrapping) never leaves it misplaced.
		 * @param open - whether the panel is mounted.
		 * @returns the trigger ref, the panel ref, and the placement to spread onto it.
		 */
		function useAnchoredPanel(open) {
			const anchorRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const [pos, setPos] = React.useState(null);
			const place = React.useCallback(() => {
				const anchor = anchorRef.current;
				const panel = panelRef.current;
				if (anchor === null || panel === null || typeof anchor.getBoundingClientRect !== 'function') return;
				const trigger = anchor.getBoundingClientRect();
				const box = panel.getBoundingClientRect();
				const viewportWidth = window.innerWidth;
				const viewportHeight = window.innerHeight;
				let top = trigger.top - PANEL_GAP - box.height;
				if (top < PANEL_MARGIN) {
					const below = trigger.bottom + PANEL_GAP;
					top = below + box.height + PANEL_MARGIN <= viewportHeight
						? below
						: Math.max(PANEL_MARGIN, viewportHeight - box.height - PANEL_MARGIN);
				}
				const maxLeft = Math.max(PANEL_MARGIN, viewportWidth - PANEL_MARGIN - box.width);
				const left = Math.min(Math.max(PANEL_MARGIN, trigger.left + trigger.width / 2 - box.width / 2), maxLeft);
				setPos((current) => current !== null
					&& Math.abs(current.left - left) < 0.5
					&& Math.abs(current.top - top) < 0.5
					? current
					: { left, top });
			}, []);
			React.useLayoutEffect(() => {
				if (!open) {
					setPos(null);
					return undefined;
				}
				place();
				window.addEventListener('resize', place);
				window.addEventListener('scroll', place, true);
				return () => {
					window.removeEventListener('resize', place);
					window.removeEventListener('scroll', place, true);
				};
			}, [open, place]);
			React.useLayoutEffect(() => {
				if (open) place();
			});
			return { anchorRef, panelRef, pos };
		}

		/** Build the chip component around one client plugin context. */
		function createChip(ctx) {
			/** Identity of the requesting UI, read at call time so it carries the live locale. */
			function clientMetadata() {
				let locale = 'en';
				try {
					locale = ctx.locale.getSnapshot().active;
				} catch (error) {
					locale = 'en';
				}
				return {
					version: CLIENT_VERSION,
					locale,
					timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
				};
			}

			/** Read the account balance, mapping every failure to a displayable state. */
			async function readBalance() {
				const account = ctx.remote?.account;
				if (account === undefined || typeof account.getBalance !== 'function') return { status: 'unavailable' };
				try {
					const result = await account.getBalance(clientMetadata());
					if (result === undefined || result === null || result.ok !== true) return { status: 'failed' };
					const value = result.value;
					if (value === undefined || value === null) return { status: 'signed-out' };
					if (value.status !== 'ready') return { status: 'failed' };
					return {
						status: 'ready',
						wallets: Array.isArray(value.value) ? value.value : [],
						bonusWallets: Array.isArray(value.bonusWallets) ? value.bonusWallets : [],
					};
				} catch (error) {
					return { status: 'failed' };
				}
			}

			return function SessionCostChip({ useProjection, t }) {
				const tr = typeof t === 'function' ? t : fallbackTranslate;
				const usage = useProjection('tokenUsage');
				const selection = useProjection('modelSelection');
				const [balance, setBalance] = React.useState({ status: 'loading' });
				const [pinned, setPinned] = React.useState(false);
				const [hovered, setHovered] = React.useState(false);
				const alive = React.useRef(true);
				const lastRead = React.useRef(0);
				const timers = React.useRef([]);
				const open = pinned || hovered;
				const { anchorRef, panelRef, pos } = useAnchoredPanel(open);

				const close = React.useCallback(() => {
					setPinned(false);
					setHovered(false);
				}, []);

				const refresh = React.useCallback((force) => {
					const now = Date.now();
					if (!force && now - lastRead.current < BALANCE_MIN_GAP_MS) return;
					lastRead.current = now;
					readBalance().then(
						(next) => {
							if (alive.current) setBalance(next);
						},
						() => {},
					);
				}, []);

				const cancelPending = React.useCallback(() => {
					for (const timer of timers.current) window.clearTimeout(timer);
					timers.current = [];
				}, []);
				const later = React.useCallback((callback, delay) => {
					const timer = window.setTimeout(() => {
						timers.current = timers.current.filter((entry) => entry !== timer);
						callback();
					}, delay);
					timers.current.push(timer);
				}, []);

				React.useEffect(() => {
					alive.current = true;
					refresh(true);
					const id = window.setInterval(() => {
						refresh(true);
					}, BALANCE_REFRESH_MS);
					return () => {
						alive.current = false;
						window.clearInterval(id);
						cancelPending();
					};
				}, [refresh, cancelPending]);

				/* A new settlement moves the balance too, but the read is rate-limited. */
				const usageKey = usage === undefined
					? ''
					: [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens].join(':');
				React.useEffect(() => {
					if (usageKey !== '') refresh(false);
				}, [usageKey, refresh]);

				/* Outside pointer or Escape closes both the hover preview and the pinned panel. */
				React.useEffect(() => {
					if (!open) return undefined;
					const onKeyDown = (event) => {
						if (event.key === 'Escape') close();
					};
					const onPointerDown = (event) => {
						if (anchorRef.current?.contains(event.target) === true) return;
						if (panelRef.current?.contains(event.target) === true) return;
						close();
					};
					document.addEventListener('keydown', onKeyDown);
					document.addEventListener('pointerdown', onPointerDown, true);
					return () => {
						document.removeEventListener('keydown', onKeyDown);
						document.removeEventListener('pointerdown', onPointerDown, true);
					};
				}, [open, close, anchorRef, panelRef]);

				const onChipEnter = () => {
					cancelPending();
					later(() => setHovered(true), HOVER_OPEN_MS);
				};
				const onChipLeave = () => {
					cancelPending();
					later(() => setHovered(false), HOVER_CLOSE_MS);
				};

				const totals = { ...NO_USAGE, ...(usage ?? {}) };
				const model = selection?.next?.model ?? selection?.lastUsed?.model ?? undefined;
				const now = Date.now();
				const wallets = walletsOf(balance);
				const available = availableTotals(balance);
				const currency = available[0]?.currency ?? wallets[0]?.currency ?? DEFAULT_CURRENCY;
				const price = effectivePrice(currency, model, now);
				const spend = spendOf(totals, price);
				const spendText = money(spend, currency);
				const balanceText = available.length > 0
					? available.map((row) => balanceMoney(row.total, row.currency)).join(' + ')
					: null;

				let label;
				if (balanceText !== null) label = tr('chip', { spend: spendText, balance: balanceText });
				else if (balance.status === 'loading') label = tr('chipLoading', { spend: spendText });
				else if (balance.status === 'signed-out') label = tr('chipSignedOut', { spend: spendText });
				else label = tr('chipNoBalance', { spend: spendText });

				/** One label/value grid row. */
				const gridRow = (key, title, value, className) => [
					h('dt', { key: `${key}-t` }, title),
					h('dd', { key: `${key}-v`, className }, value),
				];
				/** One usage bucket: token count, then its priced share. */
				const bucketValue = (tokens, amount) => [
					h('em', { key: 'count' }, `${group(tokens)} tok`),
					amount,
				];
				/* One precision for the whole share column: sub-unit sessions keep four decimals. */
				const detailDigits = Math.abs(spend) > 0 && Math.abs(spend) < 1 ? 4 : 2;
				const share = (tokens, unitPrice) => detailMoney(tokens / 1e6 * unitPrice, currency, detailDigits);

				const sessionRows = [
					gridRow('model', tr('rowModel'), model ?? tr('rowModelDefault')),
					/* The peak multiple is only worth stating while an off-peak rate is in effect. */
					gridRow('period', tr('rowPeriod'), price.peak
						? tr('periodPeak')
						: tr('periodValue', { period: tr('periodIdle'), factor: PEAK_MULTIPLIER })),
					gridRow('miss', tr('rowMiss'), bucketValue(
						totals.uncachedInputTokens,
						share(totals.uncachedInputTokens, price.cacheMiss),
					)),
				];
				if (totals.cacheReadTokens > 0) {
					sessionRows.push(gridRow('hit', tr('rowHit'), bucketValue(
						totals.cacheReadTokens,
						share(totals.cacheReadTokens, price.cacheHit),
					)));
				}
				if (totals.cacheWriteTokens > 0) {
					sessionRows.push(gridRow('write', tr('rowWrite'), bucketValue(
						totals.cacheWriteTokens,
						share(totals.cacheWriteTokens, price.cacheMiss),
					)));
				}
				sessionRows.push(gridRow('out', tr('rowOut'), bucketValue(
					totals.outputTokens,
					share(totals.outputTokens, price.output),
				)));

				let balanceSection;
				if (balance.status === 'ready' && available.length > 0) {
					const rows = [];
					const topUp = available.filter((entry) => entry.topUp > 0);
					const granted = available.filter((entry) => entry.granted > 0);
					if (topUp.length > 0) {
						rows.push(gridRow('topup', tr('rowTopUp'), topUp.map((entry) => balanceMoney(entry.topUp, entry.currency)).join(' + ')));
					}
					if (granted.length > 0) {
						rows.push(gridRow('bonus', tr('rowBonus'), granted.map((entry) => balanceMoney(entry.granted, entry.currency)).join(' + ')));
					}
					rows.push(gridRow('available', tr('rowAvailable'), available.map((entry) => balanceMoney(entry.total, entry.currency)).join(' + '), 'dshSessionCost_available'));
					balanceSection = [
						h('div', { key: 'rule', className: 'dshSessionCost_panelSection', 'aria-hidden': true }),
						h('dl', { key: 'list', className: 'dshSessionCost_details' }, rows.flat()),
					];
				} else {
					const note = balance.status === 'loading'
						? tr('balanceLoading')
						: balance.status === 'signed-out'
							? tr('balanceSignedOut')
							: balance.status === 'failed' ? tr('balanceFailed') : tr('balanceUnavailable');
					balanceSection = [
						h('div', { key: 'rule', className: 'dshSessionCost_panelSection', 'aria-hidden': true }),
						h('div', { key: 'note', className: 'dshSessionCost_note' }, note),
					];
				}

				const panel = h(
					'div',
					{
						ref: panelRef,
						className: 'dshSessionCost_panel',
						role: 'dialog',
						'aria-label': tr('panelTitle'),
						style: pos ?? MEASURE_STYLE,
						onMouseEnter: cancelPending,
						onMouseLeave: onChipLeave,
					},
					h(
						'div',
						{ className: 'dshSessionCost_panelTitle' },
						h('span', { className: 'dshSessionCost_panelTitleLabel' }, walletIcon(), tr('panelTitle')),
						h('span', { className: 'dshSessionCost_panelTitleValue' }, spendText),
					),
					h('div', { className: 'dshSessionCost_rule', 'aria-hidden': true }),
					h('dl', { className: 'dshSessionCost_details' }, sessionRows.flat()),
					balanceSection,
					h('div', { className: 'dshSessionCost_footer' }, h('span', null, tr('footer'))),
				);

				return h(
					React.Fragment,
					null,
					h(
						'button',
						{
							ref: anchorRef,
							type: 'button',
							className: 'dshSessionCost_chip',
							'aria-haspopup': 'dialog',
							'aria-expanded': open,
							'aria-label': label,
							onClick: () => setPinned(!pinned),
							onMouseEnter: onChipEnter,
							onMouseLeave: onChipLeave,
						},
						walletIcon(),
						h('span', { className: 'dshSessionCost_label' }, label),
					),
					open ? ReactDOM.createPortal(panel, document.body) : null,
				);
			};
		}

		return {
			inject: ['slots', 'locale', 'remote', 'remote.account'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-cost: dictionaries');
				ctx.effect(() => {
					const tag = document.createElement('style');
					tag.dataset.plugin = '@local/dsh-session-cost';
					tag.dataset.pluginCss = NS;
					tag.textContent = CSS;
					document.head.appendChild(tag);
					return () => {
						tag.remove();
					};
				}, 'session-cost: stylesheet');
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'session-cost',
					order: 50,
					locale: NS,
				}, createChip(ctx)));
			},
		};
	},
});
