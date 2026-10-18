/**
 * Logic check for client.js — runs the real module in a Node VM with a minimal
 * React/react-dom stub and a listener-recording DOM stub, drives the chip
 * through its real interaction paths (mount, hover, click, Escape), and asserts
 * the chip text, the details panel's label/value grid, the mount→Remote→paint
 * round trip, and every degraded state.
 *
 * This is a numbers-and-branch check, NOT visual verification: it never applies
 * CSS and cannot show what the page looks like.
 *
 * Run: node check.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------------ stubs */

function fakeDate(nowMs) {
	return class FakeDate extends Date {
		constructor(...args) {
			if (args.length === 0) super(nowMs);
			else super(...args);
		}
		static now() {
			return nowMs;
		}
	};
}

let slotIndex = 0;
const slots = [];
let effectsEnabled = false;
const cleanups = [];

const react = {
	Fragment: Symbol('Fragment'),
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => {
		const index = slotIndex;
		slotIndex += 1;
		if (!(index in slots)) slots[index] = typeof init === 'function' ? init() : init;
		return [slots[index], (next) => {
			slots[index] = typeof next === 'function' ? next(slots[index]) : next;
		}];
	},
	useRef: (init) => ({ current: init }),
	useCallback: (fn) => fn,
	useEffect: (fn) => {
		if (!effectsEnabled) return;
		const cleanup = fn();
		if (typeof cleanup === 'function') cleanups.push(cleanup);
	},
	useLayoutEffect: (fn) => {
		if (!effectsEnabled) return;
		const cleanup = fn();
		if (typeof cleanup === 'function') cleanups.push(cleanup);
	},
};
const reactDom = { createPortal: (element) => element };

const documentListeners = [];
const styleTags = [];
const documentStub = {
	body: {},
	head: {
		appendChild: (tag) => {
			styleTags.push(tag);
		},
	},
	createElement: () => {
		const tag = {
			dataset: {},
			textContent: '',
			removed: false,
			remove() {
				tag.removed = true;
			},
		};
		return tag;
	},
	addEventListener: (type, listener) => documentListeners.push([type, listener]),
	removeEventListener: (type, listener) => {
		const index = documentListeners.findIndex(([kind, entry]) => kind === type && entry === listener);
		if (index >= 0) documentListeners.splice(index, 1);
	},
};

let registration;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (value) => {
				registration = value;
			},
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (id) => clearTimeout(id),
		addEventListener: () => {},
		removeEventListener: () => {},
		innerWidth: 1440,
		innerHeight: 900,
	},
	document: documentStub,
	console,
	Date: fakeDate(Date.now()),
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout,
	clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

/* --------------------------------------------------------------- wiring */

assert.ok(registration !== undefined, 'module registered a factory');
assert.equal(registration.id, '@local/dsh-session-cost', 'factory id matches the package name');

const captured = {};
const effectCleanups = [];
const account = {
	balance: { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] } },
	calls: 0,
	async getBalance() {
		this.calls += 1;
		return this.balance;
	},
};
const makeCtx = (remote) => ({
	locale: {
		register: (ns, dicts) => {
			captured.ns = ns;
			captured.dicts = dicts;
			return () => {};
		},
		getSnapshot: () => ({ active: 'zh' }),
	},
	effect: (fn, label) => {
		const cleanup = fn();
		if (typeof cleanup === 'function') effectCleanups.push({ label, cleanup });
		return () => {};
	},
	slots: {
		inject: (key, callback) => {
			captured.slotKey = key;
			return callback();
		},
		register: (options, component) => {
			captured.options = options;
			captured.component = component;
			return () => {};
		},
	},
	remote,
});

const plugin = registration.factory((spec) => {
	if (spec === 'react') return react;
	if (spec === 'react-dom') return reactDom;
	assert.fail(`unexpected import: ${spec}`);
});
assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'remote.account'], 'declared injects');
plugin.apply(makeCtx({ account }));

assert.equal(captured.slotKey, 'conversation.composer.dock', 'registers into the composer dock');
assert.equal(captured.options.id, 'session-cost', 'fresh dock entry id');
assert.equal(captured.options.order, 50, 'ordered after the shipped stats entry');
assert.equal(captured.options.locale, 'session-cost', 'declares its locale namespace');
assert.ok(captured.dicts.en !== undefined && captured.dicts.zh !== undefined, 'both dictionaries registered');

/** Translate exactly like the locale service does. */
function translate(locale) {
	const dict = captured.dicts[locale];
	return (key, params) => {
		const template = dict[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
	};
}

const OFF_PEAK = Date.parse('2026-10-11T20:36:00+08:00'); // Sunday 20:36 Beijing
const PEAK = Date.parse('2026-10-12T10:00:00+08:00'); // Monday 10:00 Beijing

const USAGE = { uncachedInputTokens: 1_000_000, cacheReadTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 100_000 };
const READY = { status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] };

/** Component props for one render; `null` selects the absent projection value. */
function props({ usage = USAGE, model = 'deepseek-flash', locale = 'zh', now = OFF_PEAK } = {}) {
	sandbox.Date = fakeDate(now);
	return {
		useProjection: (key) => (key === 'tokenUsage'
			? usage ?? undefined
			: { lastUsed: model === null ? null : { provider: 'deepseek-account', model }, next: null }),
		t: translate(locale),
	};
}

/** First mount with a given balance state; later renders keep the component's own state. */
function mount(balanceState, options) {
	slots.length = 0;
	slotIndex = 0;
	slots[0] = balanceState;
	return render(options);
}

/** Re-render the same component instance. */
function render(options) {
	slotIndex = 0;
	return captured.component(props(options));
}

/** Render any component instance, restarting the hook cursor. */
function renderWith(component, options) {
	slotIndex = 0;
	return component(props(options));
}

/** Concatenate an element subtree's text. */
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ');
	return (node.children ?? []).map(textOf).filter(Boolean).join(' ');
}

/** First node matching a predicate. */
function find(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = find(child, predicate);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (predicate(node)) return node;
	for (const child of node.children ?? []) {
		const hit = find(child, predicate);
		if (hit !== null) return hit;
	}
	return null;
}

const chipOf = (tree) => find(tree, (node) => node.props?.className === 'dshSessionCost_chip');
const labelOf = (tree) => textOf(find(tree, (node) => node.props?.className === 'dshSessionCost_label'));
const panelOf = (tree) => find(tree, (node) => node.props?.role === 'dialog');

/** Label/value pairs of every details grid inside a panel. */
function pairsOf(panel) {
	const pairs = [];
	const visit = (node) => {
		if (node === null || node === undefined || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (node.type === 'dl') {
			let title = null;
			for (const child of (node.children ?? []).flat()) {
				if (child === null || typeof child !== 'object') continue;
				if (child.type === 'dt') title = textOf(child);
				if (child.type === 'dd') pairs.push([title, textOf(child)]);
			}
			return;
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(panel);
	return pairs;
}

const pairValue = (pairs, title) => pairs.find(([name]) => name === title)?.[1];

const results = [];
function report(name, error) {
	results.push(`FAIL  ${name}\n      ${error.message.split('\n').slice(0, 6).join('\n      ')}`);
	process.exitCode = 1;
}
function check(name, fn) {
	try {
		fn();
		results.push(`PASS  ${name}`);
	} catch (error) {
		report(name, error);
	}
}

/** Async twin of {@link check}. */
async function checkAsync(name, fn) {
	try {
		await fn();
		results.push(`PASS  ${name}`);
	} catch (error) {
		report(name, error);
	}
}

/* ------------------------------------------------------------- chip text */

check('off-peak flash spend = ¥1.60 and wallet balance in one chip', () => {
	assert.equal(labelOf(mount(READY)), '花费 ¥1.60 · 余额 ¥12.34');
});

check('peak-hour pricing doubles the spend', () => {
	assert.equal(labelOf(mount(READY, { now: PEAK })), '花费 ¥3.20 · 余额 ¥12.34');
});

check('deepseek-v4-pro uses its own price row', () => {
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	assert.equal(labelOf(mount(READY, { usage, model: 'deepseek-v4-pro' })), '花费 ¥4.50 · 余额 ¥12.34');
});

check('unknown model falls back to the default row', () => {
	const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	assert.equal(labelOf(mount(READY, { usage, model: 'some-future-model' })), '花费 ¥1.00 · 余额 ¥12.34');
});

check('no usage yet still shows the balance', () => {
	assert.equal(labelOf(mount(READY, { usage: null, model: null })), '花费 ¥0.00 · 余额 ¥12.34');
});

check('double-digit spend keeps two decimals, sub-unit spend shows four', () => {
	const big = mount(READY, { usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3_000_000 } });
	assert.equal(labelOf(big), '花费 ¥12.00 · 余额 ¥12.34');
	const small = mount(READY, { usage: { uncachedInputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 0 } });
	assert.equal(labelOf(small), '花费 ¥0.0020 · 余额 ¥12.34');
});

check('a failed balance read degrades to spend only', () => {
	assert.equal(labelOf(mount({ status: 'failed' })), '花费 ¥1.60 · 余额不可用');
});

check('signed out and unavailable states are distinct', () => {
	assert.equal(labelOf(mount({ status: 'signed-out' })), '花费 ¥1.60 · 未登录账号');
	assert.equal(labelOf(mount({ status: 'unavailable' })), '花费 ¥1.60 · 余额不可用');
});

check('granted balance is added to the remaining amount', () => {
	const tree = mount({
		status: 'ready',
		wallets: [{ currency: 'CNY', balance: '12.34' }, { currency: 'USD', balance: '1.5' }],
		bonusWallets: [{ currency: 'CNY', balance: '3' }],
	});
	assert.equal(labelOf(tree), '花费 ¥1.60 · 余额 ¥15.34 + $1.50');
});

check('a granted-only account still reports a remaining amount', () => {
	assert.equal(labelOf(mount({ status: 'ready', wallets: [], bonusWallets: [{ currency: 'CNY', balance: '0.5' }] })), '花费 ¥1.60 · 余额 ¥0.50');
});

check('english locale renders english text', () => {
	assert.equal(labelOf(mount(READY, { locale: 'en' })), 'Spent ¥1.60 · Balance ¥12.34');
});

/* ------------------------------------------------------------ the panel */

check('the panel is closed until the chip is used', () => {
	const tree = mount(READY);
	assert.equal(panelOf(tree), null);
	assert.equal(chipOf(tree).props['aria-expanded'], false);
	assert.equal(chipOf(tree).props['aria-haspopup'], 'dialog');
});

check('clicking the chip opens the breakdown panel', () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	const open = render();
	const panel = panelOf(open);
	assert.ok(panel !== null, 'panel rendered after the click');
	assert.equal(chipOf(open).props['aria-expanded'], true, 'the chip reports the expanded state');
	const titleValue = textOf(find(panel, (node) => node.props?.className === 'dshSessionCost_panelTitleValue'));
	assert.equal(titleValue, '¥1.60');
	const pairs = pairsOf(panel);
	assert.deepEqual(pairs.map(([title]) => title), ['计价模型', '计价时段', '输入 · 缓存未命中', '输入 · 缓存命中', '输出', '充值余额', '可用合计']);
	assert.equal(pairValue(pairs, '计价模型'), 'deepseek-flash');
	assert.equal(pairValue(pairs, '计价时段'), '空闲时段（高峰 ×2）');
	assert.equal(pairValue(pairs, '输入 · 缓存未命中'), '1,000,000 tok ¥1.00');
	assert.equal(pairValue(pairs, '输入 · 缓存命中'), '10,000,000 tok ¥0.20');
	assert.equal(pairValue(pairs, '输出'), '100,000 tok ¥0.40');
	assert.equal(pairValue(pairs, '充值余额'), '¥12.34');
	assert.equal(pairValue(pairs, '可用合计'), '¥12.34');
});

check('the panel reports the peak rate period when one is in effect', () => {
	const tree = mount(READY, { now: PEAK });
	chipOf(tree).props.onClick();
	const pairs = pairsOf(panelOf(render({ now: PEAK })));
	assert.equal(pairValue(pairs, '计价时段'), '高峰时段');
	assert.equal(pairValue(pairs, '输入 · 缓存未命中'), '1,000,000 tok ¥2.00');
});

check('the panel splits a granted wallet out of the available total', () => {
	const tree = mount({
		status: 'ready',
		wallets: [{ currency: 'CNY', balance: '12.34' }],
		bonusWallets: [{ currency: 'CNY', balance: '3' }],
	});
	chipOf(tree).props.onClick();
	const pairs = pairsOf(panelOf(render()));
	assert.equal(pairValue(pairs, '充值余额'), '¥12.34');
	assert.equal(pairValue(pairs, '赠金余额'), '¥3.00');
	assert.equal(pairValue(pairs, '可用合计'), '¥15.34');
});

check('an unusable balance is explained inside the panel', () => {
	const tree = mount({ status: 'failed' });
	chipOf(tree).props.onClick();
	const panel = panelOf(render());
	assert.equal(textOf(find(panel, (node) => node.props?.className === 'dshSessionCost_note')), '余额读取失败，点击芯片可重试');
});

check('a cache-write bucket appears only when it is non-zero', () => {
	const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2_000_000, outputTokens: 0 };
	const tree = mount(READY, { usage });
	chipOf(tree).props.onClick();
	const pairs = pairsOf(panelOf(render({ usage })));
	assert.equal(pairValue(pairs, '输入 · 缓存写入'), '2,000,000 tok ¥2.00');
});

check('clicking again pins the panel closed', () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	assert.ok(panelOf(render()) !== null);
	chipOf(render()).props.onClick();
	assert.equal(panelOf(render()), null);
});

await checkAsync('hovering opens the panel after the dwell, leaving closes it', async () => {
	const tree = mount(READY);
	chipOf(tree).props.onMouseEnter();
	assert.equal(panelOf(render()), null, 'nothing before the dwell elapses');
	await new Promise((resolve) => setTimeout(resolve, 320));
	assert.ok(panelOf(render()) !== null, 'open after the dwell');
	chipOf(render()).props.onMouseLeave();
	await new Promise((resolve) => setTimeout(resolve, 260));
	assert.equal(panelOf(render()), null, 'closed after the grace period');
});

await checkAsync('Escape closes the open panel', async () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	effectsEnabled = true;
	assert.ok(panelOf(render()) !== null);
	const listener = documentListeners.find(([type]) => type === 'keydown')?.[1];
	assert.equal(typeof listener, 'function', 'an Escape listener is registered while open');
	listener({ key: 'Escape' });
	assert.equal(panelOf(render()), null);
	effectsEnabled = false;
});

await checkAsync('a missing account namespace degrades instead of throwing', async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	const local = {};
	const bare = makeCtx(undefined);
	bare.slots.register = (options, component) => {
		local.component = component;
		return () => {};
	};
	registration.factory((spec) => (spec === 'react-dom' ? reactDom : react)).apply(bare);
	effectsEnabled = true;
	slots.length = 0;
	slotIndex = 0;
	const tree = renderWith(local.component, { usage: null, model: null });
	effectsEnabled = false;
	assert.equal(labelOf(tree), '花费 ¥0.00 · 余额读取中…', 'mount state before the read settles');
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(slots[0].status, 'unavailable');
	assert.equal(labelOf(renderWith(local.component, { usage: null, model: null })), '花费 ¥0.00 · 余额不可用');
});

await checkAsync('mount issues exactly one balance read and paints the settled value', async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	effectsEnabled = true;
	account.calls = 0;
	account.balance = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '7.5' }], bonusWallets: [] } };
	slots.length = 0;
	slotIndex = 0;
	const first = renderWith(captured.component);
	assert.equal(account.calls, 1, 'one read on mount');
	assert.equal(labelOf(first), '花费 ¥1.60 · 余额读取中…');
	assert.equal(cleanups.length > 0, true, 'the mount effect registered a cleanup');
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(slots[0].status, 'ready');
	assert.equal(labelOf(renderWith(captured.component)), '花费 ¥1.60 · 余额 ¥7.50');
	effectsEnabled = false;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

await checkAsync('apply registers one stylesheet and the disposer removes it', async () => {
	assert.equal(styleTags.length >= 1, true, 'a style tag was appended');
	const tag = styleTags[styleTags.length - 1];
	assert.equal(tag.dataset.pluginCss, 'session-cost');
	assert.match(tag.textContent, /\.dshSessionCost_panel\{/u);
	assert.match(tag.textContent, /--dsw-specific-menu/u, 'panel surface comes from a theme token');
	const matches = effectCleanups.filter(({ label }) => label === 'session-cost: stylesheet');
	assert.equal(matches.length > 0, true, 'the stylesheet effect registered a disposer');
	matches[matches.length - 1].cleanup();
	assert.equal(tag.removed, true, 'disposal removes the stylesheet');
});

console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nRESULT: failures present' : '\nRESULT: all checks passed');
