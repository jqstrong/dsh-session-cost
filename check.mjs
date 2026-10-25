/**
 * Logic check for the `@local/dsh-session-cost` bundle.
 *
 * Part 1 drives the real Host half (`index.js`) against a mock projection
 * registry: peak/off-peak bucketing by event time, retried-step replacement,
 * parity with the shipped `tokenUsage` fold, and the schema faces the registry
 * calls.
 *
 * Part 2 runs the real Client half (`client.js`) in a Node VM with minimal
 * React/react-dom and DOM stubs, driving the chip through its interaction paths
 * (mount, hover, click, Escape) and asserting the chip text, the per-period
 * panel sections, the account-level charge section, and every degraded state —
 * including the regression that the displayed spend must NOT change when the
 * wall clock crosses a rate boundary, the v1.1 regression that a shared
 * account's balance drop is shown next to (not instead of) this session's
 * spend, and the latest-request-wins guard for overlapping balance reads. The
 * 60s balance-refresh interval is captured, so a test can fire the tick (or
 * leave several reads in flight with a deferred stub) and settle the async read
 * before asserting.
 *
 * This is a numbers-and-branch check, NOT visual verification: it never applies
 * CSS and cannot show what the page looks like.
 *
 * Run: node check.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { apply as hostApply, inject as hostInject } from './index.js';

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
async function checkAsync(name, fn) {
	try {
		await fn();
		results.push(`PASS  ${name}`);
	} catch (error) {
		report(name, error);
	}
}

/* ==================================================================== */
/* Part 1 — Host projection unit                                        */
/* ==================================================================== */

const MON_PEAK = Date.parse('2026-10-12T10:00:00+08:00'); // Monday 10:00 Beijing
const MON_EARLY = Date.parse('2026-10-12T08:00:00+08:00'); // Monday 08:00 Beijing
const SUN = Date.parse('2026-10-11T20:36:00+08:00'); // Sunday 20:36 Beijing

const usageOfTokens = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
	inputTokens,
	outputTokens,
	cacheReadTokens,
	cacheWriteTokens,
});
const messageEvent = (turn, step, time, usage) => ({
	type: 'assistant/message',
	seq: turn * 100 + step,
	time,
	data: { turn, step, message: {}, stream: [], usage },
});
const attemptEvent = (turn, step, time, usage) => ({
	type: 'assistant/attempt',
	seq: turn * 100 + step,
	time,
	data: { turn, step, stream: [{ type: 'text-chunks', texts: [] }, { type: 'chunk', chunk: { type: 'usage', usage } }] },
});
const retryEvent = (turn, step) => ({
	type: 'llm/retry-started',
	seq: turn * 100 + step,
	time: 0,
	data: { turn, step },
});
const otherEvent = () => ({ type: 'turn/start', seq: 9, time: 0, data: { turn: 1 } });

/** Register the bundle's unit against a mock registry. */
let unit;
hostApply({
	sessionProjections: {
		register: (definition) => {
			unit = definition;
			return () => {};
		},
	},
});

/** Fold one event list from init. */
function foldAll(events) {
	return events.reduce((state, event) => unit.apply(state, event), unit.init({}, 0));
}

/** Reference `tokenUsage` fold (mirrors the shipped unit) for parity checks. */
function referenceTotals(events) {
	const zero = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
	const bucketsFrom = (usage) => ({
		uncachedInputTokens: usage.inputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		outputTokens: usage.outputTokens,
	});
	const usageOf = (event) => {
		if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
		if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
		for (let index = event.data.stream.length - 1; index >= 0; index -= 1) {
			const record = event.data.stream[index];
			if (record.type === 'chunk' && record.chunk.type === 'usage') return record.chunk.usage;
		}
		return undefined;
	};
	const equal = (left, right) => ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
		.every((key) => left[key] === right[key]);
	let totals = zero();
	let last = null;
	for (const event of events) {
		if (event.type === 'llm/retry-started') {
			if (last !== null && last.turn === event.data.turn && last.step === event.data.step) last = null;
			continue;
		}
		const sample = usageOf(event);
		if (sample === undefined) continue;
		const { turn, step } = event.data;
		const buckets = bucketsFrom(sample);
		const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined;
		if (previous !== undefined && equal(previous, buckets)) continue;
		const next = { ...totals };
		for (const key of Object.keys(next)) next[key] += buckets[key] - (previous?.[key] ?? 0);
		totals = next;
		last = { turn, step, buckets };
	}
	return totals;
}

/** Sum of both period buckets. */
function foldedTotals(state) {
	const total = { ...state.peak };
	for (const key of Object.keys(total)) total[key] += state.off[key];
	return total;
}

check('host: the bundle declares the projection registry inject', () => {
	assert.deepEqual([...hostInject], ['sessionProjections']);
});

check('host: apply registers one unit under a private key version 1', () => {
	assert.ok(unit !== undefined, 'a unit was registered');
	assert.equal(unit.key, 'sessionCost');
	assert.equal(unit.stateVersion, 1);
	assert.equal(typeof unit.init, 'function');
	assert.equal(typeof unit.apply, 'function');
	assert.equal(typeof unit.wire.view, 'function');
	assert.equal(typeof unit.stateSchema.parse, 'function');
	assert.equal(typeof unit.wire.viewSchema.parse, 'function');
});

check('host: an empty log starts at zero with no open slot', () => {
	const state = unit.init({}, 0);
	assert.deepEqual(state.peak, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
	assert.deepEqual(state.off, state.peak);
	assert.equal(state.last, null);
	assert.deepEqual(unit.wire.view(state), { peak: state.peak, off: state.off });
});

check('host: peak and off-peak samples land in their own buckets', () => {
	const state = foldAll([
		messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 100_000)),
		messageEvent(1, 2, MON_EARLY, usageOfTokens(2_000_000, 200_000)),
		messageEvent(1, 3, SUN, usageOfTokens(3_000_000, 300_000)),
	]);
	assert.equal(state.peak.uncachedInputTokens, 1_000_000);
	assert.equal(state.peak.outputTokens, 100_000);
	assert.equal(state.off.uncachedInputTokens, 5_000_000, 'Monday 08:00 and Sunday 20:36 are off-peak');
	assert.equal(state.off.outputTokens, 500_000);
});

check('host: peak windows are 09:00-12:00 and 14:00-18:00 Beijing on weekdays', () => {
	const at = (iso) => foldAll([messageEvent(1, 1, Date.parse(iso), usageOfTokens(1, 0))]).peak.uncachedInputTokens;
	assert.equal(at('2026-10-12T08:59:00+08:00'), 0); // Mon 08:59
	assert.equal(at('2026-10-12T09:00:00+08:00'), 1); // Mon 09:00
	assert.equal(at('2026-10-12T11:59:00+08:00'), 1); // Mon 11:59
	assert.equal(at('2026-10-12T12:00:00+08:00'), 0); // Mon 12:00
	assert.equal(at('2026-10-12T14:00:00+08:00'), 1); // Mon 14:00
	assert.equal(at('2026-10-12T17:59:00+08:00'), 1); // Mon 17:59
	assert.equal(at('2026-10-12T18:00:00+08:00'), 0); // Mon 18:00
	assert.equal(at('2026-10-11T10:00:00+08:00'), 0); // Sunday
	assert.equal(at('2026-10-17T10:00:00+08:00'), 0); // Saturday
});

check('host: a retried step keeps the failed attempt and adds the retry', () => {
	// `llm/retry-started` closes the replacement slot: the failed attempt stays
	// billed and the retried attempt adds instead of replacing it.
	const state = foldAll([
		attemptEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 1_000)),
		retryEvent(1, 1),
		messageEvent(1, 1, MON_EARLY, usageOfTokens(2_000_000, 2_000)),
	]);
	assert.equal(state.peak.uncachedInputTokens, 1_000_000, 'the failed peak attempt stays billed');
	assert.equal(state.peak.outputTokens, 1_000);
	assert.equal(state.off.uncachedInputTokens, 2_000_000);
	assert.equal(state.off.outputTokens, 2_000);
});

check('host: one attempt reporting twice is replaced, not doubled', () => {
	const state = foldAll([
		attemptEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 1_000)),
		messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 1_000)),
	]);
	assert.equal(state.peak.uncachedInputTokens, 1_000_000);
	assert.equal(state.peak.outputTokens, 1_000);
});

check('host: a message-less attempt reports usage from its stream', () => {
	const state = foldAll([attemptEvent(2, 1, SUN, usageOfTokens(700_000, 70_000, 30_000, 5_000))]);
	assert.equal(state.off.uncachedInputTokens, 700_000);
	assert.equal(state.off.cacheReadTokens, 30_000);
	assert.equal(state.off.cacheWriteTokens, 5_000);
	assert.equal(state.off.outputTokens, 70_000);
});

check('host: a same-step replacement moves tokens between periods', () => {
	const state = foldAll([
		messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 0)),
		messageEvent(1, 1, MON_EARLY, usageOfTokens(1_000_000, 0)),
	]);
	assert.equal(state.peak.uncachedInputTokens, 0);
	assert.equal(state.off.uncachedInputTokens, 1_000_000);
});

check('host: unrelated events do not allocate a new state', () => {
	const state = unit.init({}, 0);
	assert.equal(unit.apply(state, otherEvent()), state);
	assert.equal(unit.apply(state, retryEvent(1, 1)), state);
});

check('host: period buckets always sum to the shipped tokenUsage totals', () => {
	const events = [
		messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 100_000, 500_000, 0)),
		messageEvent(1, 2, MON_EARLY, usageOfTokens(2_000_000, 200_000, 0, 50_000)),
		retryEvent(1, 2),
		attemptEvent(1, 2, MON_EARLY, usageOfTokens(2_500_000, 250_000, 100_000, 10_000)),
		otherEvent(),
		messageEvent(2, 1, SUN, usageOfTokens(3_000_000, 300_000, 1_000_000, 0)),
		retryEvent(2, 1), // no sample after the retry: the earlier one is withdrawn
		messageEvent(3, 1, MON_PEAK, usageOfTokens(4_000_000, 400_000, 2_000_000, 20_000)),
	];
	const state = foldAll(events);
	assert.deepEqual(foldedTotals(state), referenceTotals(events));
});

check('host: schema parse accepts the unit state and rejects garbage', () => {
	const state = foldAll([messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 100_000))]);
	assert.equal(unit.stateSchema.parse(state), state, 'round-trips a real state');
	assert.equal(unit.stateSchema.parse(JSON.parse(JSON.stringify(state))).peak.uncachedInputTokens, 1_000_000, 'accepts persisted JSON');
	assert.throws(() => unit.stateSchema.parse(null));
	assert.throws(() => unit.stateSchema.parse({ peak: { uncachedInputTokens: -1 }, off: {} }));
	assert.throws(() => unit.stateSchema.parse({ peak: state.peak, off: state.off, last: { turn: 1, step: 1, period: 'evening', buckets: state.peak } }));
	assert.equal(unit.stateSchema.safeParse({}).success, false);
	assert.equal(unit.stateSchema.safeParse(state).success, true);
});

check('host: view schema validates the wire value only', () => {
	const state = foldAll([messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 100_000))]);
	const view = unit.wire.view(state);
	assert.equal(unit.wire.viewSchema.parse(view), view);
	assert.throws(() => unit.wire.viewSchema.parse({ peak: state.peak }));
	assert.throws(() => unit.wire.viewSchema.parse(null));
});

check('host: clearing a retry slot does not publish a new wire value', () => {
	const state = foldAll([
		messageEvent(1, 1, MON_PEAK, usageOfTokens(1_000_000, 0)),
		messageEvent(1, 2, MON_PEAK, usageOfTokens(1_000_000, 0)),
	]);
	const view = unit.wire.view(state);
	const cleared = unit.apply(state, retryEvent(1, 2));
	assert.notEqual(cleared, state, 'the state changed…');
	assert.equal(unit.wire.view(cleared), view, '…but the wire value keeps its identity');
});

check('host: the wire value is plain JSON', () => {
	const state = foldAll([messageEvent(1, 1, SUN, usageOfTokens(5, 6, 7, 8))]);
	assert.deepEqual(JSON.parse(JSON.stringify(unit.wire.view(state))), unit.wire.view(state));
});

/* ==================================================================== */
/* Part 2 — Client chip and panel                                       */
/* ==================================================================== */

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

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
/**
 * Component state slots, one entry per `useState` call of the mounted instance.
 * Read them through the shape-based helpers below, not by fixed index: v1.1
 * inserts the account-charge state next to the balance state.
 */
const slots = [];
/**
 * First-mount override for the component's balance state. `mount()` needs to
 * start a render with the balance already settled because the real read is
 * asynchronous; the mock consumes this seed at the first `useState` whose
 * initial value looks like a balance state — keyed on shape, not slot order, so
 * adding account-charge state above the balance does not break the checks.
 */
let stateSeed = null;
let effectsEnabled = false;
const cleanups = [];

/** Whether a state value is the balance state (the one carrying `status`). */
function isBalanceState(value) {
	return value !== null && typeof value === 'object' && typeof value.status === 'string';
}

const react = {
	Fragment: Symbol('Fragment'),
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => {
		const index = slotIndex;
		slotIndex += 1;
		if (!(index in slots)) {
			let value = typeof init === 'function' ? init() : init;
			if (stateSeed !== null && isBalanceState(value)) {
				value = stateSeed;
				stateSeed = null;
			}
			slots[index] = value;
		}
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

/** Recorded `setInterval` registrations, so a test can fire the balance poll. */
let nextIntervalId = 0;
const intervals = [];
function recordInterval(fn, ms) {
	const id = nextIntervalId;
	nextIntervalId += 1;
	intervals.push({ id, fn, ms, cleared: false });
	return id;
}
function clearRecordedInterval(id) {
	const entry = intervals.find((item) => item.id === id);
	if (entry !== undefined) entry.cleared = true;
}

const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (value) => {
				registration = value;
			},
		},
		setInterval: recordInterval,
		clearInterval: clearRecordedInterval,
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
	setInterval: recordInterval,
	clearInterval: clearRecordedInterval,
	setTimeout,
	clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.ok(registration !== undefined, 'client module registered a factory');
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
assert.equal(captured.options.order, 50, 'ordered after the shipped entries');
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

const OFF_PEAK_NOW = Date.parse('2026-10-11T20:36:00+08:00'); // Sunday 20:36 Beijing
const PEAK_NOW = Date.parse('2026-10-12T10:00:00+08:00'); // Monday 10:00 Beijing

const USAGE = { uncachedInputTokens: 1_000_000, cacheReadTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 100_000 };
const SPLIT = {
	peak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	off: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
};
const READY = { status: 'ready', wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] };

/** A raw `remote.account.getBalance` result the mutable stub can serve. */
const remoteReady = (wallets, bonusWallets = []) => ({
	ok: true,
	value: { status: 'ready', value: wallets, bonusWallets },
});
const wallet = (currency, balance) => ({ currency, balance });

/** Empty token buckets. */
const ZERO_BUCKETS = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
/** Session spend ¥0.00: the page opened before this session spent anything. */
const ZERO_SPLIT = {
	peak: { ...ZERO_BUCKETS },
	off: { ...ZERO_BUCKETS },
};
/** Session-spend fixture: 1M off-peak cache-miss tokens = exactly ¥1.00. */
const ONE_YUAN_SPLIT = {
	peak: { ...ZERO_BUCKETS },
	off: { ...ZERO_BUCKETS, uncachedInputTokens: 1_000_000 },
};
/* `SPLIT` above is the ¥3.00 fixture: 1M cache-miss in each period (¥2 + ¥1). */
/** Mid-session fixture ¥4.00: peak 1M miss (¥2.00) + off-peak 2M miss (¥2.00). */
const FOUR_YUAN_SPLIT = {
	peak: { ...ZERO_BUCKETS, uncachedInputTokens: 1_000_000 },
	off: { ...ZERO_BUCKETS, uncachedInputTokens: 2_000_000 },
};

/* Account-section strings from the v1.1 spec; the checks
   assert these exact user-visible values, not the dictionary internals. */
const ACCOUNT_HEAD_ZH = '账户已扣（自打开本页）';
const ACCOUNT_EXTRA_ZH = '其中其他会话 / 子代理 / 工具';
const ACCOUNT_NOTE_ZH = '余额为整个账户共用：其他会话、子代理、其他工具或设备同样会扣费。账户已扣只统计本页打开后观察到的余额减少（平台按批次结算，可能短暂滞后），充值或赠金变动不计入。';
const ACCOUNT_HEAD_EN = 'Charged to account (since this page opened)';
const ACCOUNT_EXTRA_EN = 'of which other sessions / subagents / tools';
const ACCOUNT_NOTE_EN = 'The balance is shared by the whole account: other sessions, subagents, other tools, or other devices also draw it down. Account charged only counts balance decreases observed while this page is open (the platform settles in batches, so it can lag briefly); top-ups and grants are not counted.';

/** Component props for one render; `null` selects the absent projection value. */
function props({ split = SPLIT, usage = USAGE, model = 'deepseek-flash', locale = 'zh', now = OFF_PEAK_NOW } = {}) {
	sandbox.Date = fakeDate(now);
	return {
		useProjection: (key) => {
			if (key === 'sessionCost') return split ?? undefined;
			if (key === 'tokenUsage') return usage ?? undefined;
			if (key === 'modelSelection') {
				return { lastUsed: model === null ? null : { provider: 'deepseek-account', model }, next: null };
			}
			return undefined;
		},
		t: translate(locale),
	};
}

/**
 * Start a fresh component instance: empty state slots, no pending effects, and
 * no recorded interval left over from a previous test.
 */
function resetMountState() {
	slots.length = 0;
	slotIndex = 0;
	stateSeed = null;
	effectsEnabled = false;
	for (const cleanup of cleanups.splice(0)) cleanup();
	intervals.length = 0;
}

/** First mount with a given balance state; later renders keep the component's own state. */
function mount(balanceState, options) {
	resetMountState();
	stateSeed = balanceState;
	const tree = render(options);
	stateSeed = null;
	return tree;
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

/** The component's live balance state, wherever its hook slot sits. */
function balanceStateOf() {
	const state = slots.find((slot) => isBalanceState(slot));
	assert.ok(state !== undefined, 'the component keeps a balance state slot');
	return state;
}

/** Flush the async read behind one refresh tick (two macrotask turns). */
function settleAsync() {
	return new Promise((resolve) => setTimeout(resolve, 0))
		.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/**
 * Mount with effects enabled, so the mount balance read runs and the 60s
 * refresh interval is registered; then settle the read. Re-render to paint it.
 */
async function mountLive(options) {
	resetMountState();
	effectsEnabled = true;
	const tree = render(options);
	effectsEnabled = false;
	await settleAsync();
	return tree;
}

/**
 * Fire the recorded 60s balance-refresh interval `count` times without settling
 * any read; used by the latest-request-wins tests to leave overlapping reads in
 * flight.
 */
function fireRefreshTicks(count = 1) {
	const active = intervals.filter((entry) => entry.cleared === false && entry.ms === 60000);
	assert.ok(active.length > 0, 'the component registered a 60s balance-refresh interval');
	for (let index = 0; index < count; index += 1) {
		for (const entry of active) entry.fn();
	}
}

/**
 * Fire the recorded 60s balance-refresh interval, settle the async read, and
 * re-render the same component instance.
 * @returns the tree after the tick settled.
 */
async function tickRefresh(options) {
	fireRefreshTicks(1);
	await settleAsync();
	return render(options);
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

/** Whether a node's class list contains one given class. */
function hasClass(node, className) {
	const classes = typeof node.props?.className === 'string' ? node.props.className.split(/\s+/u) : [];
	return classes.includes(className);
}

/**
 * Split the panel into its structural parts: the top label/value grid, one
 * block per period section, the account-charge grid with its note, and the
 * balance grid.
 * @param panel - the portaled panel element.
 * @returns `{ top, sections, account, balance, notes, order }` — pair lists, a
 *   headed section list, the note texts in document order, and a document-order
 *   tag list (`top`, `section:<head>`, `account`, `note`, `balance`) used to
 *   assert the v1.1 layout order. The account note is the one that follows the
 *   account grid; degraded balances render their own note instead of a grid.
 */
function partsOf(panel) {
	const top = [];
	const sections = [];
	const notes = [];
	const order = [];
	let account = null;
	let balance = null;
	let current = null;
	/** Which grid comes next: the top grid, a period section, or a panel block. */
	let phase = 'top';
	const pairsOf = (node) => {
		const pairs = [];
		let title = null;
		for (const child of (node.children ?? []).flat()) {
			if (child === null || typeof child !== 'object') continue;
			if (child.type === 'dt') title = textOf(child);
			if (child.type === 'dd') pairs.push([title, textOf(child)]);
		}
		return pairs;
	};
	const visit = (node) => {
		if (node === null || node === undefined || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (hasClass(node, 'dshSessionCost_sectionHead')) {
			current = { head: textOf(node), rows: [] };
			sections.push(current);
			order.push(`section:${current.head}`);
			phase = 'section';
			return;
		}
		if (hasClass(node, 'dshSessionCost_note')) {
			notes.push(textOf(node));
			order.push('note');
			return;
		}
		if (hasClass(node, 'dshSessionCost_panelSection')) {
			current = null;
			phase = 'panel';
			return;
		}
		if (node.type === 'dl') {
			const pairs = pairsOf(node);
			/* The account grid is marked by its class; fall back to its heading
			   so the parser still finds it if the class is dropped. */
			if (hasClass(node, 'dshSessionCost_accountRows') || pairs[0]?.[0] === ACCOUNT_HEAD_ZH || pairs[0]?.[0] === ACCOUNT_HEAD_EN) {
				account = pairs;
				order.push('account');
			} else if (phase === 'top') {
				top.push(...pairs);
				order.push('top');
			} else if (phase === 'section') {
				current.rows.push(...pairs);
			} else {
				balance = pairs;
				order.push('balance');
			}
			return;
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(panel);
	return { top, sections, account, balance, notes, order };
}

const pairValue = (pairs, title) => pairs?.find(([name]) => name === title)?.[1];

/* ---- chip text ---- */

check('client: a split session prices peak and off-peak samples separately', () => {
	// 1M cache-miss tokens in each period: ¥1/1M off-peak, ×2 at peak.
	assert.equal(labelOf(mount(READY)), '花费 ¥3.00 · 余额 ¥12.34');
});

check('client: the chip does not move when the clock crosses a rate boundary', () => {
	// The regression this fixes: same usage, wall clock at off-peak vs peak.
	const offLabel = labelOf(mount(READY, { now: OFF_PEAK_NOW }));
	const peakLabel = labelOf(mount(READY, { now: PEAK_NOW }));
	assert.equal(offLabel, peakLabel);
	assert.equal(peakLabel, '花费 ¥3.00 · 余额 ¥12.34');
});

check('client: a peak-only session pays the peak price', () => {
	const split = {
		peak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	assert.equal(labelOf(mount(READY, { split })), '花费 ¥2.00 · 余额 ¥12.34');
});

check('client: an off-peak-only session pays the base price', () => {
	const split = {
		peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	assert.equal(labelOf(mount(READY, { split })), '花费 ¥1.00 · 余额 ¥12.34');
});

check('client: cache hit and output buckets use their own rates in both periods', () => {
	const split = {
		peak: { uncachedInputTokens: 0, cacheReadTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 100_000 },
		off: { uncachedInputTokens: 0, cacheReadTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 100_000 },
	};
	// peak: 10M × 0.02 × 2 = 0.40 + 0.1M × 4 × 2 = 0.80 → 1.20
	// off:  10M × 0.02     = 0.20 + 0.1M × 4     = 0.40 → 0.60
	assert.equal(labelOf(mount(READY, { split })), '花费 ¥1.80 · 余额 ¥12.34');
});

check('client: without split data the figure is an explicit estimate', () => {
	const tree = mount(READY, { split: null });
	assert.equal(labelOf(tree), '花费 ≈¥1.60 · 余额 ¥12.34');
});

check('client: deepseek-v4-pro uses its own price row', () => {
	const split = {
		peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	assert.equal(labelOf(mount(READY, { split, model: 'deepseek-v4-pro' })), '花费 ¥4.50 · 余额 ¥12.34');
});

check('client: unknown model falls back to the default row', () => {
	const split = {
		peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	assert.equal(labelOf(mount(READY, { split, model: 'some-future-model' })), '花费 ¥1.00 · 余额 ¥12.34');
});

check('client: a failed balance read degrades to spend only', () => {
	assert.equal(labelOf(mount({ status: 'failed' })), '花费 ¥3.00 · 余额不可用');
});

check('client: signed out and unavailable states are distinct', () => {
	assert.equal(labelOf(mount({ status: 'signed-out' })), '花费 ¥3.00 · 未登录账号');
	assert.equal(labelOf(mount({ status: 'unavailable' })), '花费 ¥3.00 · 余额不可用');
});

check('client: granted balance is added to the remaining amount', () => {
	const tree = mount({
		status: 'ready',
		wallets: [{ currency: 'CNY', balance: '12.34' }, { currency: 'USD', balance: '1.5' }],
		bonusWallets: [{ currency: 'CNY', balance: '3' }],
	});
	assert.equal(labelOf(tree), '花费 ¥3.00 · 余额 ¥15.34 + $1.50');
});

check('client: english locale renders english text', () => {
	assert.equal(labelOf(mount(READY, { locale: 'en' })), 'Spent ¥3.00 · Balance ¥12.34');
});

/* ---- panel ---- */

check('client: the panel is closed until the chip is used', () => {
	const tree = mount(READY);
	assert.equal(panelOf(tree), null);
	assert.equal(chipOf(tree).props['aria-expanded'], false);
	assert.equal(chipOf(tree).props['aria-haspopup'], 'dialog');
});

check('client: clicking the chip opens a per-period breakdown', () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	const open = render();
	const panel = panelOf(open);
	assert.ok(panel !== null, 'panel rendered after the click');
	assert.equal(chipOf(open).props['aria-expanded'], true);
	const parts = partsOf(panel);
	assert.deepEqual(parts.top, [
		['计价模型', 'deepseek-flash'],
		['计价口径', '按每笔用量发生的时段（高峰 ×2）'],
	]);
	assert.equal(parts.sections.length, 2, 'one block per period');
	assert.equal(parts.sections[0].head, '高峰时段（×2）');
	assert.deepEqual(parts.sections[0].rows, [
		['输入 · 缓存未命中', '1,000,000 tok ¥2.00'],
		['输出', '0 tok ¥0.00'],
		['小计', '¥2.00'],
	]);
	assert.equal(parts.sections[1].head, '空闲时段（×1）');
	assert.deepEqual(parts.sections[1].rows, [
		['输入 · 缓存未命中', '1,000,000 tok ¥1.00'],
		['输出', '0 tok ¥0.00'],
		['小计', '¥1.00'],
	]);
	assert.deepEqual(parts.balance, [
		['充值余额', '¥12.34'],
		['可用合计', '¥12.34'],
	]);
});

check('client: a single-period session shows no subtotal row', () => {
	const split = {
		peak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 500_000, cacheWriteTokens: 0, outputTokens: 200_000 },
		off: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	const tree = mount(READY, { split });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split })));
	assert.equal(parts.sections.length, 1);
	assert.equal(parts.sections[0].head, '高峰时段（×2）');
	assert.deepEqual(parts.sections[0].rows.map(([title]) => title), ['输入 · 缓存未命中', '输入 · 缓存命中', '输出']);
	assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存命中'), '500,000 tok ¥0.02', '5e5 × 0.02 × 2 / 1e6');
	assert.equal(pairValue(parts.sections[0].rows, '输出'), '200,000 tok ¥1.60', '2e5 × 4 × 2 / 1e6');
});

check('client: the estimate panel states its basis and single section', () => {
	const tree = mount(READY, { split: null });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: null })));
	assert.deepEqual(parts.top, [
		['计价模型', 'deepseek-flash'],
		['计价口径', '缺少分时段数据，按当前时段估算'],
	]);
	assert.equal(parts.sections.length, 1);
	assert.equal(parts.sections[0].head, '估算（无分时段数据）');
	assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存命中'), '10,000,000 tok ¥0.20');
});

check('client: the peak section applies the doubled cache-miss rate', () => {
	const split = {
		peak: { uncachedInputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
	};
	const tree = mount(READY, { split });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split })));
	assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存未命中'), '2,000,000 tok ¥4.00');
});

check('client: a cache-write bucket appears only when it is non-zero', () => {
	const split = {
		peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		off: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2_000_000, outputTokens: 0 },
	};
	const tree = mount(READY, { split });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split })));
	assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存写入'), '2,000,000 tok ¥2.00');
});

check('client: clicking again pins the panel closed', () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	assert.ok(panelOf(render()) !== null);
	chipOf(render()).props.onClick();
	assert.equal(panelOf(render()), null);
});

await checkAsync('client: hovering opens the panel after the dwell, leaving closes it', async () => {
	const tree = mount(READY);
	chipOf(tree).props.onMouseEnter();
	assert.equal(panelOf(render()), null, 'nothing before the dwell elapses');
	await new Promise((resolve) => setTimeout(resolve, 320));
	assert.ok(panelOf(render()) !== null, 'open after the dwell');
	chipOf(render()).props.onMouseLeave();
	await new Promise((resolve) => setTimeout(resolve, 260));
	assert.equal(panelOf(render()), null, 'closed after the grace period');
});

await checkAsync('client: Escape closes the open panel', async () => {
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

await checkAsync('client: outside pointer-down closes the open panel', async () => {
	const tree = mount(READY);
	chipOf(tree).props.onClick();
	effectsEnabled = true;
	assert.ok(panelOf(render()) !== null);
	const listener = documentListeners.find(([type]) => type === 'pointerdown')?.[1];
	assert.equal(typeof listener, 'function', 'a pointer listener is registered while open');
	listener({ target: {} });
	assert.equal(panelOf(render()), null);
	effectsEnabled = false;
});

await checkAsync('client: a missing account namespace degrades instead of throwing', async () => {
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
	const tree = renderWith(local.component, { split: null });
	effectsEnabled = false;
	assert.equal(labelOf(tree), '花费 ≈¥1.60 · 余额读取中…', 'mount state before the read settles');
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(balanceStateOf().status, 'unavailable');
	assert.equal(labelOf(renderWith(local.component, { split: null })), '花费 ≈¥1.60 · 余额不可用');
});

await checkAsync('client: mount issues exactly one balance read and paints the settled value', async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	effectsEnabled = true;
	account.calls = 0;
	account.balance = { ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '7.5' }], bonusWallets: [] } };
	slots.length = 0;
	slotIndex = 0;
	const first = renderWith(captured.component);
	assert.equal(account.calls, 1, 'one read on mount');
	assert.equal(labelOf(first), '花费 ¥3.00 · 余额读取中…');
	assert.equal(cleanups.length > 0, true, 'the mount effect registered a cleanup');
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(balanceStateOf().status, 'ready');
	assert.equal(labelOf(renderWith(captured.component)), '花费 ¥3.00 · 余额 ¥7.50');
	effectsEnabled = false;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

await checkAsync('client: apply registers one stylesheet and the disposer removes it', async () => {
	assert.equal(styleTags.length >= 1, true, 'a style tag was appended');
	const tag = styleTags[styleTags.length - 1];
	assert.equal(tag.dataset.pluginCss, 'session-cost');
	assert.match(tag.textContent, /\.dshSessionCost_panel\{/u);
	assert.match(tag.textContent, /--dsw-specific-menu/u, 'panel surface comes from a theme token');
	assert.match(tag.textContent, /\.dshSessionCost_sectionHead\{/u, 'period section heading is styled');
	const matches = effectCleanups.filter(({ label }) => label === 'session-cost: stylesheet');
	assert.equal(matches.length > 0, true, 'the stylesheet effect registered a disposer');
	matches[matches.length - 1].cleanup();
	assert.equal(tag.removed, true, 'disposal removes the stylesheet');
});

/* ---- account-level charges (v1.1) ---- */

await checkAsync('client: a fresh mount shows no account section', async () => {
	const tree = mount(READY);
	assert.equal(labelOf(tree), '花费 ¥3.00 · 余额 ¥12.34', 'the chip keeps its plain form before any read');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render()));
	assert.equal(parts.account, null, 'no account grid on a fresh mount');
	assert.deepEqual(parts.notes, [], 'no account note on a fresh mount');
});

await checkAsync('client: an account drop beyond the session spend adds the segment and rows', async () => {
	// ¥1.00 of session spend, but the shared account fell ¥3.10: the extra
	// ¥2.10 is other sessions/subagents/tools, and the chip says so.
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	let tree = render({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥12.34', 'the baseline read does not invent a charge');
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 账户 -¥3.10 · 余额 ¥9.24');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_ZH, '-¥3.10'],
		[ACCOUNT_EXTRA_ZH, '-¥2.10'],
	]);
	assert.deepEqual(parts.notes, [ACCOUNT_NOTE_ZH], 'the shared-account note explains the difference');
});

await checkAsync('client: a drop equal to the session spend adds no extra row', async () => {
	// SPLIT is ¥3.00 of session spend and the account falls exactly ¥3.00:
	// there is no other-session share to surface.
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = remoteReady([wallet('CNY', '9.34')]);
	const tree = await tickRefresh({ split: SPLIT });
	assert.equal(labelOf(tree), '花费 ¥3.00 · 余额 ¥9.34', 'no account segment when the drop matches the spend');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: SPLIT })));
	assert.deepEqual(parts.account, [[ACCOUNT_HEAD_ZH, '-¥3.00']], 'only the account row is shown');
});

await checkAsync('client: a top-up is not counted as negative spend', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = remoteReady([wallet('CNY', '20.00')]);
	let tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥20.00', 'an increased balance is absorbed, never subtracted');
	account.balance = remoteReady([wallet('CNY', '19.00')]);
	tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥19.00');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
	assert.deepEqual(parts.account, [[ACCOUNT_HEAD_ZH, '-¥1.00']], 'only the real drop after the top-up counts');
});

await checkAsync('client: a failed read resets the baseline instead of billing the outage', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = { ok: false };
	let tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额不可用', 'the failure degrades the chip');
	account.balance = remoteReady([wallet('CNY', '8.00')]);
	tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥8.00', 'the next success re-baselines');
	chipOf(tree).props.onClick();
	const panel = panelOf(render({ split: ONE_YUAN_SPLIT }));
	const parts = partsOf(panel);
	assert.equal(parts.account, null, 'the outage gap is not claimed as a charge');
	assert.equal(textOf(panel).includes('4.34'), false, 'the ¥12.34 → ¥8.00 gap never surfaces');
});

await checkAsync('client: account charges accumulate separately per currency', async () => {
	account.balance = remoteReady([wallet('CNY', '10.00'), wallet('USD', '5.00')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = remoteReady([wallet('CNY', '6.90'), wallet('USD', '3.00')]);
	const tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_ZH, '-¥3.10 + -$2.00'],
		[ACCOUNT_EXTRA_ZH, '-¥2.10'],
	]);
});

await checkAsync('client: english locale renders the account chip segment', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT, locale: 'en' });
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	const tree = await tickRefresh({ split: ONE_YUAN_SPLIT, locale: 'en' });
	assert.equal(labelOf(tree), 'Spent ¥1.00 · account -¥3.10 · balance ¥9.24');
});

await checkAsync('client: english locale localises the account section', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT, locale: 'en' });
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	const tree = await tickRefresh({ split: ONE_YUAN_SPLIT, locale: 'en' });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT, locale: 'en' })));
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_EN, '-¥3.10'],
		[ACCOUNT_EXTRA_EN, '-¥2.10'],
	]);
	assert.deepEqual(parts.notes, [ACCOUNT_NOTE_EN]);
});

await checkAsync('client: the account segment waits for a ready balance', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	await tickRefresh({ split: ONE_YUAN_SPLIT });
	account.balance = { ok: false };
	const tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额不可用', 'the degraded chip omits the account segment');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_ZH, '-¥3.10'],
		[ACCOUNT_EXTRA_ZH, '-¥2.10'],
	], 'the accumulated charge stays visible in the panel');
});

/* ---- overlapping reads, signed-out reset, and panel order (verifier D1/D5) ---- */

await checkAsync('client: overlapping balance reads keep the latest response (D1)', async () => {
	// The account stub is deferred so the test controls resolution order. The
	// mount read settles first (the baseline), then two interval ticks are left
	// in flight and the OLDER request answers LAST. Without latest-request-wins
	// the stale 12.34 would revert the chip and corrupt the charge baseline.
	const pending = [];
	const immediateGetBalance = account.getBalance;
	account.getBalance = () => new Promise((resolve) => {
		pending.push(resolve);
	});
	try {
		await mountLive({ split: ZERO_SPLIT });
		assert.equal(pending.length, 1, 'the mount issued one balance read');
		pending[0](remoteReady([wallet('CNY', '12.34')]));
		await settleAsync();
		assert.equal(labelOf(render({ split: ONE_YUAN_SPLIT })), '花费 ¥1.00 · 余额 ¥12.34', 'the baseline settled');
		fireRefreshTicks(2);
		assert.equal(pending.length, 3, 'two overlapping reads are in flight');
		pending[2](remoteReady([wallet('CNY', '8.00')])); // newer read answers first
		await settleAsync();
		pending[1](remoteReady([wallet('CNY', '12.34')])); // older read answers last
		await settleAsync();
		const tree = render({ split: ONE_YUAN_SPLIT });
		assert.equal(
			labelOf(tree),
			'花费 ¥1.00 · 账户 -¥4.34 · 余额 ¥8.00',
			'the true ¥4.34 drop is shown, not the stale ¥12.34 balance',
		);
		chipOf(tree).props.onClick();
		const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
		assert.deepEqual(parts.account, [
			[ACCOUNT_HEAD_ZH, '-¥4.34'],
			[ACCOUNT_EXTRA_ZH, '-¥3.34'],
		], 'the accumulated charge reflects only the newer response');
	} finally {
		account.getBalance = immediateGetBalance;
	}
});

await checkAsync('client: a stale response after a top-up neither reverts the chip nor invents a charge (D1)', async () => {
	const pending = [];
	const immediateGetBalance = account.getBalance;
	account.getBalance = () => new Promise((resolve) => {
		pending.push(resolve);
	});
	try {
		await mountLive({ split: ZERO_SPLIT });
		pending[0](remoteReady([wallet('CNY', '12.34')]));
		await settleAsync();
		fireRefreshTicks(2);
		pending[2](remoteReady([wallet('CNY', '20.00')])); // the top-up is the newer read
		await settleAsync();
		pending[1](remoteReady([wallet('CNY', '12.34')])); // stale pre-top-up snapshot answers last
		await settleAsync();
		let tree = render({ split: ONE_YUAN_SPLIT });
		assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥20.00', 'the stale snapshot does not revert the balance');
		// The next real read must baseline on 20.00, proving the stale response
		// never entered the accumulator (it would otherwise turn ¥1.00 into a
		// spurious multi-unit charge or swallow the real drawdown).
		account.getBalance = immediateGetBalance;
		account.balance = remoteReady([wallet('CNY', '19.00')]);
		tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
		assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥19.00', 'only the real ¥1.00 drawdown is measured');
		chipOf(tree).props.onClick();
		const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
		assert.deepEqual(parts.account, [[ACCOUNT_HEAD_ZH, '-¥1.00']], 'the stale response invented no charge');
	} finally {
		account.getBalance = immediateGetBalance;
	}
});

await checkAsync('client: a signed-out read resets the baseline (D5)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = { ok: true, value: null }; // signed out
	let tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 未登录账号', 'the signed-out read degrades the chip');
	account.balance = remoteReady([wallet('CNY', '8.00')]);
	tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 余额 ¥8.00', 'the next ready read re-baselines');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: ONE_YUAN_SPLIT })));
	assert.equal(parts.account, null, 'no charge is claimed across the signed-out gap');
});

await checkAsync('client: the account section keeps its place between periods and balance (D5)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: ZERO_SPLIT });
	account.balance = remoteReady([wallet('CNY', '9.34')]);
	const tree = await tickRefresh({ split: SPLIT });
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: SPLIT })));
	assert.deepEqual(parts.order, [
		'top',
		'section:高峰时段（×2）',
		'section:空闲时段（×1）',
		'account',
		'note',
		'balance',
	], 'the account grid and note render after the period sections and before the balance grid');
});

/* ---- mid-session rebase of the other-consumer share ---- */

await checkAsync('client: the other-consumer share rebases to spend since the page opened', async () => {
	// The page opens mid-session with ¥3.00 already spent; the session then grows
	// to ¥4.00 while the shared account falls ¥3.10. Only the ¥1.00 spent since
	// the page opened can be this session's own, so the other-consumer share is
	// ¥2.10 — not the whole ¥3.10 (that would overstate other consumers and hide
	// the ¥1.00 this session spent while the page was open).
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: SPLIT });
	let tree = render({ split: SPLIT });
	assert.equal(labelOf(tree), '花费 ¥3.00 · 余额 ¥12.34', 'the mid-session baseline paints');
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	tree = await tickRefresh({ split: FOUR_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥4.00 · 账户 -¥3.10 · 余额 ¥9.24');
	chipOf(tree).props.onClick();
	const parts = partsOf(panelOf(render({ split: FOUR_YUAN_SPLIT })));
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_ZH, '-¥3.10'],
		[ACCOUNT_EXTRA_ZH, '-¥2.10'],
	], 'the ¥2.10 share excludes the ¥3.00 already spent when the page opened');
});

await checkAsync('client: a session-spend decrease cannot inflate the other-consumer row', async () => {
	// The page opens at ¥3.00 spent, then the projection drops to ¥1.00 while the
	// account falls ¥3.10. Without the lower clamp the since-open figure would be
	// -¥2.00 and the row would inflate to -¥5.10; it must stay clamped at the
	// observed -¥3.10 (a negative session delta must never become extra share).
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	await mountLive({ split: SPLIT });
	account.balance = remoteReady([wallet('CNY', '9.24')]);
	const tree = await tickRefresh({ split: ONE_YUAN_SPLIT });
	assert.equal(labelOf(tree), '花费 ¥1.00 · 账户 -¥3.10 · 余额 ¥9.24');
	chipOf(tree).props.onClick();
	const panel = panelOf(render({ split: ONE_YUAN_SPLIT }));
	const parts = partsOf(panel);
	assert.deepEqual(parts.account, [
		[ACCOUNT_HEAD_ZH, '-¥3.10'],
		[ACCOUNT_EXTRA_ZH, '-¥3.10'],
	], 'the decrease is clamped at zero instead of inflating the share');
	assert.equal(textOf(panel).includes('5.10'), false, 'the inflated -¥5.10 never renders');
});

console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nRESULT: failures present' : '\nRESULT: all checks passed');
