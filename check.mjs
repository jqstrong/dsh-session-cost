/**
 * Logic check for the `@local/dsh-session-cost` bundle.
 *
 * Part 1 drives the real Host halves (`index.js` + `host/tree.js`) against
 * mock contexts: the projection unit (peak/off-peak bucketing by event time,
 * retried-step replacement, parity with the shipped `tokenUsage` fold, schema
 * faces) and the v1.2 authenticated session-tree GET route (root/child entries,
 * subagent-ledger and catalog walks, cap/truncation, error envelopes, optional
 * connection composition).
 *
 * Part 2 runs the real Client half (`client.js`) in a Node VM with minimal
 * React/react-dom and DOM stubs, driving the chip through its interaction paths
 * (mount, hover, click, Escape) and asserting the chip text, the per-period
 * panel sections, the account-level charge section, the v1.2 session-tree
 * total/subagent row (with a sandbox `fetch` stub: per-entry model pricing,
 * 20s refresh, latest-wins, unmount abort, silent v1.1 fallback), and every
 * degraded state — including the regression that the displayed spend must NOT
 * change when the wall clock crosses a rate boundary, the v1.1 regression that
 * a shared account's balance drop is shown next to (not instead of) this
 * session's spend, and the latest-request-wins guard for overlapping balance
 * reads. The 60s balance-refresh and 20s tree-refresh intervals are captured,
 * so a test can fire either tick (or leave several reads in flight with a
 * deferred stub) and settle the async read before asserting.
 *
 * This is a numbers-and-branch check, NOT visual verification: it never applies
 * CSS and cannot show what the page looks like.
 *
 * Run: node check.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
	apply as hostApply,
	handleRequest as hostHandleRequest,
	inject as hostInject,
	ROUTE_PATH as HOST_ROUTE_PATH,
} from './index.js';
import { MAX_TREE_SESSIONS, ROUTE_PATH as TREE_ROUTE_PATH, queryTree } from './host/tree.js';

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
/* Part 1b — Host session-tree route (v1.2)                             */
/* ==================================================================== */

/** Empty provider-reported buckets (host-side copy for this section). */
const zeroHostBuckets = () => ({
	uncachedInputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
});

/** One `sessionCost` wire view built from partial bucket sets. */
const costView = (peak = {}, off = {}) => ({
	peak: { ...zeroHostBuckets(), ...peak },
	off: { ...zeroHostBuckets(), ...off },
});

/** One fake WHATWG request for `handleRequest`. */
const hostRequest = (url, method = 'GET', signal = undefined) => ({ url, method, signal });

/** One `sessionQuery.observeSession` observation stub that counts its disposal. */
function observationStub(values, disposed) {
	return {
		projections: { values },
		[Symbol.dispose]() {
			disposed.count += 1;
		},
	};
}

/**
 * Mock Host plugin context: lazy `get(name)` services, an `effect` collector,
 * a projection registry, and a selectable `inject` behavior.
 * @param options - `services` map, optional `connection`, and `inject` mode
 *   (`'ctx'` invokes the callback with this context, `'deferred'` never invokes
 *   it, `'throw'` throws, `'none'` leaves `inject` undefined).
 * @returns `{ ctx, state }`; `state` records the unit, effects and warnings.
 */
function mockHostContext({ services = {}, connection = undefined, inject = 'ctx' } = {}) {
	const state = { unit: undefined, effects: [], warnings: [], injected: [] };
	const ctx = {
		logger: { warn: (message) => state.warnings.push(message) },
		get: (name) => services[name],
		sessionProjections: {
			register: (definition) => {
				state.unit = definition;
				return () => {};
			},
		},
		effect: (fn, label) => {
			const cleanup = fn();
			state.effects.push({ label, cleanup });
			return () => {
				if (typeof cleanup === 'function') cleanup();
			};
		},
	};
	if (connection !== undefined) ctx.connection = connection;
	if (inject === 'ctx') {
		ctx.inject = (names, callback) => {
			state.injected.push([...names]);
			callback(ctx);
		};
	} else if (inject === 'deferred') {
		ctx.inject = (names) => {
			state.injected.push([...names]);
		};
	} else if (inject === 'throw') {
		ctx.inject = () => {
			throw new Error('no connection seat');
		};
	}
	return { ctx, state };
}

check('host: the tree module exposes the documented v1.2 interface', () => {
	assert.equal(HOST_ROUTE_PATH, '/api/plugin/session-cost', 'the route path is the documented one');
	assert.equal(TREE_ROUTE_PATH, HOST_ROUTE_PATH, 'index.js re-exports the tree route path');
	assert.equal(MAX_TREE_SESSIONS, 40, 'one tree query inspects at most 40 sessions');
	assert.equal(typeof hostHandleRequest, 'function', 'index.js exports the route handler');
	assert.equal(typeof queryTree, 'function', 'host/tree.js exports the query');
});

await checkAsync('host: queryTree returns error envelopes instead of throwing', async () => {
	for (const [ctx, sessionId, code] of [
		[{}, 'bad id!', 'invalid-session-id'],
		[{}, '', 'invalid-session-id'],
		[{}, 'root-1', 'tree-unavailable'],
		[{ get: () => undefined }, 'root-1', 'tree-unavailable'],
	]) {
		const result = await queryTree(ctx, sessionId);
		assert.equal(result.ok, false, `${code}: no success envelope`);
		assert.equal(result.error.code, code);
	}
});

await checkAsync('host: apply installs the tree GET route through the connection seat', async () => {
	const registered = [];
	const disposers = [];
	const connection = {
		fetch: {
			register: (definition) => {
				registered.push(definition);
				const disposer = () => {
					definition.disposed = true;
				};
				disposers.push(disposer);
				return disposer;
			},
		},
	};
	const { ctx, state } = mockHostContext({ connection });
	hostApply(ctx);
	assert.ok(state.unit !== undefined, 'the projection unit is still registered');
	assert.deepEqual(state.injected, [['connection']], 'the route waits for the connection service');
	assert.equal(registered.length, 1, 'one route is registered');
	assert.equal(registered[0].path, '/api/plugin/session-cost');
	assert.deepEqual(registered[0].methods, ['GET']);
	assert.equal(registered[0].requestBody, 'buffered');
	assert.equal(typeof registered[0].fetch, 'function', 'the route carries the request handler');
	assert.equal(state.effects.length, 1, 'the route lives in one ctx.effect');
	assert.match(state.effects[0].label, /GET \/api\/plugin\/session-cost/u);
	assert.equal(state.effects[0].cleanup, disposers[0], 'the register disposer is owned by the effect');
	// The route handler really delegates to handleRequest: an invalid request
	// still yields the documented 400 envelope.
	const response = await registered[0].fetch(hostRequest('http://localhost/api/plugin/session-cost'));
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error.code, 'invalid-session-id');
	state.effects[0].cleanup();
	assert.equal(registered[0].disposed, true, 'disposal unregisters the route');
});

/** Root + two children behind a `subagents.listDescendants` ledger. */
function treeServicesFixture() {
	const disposed = { count: 0 };
	const calls = [];
	const observations = {
		'root-1': observationStub({
			sessionCost: costView({ uncachedInputTokens: 1_000_000 }, { cacheReadTokens: 10_000_000, outputTokens: 100_000 }),
			modelSelection: { lastUsed: { model: 'deepseek-flash' } },
		}, disposed),
		'child-1': observationStub({
			sessionCost: costView({ uncachedInputTokens: 2_000_000 }, { outputTokens: 50_000 }),
			modelSelection: { lastUsed: { model: 'deepseek-v4-pro' } },
		}, disposed),
		'child-2': observationStub({
			sessionCost: costView({}, { uncachedInputTokens: 3_000_000 }),
			modelSelection: { next: { model: 'deepseek-flash' } },
		}, disposed),
	};
	const sessionQuery = {
		observeSession: async (id, options) => {
			calls.push({ id, options });
			const observation = observations[id];
			if (observation === undefined) throw new Error(`unknown session ${id}`);
			return observation;
		},
	};
	const listCalls = [];
	const subagents = {
		listDescendants: async (rootId, signal) => {
			listCalls.push({ rootId, signal });
			return [
				{ kind: 'child', id: 'child-1', parentId: 'root-1', depth: 1, mode: 'subagent', label: 'billing-auditor', activity: 'idle' },
				{ kind: 'diagnostic', id: 'ignored', parentId: 'root-1', depth: 1 },
				{ kind: 'child', id: 'child-2', parentId: 'root-1', depth: 1, mode: 'subagent', label: 'test-author', activity: 'busy' },
			];
		},
	};
	return { disposed, calls, listCalls, services: { sessionQuery, subagents } };
}

await checkAsync('host: the tree route returns root and subagent entries', async () => {
	const { disposed, calls, listCalls, services } = treeServicesFixture();
	const signal = { aborted: false };
	const { ctx } = mockHostContext({ services });
	const response = await hostHandleRequest(
		ctx,
		hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1', 'GET', signal),
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.value.truncated, false);
	assert.deepEqual(body.value.root, {
		id: 'root-1',
		parentId: null,
		depth: 0,
		mode: 'main',
		label: null,
		activity: null,
		model: 'deepseek-flash',
		split: {
			peak: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			off: { uncachedInputTokens: 0, cacheReadTokens: 10_000_000, cacheWriteTokens: 0, outputTokens: 100_000 },
		},
	});
	assert.deepEqual(body.value.children, [
		{
			id: 'child-1',
			parentId: 'root-1',
			depth: 1,
			mode: 'subagent',
			label: 'billing-auditor',
			activity: 'idle',
			model: 'deepseek-v4-pro',
			split: {
				peak: { uncachedInputTokens: 2_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
				off: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50_000 },
			},
		},
		{
			id: 'child-2',
			parentId: 'root-1',
			depth: 1,
			mode: 'subagent',
			label: 'test-author',
			activity: 'busy',
			model: 'deepseek-flash',
			split: {
				peak: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
				off: { uncachedInputTokens: 3_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			},
		},
	], 'diagnostic ledger rows are ignored');
	assert.deepEqual(listCalls, [{ rootId: 'root-1', signal }], 'the ledger walk gets the root id and signal');
	assert.deepEqual(calls.map(({ id }) => id), ['root-1', 'child-1', 'child-2'], 'only real sessions are observed');
	assert.deepEqual(calls[1].options, { signal }, 'the request signal is forwarded to observations');
	assert.equal(disposed.count, 3, 'every observation is disposed');
});

/** Root + child + grandchild observable only through `subagentCatalog`. */
function catalogFixture(subagents) {
	const disposed = { count: 0 };
	const observations = {
		'root-1': observationStub({
			sessionCost: costView({}, { uncachedInputTokens: 1_000_000 }),
			modelSelection: { lastUsed: { model: 'deepseek-flash' } },
			subagentCatalog: [{ id: 'child-1', mode: 'subagent', label: 'billing-auditor' }],
		}, disposed),
		'child-1': observationStub({
			sessionCost: costView({ uncachedInputTokens: 1_000_000 }, {}),
			modelSelection: { lastUsed: { model: 'deepseek-v4-pro' } },
			subagentCatalog: [{ id: 'grandchild-1', mode: 'subagent', label: 'verifier' }],
		}, disposed),
		'grandchild-1': observationStub({
			sessionCost: costView({}, { outputTokens: 10_000 }),
			modelSelection: {},
		}, disposed),
	};
	const sessionQuery = {
		observeSession: async (id) => {
			const observation = observations[id];
			if (observation === undefined) throw new Error(`unknown session ${id}`);
			return observation;
		},
	};
	const services = { sessionQuery };
	if (subagents !== undefined) services.subagents = subagents;
	return { disposed, services };
}

await checkAsync('host: the tree falls back to the subagent catalog', async () => {
	for (const subagents of [
		undefined, // no subagents service at all
		{ listDescendants: async () => { throw new Error('ledger unavailable'); } }, // broken walk
	]) {
		const { disposed, services } = catalogFixture(subagents);
		const { ctx } = mockHostContext({ services });
		const response = await hostHandleRequest(
			ctx,
			hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1'),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.deepEqual(body.value.children.map((entry) => [entry.id, entry.parentId, entry.depth, entry.label]), [
			['child-1', 'root-1', 1, 'billing-auditor'],
			['grandchild-1', 'child-1', 2, 'verifier'],
		], 'the catalog walk is recursive and keeps parent/depth');
		assert.equal(body.value.children[0].model, 'deepseek-v4-pro');
		assert.equal(body.value.children[1].model, null, 'a missing modelSelection stays null');
		assert.equal(body.value.root.model, 'deepseek-flash');
		assert.equal(disposed.count, 3, 'every observation is disposed');
	}
});

await checkAsync('host: the tree caps at MAX_TREE_SESSIONS and skips unreadable children', async () => {
	const disposed = { count: 0 };
	const rows = [];
	const observations = new Map();
	observations.set('root-1', observationStub({ sessionCost: costView(), modelSelection: {} }, disposed));
	for (let index = 0; index < MAX_TREE_SESSIONS + 5; index += 1) {
		const id = `child-${index}`;
		rows.push({ kind: 'child', id, parentId: 'root-1', depth: 1, mode: 'subagent', label: id, activity: null });
		if (index === 2) continue; // observation rejects: the child is skipped
		if (index === 5) {
			observations.set(id, observationStub({ modelSelection: {} }, disposed)); // no sessionCost: skipped
			continue;
		}
		observations.set(id, observationStub({
			sessionCost: costView({}, { uncachedInputTokens: 1 }),
			modelSelection: { lastUsed: { model: 'deepseek-flash' } },
		}, disposed));
	}
	let observed = 0;
	const sessionQuery = {
		observeSession: async (id) => {
			observed += 1;
			const observation = observations.get(id);
			if (observation === undefined) throw new Error(`unknown session ${id}`);
			return observation;
		},
	};
	const services = {
		sessionQuery,
		subagents: { listDescendants: async () => rows },
	};
	const { ctx } = mockHostContext({ services });
	const response = await hostHandleRequest(
		ctx,
		hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1'),
	);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.value.truncated, true, 'hitting the cap marks the tree truncated');
	assert.equal(body.value.children.length, MAX_TREE_SESSIONS - 3, 'root plus two unusable children are excluded');
	assert.equal(observed, MAX_TREE_SESSIONS, 'the cap bounds the number of observations');
	assert.equal(disposed.count, MAX_TREE_SESSIONS - 1, 'every opened observation is disposed');
});

await checkAsync('host: tree-route failures map to the documented status codes', async () => {
	const notFound = {
		sessionQuery: {
			observeSession: async () => {
				throw new Error('unknown session');
			},
		},
	};
	const { ctx } = mockHostContext({ services: notFound });
	const expectError = async (response, status, code) => {
		assert.equal(response.status, status);
		const body = await response.json();
		assert.equal(body.ok, false);
		assert.equal(body.error.code, code);
	};
	await expectError(
		await hostHandleRequest(ctx, hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1', 'POST')),
		405,
		'method-not-allowed',
	);
	await expectError(await hostHandleRequest(ctx, hostRequest('not a url')), 400, 'invalid-url');
	for (const url of [
		'http://localhost/api/plugin/session-cost',
		'http://localhost/api/plugin/session-cost?sessionId=',
		'http://localhost/api/plugin/session-cost?sessionId=bad%20id%21',
		`http://localhost/api/plugin/session-cost?sessionId=${'a'.repeat(101)}`,
	]) {
		await expectError(await hostHandleRequest(ctx, hostRequest(url)), 400, 'invalid-session-id');
	}
	await expectError(
		await hostHandleRequest(
			mockHostContext({ services: {} }).ctx,
			hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1'),
		),
		200,
		'tree-unavailable',
	);
	await expectError(
		await hostHandleRequest(
			ctx,
			hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1'),
		),
		200,
		'session-not-found',
	);
	// An unexpected throw becomes an opaque 500 and is logged.
	const broken = {
		sessionQuery: {
			observeSession: async () => ({
				get projections() {
					throw new Error('projection exploded');
				},
				[Symbol.dispose]() {},
			}),
		},
	};
	const brokenContext = mockHostContext({ services: broken });
	await expectError(
		await hostHandleRequest(
			brokenContext.ctx,
			hostRequest('http://localhost/api/plugin/session-cost?sessionId=root-1'),
		),
		500,
		'internal-error',
	);
	assert.equal(brokenContext.state.warnings.length, 1, 'the internal failure is logged once');
	assert.match(brokenContext.state.warnings[0], /unhandled host failure/u);
});

check('host: a composition without a connection seat still registers the projection unit', () => {
	// No inject seat at all.
	let { ctx, state } = mockHostContext({ inject: 'none' });
	assert.doesNotThrow(() => hostApply(ctx));
	assert.ok(state.unit !== undefined, 'the projection unit registers');
	assert.equal(state.effects.length, 0, 'no route effect without a connection');
	// The connection service never becomes available.
	({ ctx, state } = mockHostContext({ inject: 'deferred' }));
	assert.doesNotThrow(() => hostApply(ctx));
	assert.ok(state.unit !== undefined);
	assert.equal(state.effects.length, 0);
	// The inject call itself throws: fall back to the direct, missing connection.
	({ ctx, state } = mockHostContext({ inject: 'throw' }));
	assert.doesNotThrow(() => hostApply(ctx));
	assert.ok(state.unit !== undefined);
	assert.equal(state.effects.length, 0);
	// A connection without fetch.register is not a route composition either.
	({ ctx, state } = mockHostContext({ connection: { fetch: {} } }));
	assert.doesNotThrow(() => hostApply(ctx));
	assert.ok(state.unit !== undefined);
	assert.equal(state.effects.length, 0);
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

/**
 * Whether a state value is the component's balance state. v1.2 adds a
 * `treeCost` state that also carries a `status` field (`{status, value?}`), so
 * the balance slot is identified by its status vocabulary plus the absence of a
 * `value` payload; the balance hook is the component's first state slot.
 */
function isBalanceState(value) {
	if (value === null || typeof value !== 'object' || typeof value.status !== 'string') return false;
	return !('value' in value) && !('truncated' in value);
}

const react = {
	Fragment: Symbol('Fragment'),
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	useState: (init) => {
		const index = slotIndex;
		slotIndex += 1;
		if (!(index in slots)) {
			let value = typeof init === 'function' ? init() : init;
			/* The balance state starts at `{status:'loading'}`; the tree state never
			   uses that status, so the mount seed cannot land on the wrong slot. */
			if (stateSeed !== null && value !== null && typeof value === 'object' && value.status === 'loading') {
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
	baseURI: 'http://localhost/',
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

/**
 * Recording `AbortController` stand-in. The client creates one per tree fetch
 * and aborts it when a newer refresh starts or on unmount; the checks assert
 * that contract through `instances`.
 */
class RecordingAbortController {
	static instances = [];
	constructor() {
		this.signal = { aborted: false };
		this.aborted = false;
		RecordingAbortController.instances.push(this);
	}
	abort() {
		this.aborted = true;
		this.signal.aborted = true;
	}
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
	URL,
	AbortController: RecordingAbortController,
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
function props({
	split = SPLIT,
	usage = USAGE,
	model = 'deepseek-flash',
	locale = 'zh',
	now = OFF_PEAK_NOW,
	sessionId = undefined,
} = {}) {
	sandbox.Date = fakeDate(now);
	return {
		sessionId,
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
	RecordingAbortController.instances.length = 0;
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

/**
 * The component's live balance state. v1.2 also keeps a `treeCost` state with a
 * `status` field, so this keys on the first hook slot, which the component
 * documents as the balance state.
 */
function balanceStateOf() {
	const state = slots[0];
	assert.ok(isBalanceState(state), 'the component keeps the balance state in its first hook slot');
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
 * Fire the recorded 20s session-tree refresh interval `count` times without
 * settling any fetch; used by the tree latest-request-wins test.
 */
function fireTreeTicks(count = 1) {
	const active = intervals.filter((entry) => entry.cleared === false && entry.ms === 20000);
	assert.ok(active.length > 0, 'the component registered a 20s tree-refresh interval');
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

/* ---- session tree (v1.2) ---- */

/** One entry split with the empty buckets filled in. */
const splitView = (peak = {}, off = {}) => ({
	peak: { ...ZERO_BUCKETS, ...peak },
	off: { ...ZERO_BUCKETS, ...off },
});

/** One subagent tree entry. */
const treeEntry = (id, split, model = 'deepseek-flash', extra = {}) => ({
	id,
	parentId: 'root-1',
	depth: 1,
	mode: 'subagent',
	label: id,
	activity: 'idle',
	model,
	split,
	...extra,
});

/**
 * Tree fixture: root ¥1.57 + children ¥2.06 = ¥3.63, every entry on the flash
 * row. Root: 4.25M peak cache-hit (¥0.17) + 1M off miss (¥1.00) + 100k off
 * output (¥0.40); children: ¥0.50 + ¥1.00 + ¥0.56.
 */
const TREE_VALUE = {
	root: {
		id: 'root-1',
		parentId: null,
		depth: 0,
		mode: 'main',
		label: null,
		activity: null,
		model: 'deepseek-flash',
		split: splitView({ cacheReadTokens: 4_250_000 }, { uncachedInputTokens: 1_000_000, outputTokens: 100_000 }),
	},
	children: [
		treeEntry('billing-auditor', splitView({}, { uncachedInputTokens: 500_000 }), 'deepseek-flash', { label: 'billing-auditor' }),
		treeEntry('test-author', splitView({ uncachedInputTokens: 500_000 }, {}), 'deepseek-flash', { label: 'test-author' }),
		treeEntry('verifier', splitView({}, { outputTokens: 140_000 }), 'deepseek-flash', { label: 'verifier' }),
	],
	truncated: false,
};

/** Refreshed tree: root ¥2.00 + the same ¥2.06 of children = ¥4.06. */
const REFRESHED_TREE_VALUE = {
	root: { ...TREE_VALUE.root, split: splitView({}, { uncachedInputTokens: 2_000_000 }) },
	children: TREE_VALUE.children,
	truncated: false,
};

/** A stale root-only answer: ¥3.00 and no children, so it is visibly different. */
const STALE_TREE_VALUE = {
	root: { ...TREE_VALUE.root, split: splitView({}, { uncachedInputTokens: 3_000_000 }) },
	children: [],
	truncated: false,
};

/** One pro-model child: 1M peak cache-miss at the pro row = ¥9.00, not ¥2.00. */
const PRO_TREE_VALUE = {
	root: { ...TREE_VALUE.root, split: splitView() },
	children: [treeEntry('child-pro', splitView({ uncachedInputTokens: 1_000_000 }), 'deepseek-v4-pro')],
	truncated: false,
};

/** A JSON `Response` carrying one tree envelope. */
const treeResponse = (value, status = 200) => new Response(
	JSON.stringify({ ok: true, value }),
	{ status, headers: { 'content-type': 'application/json' } },
);

/**
 * Install a tree `fetch` stub into the VM sandbox.
 * @param handler - receives the 1-based call number; returns a Response or a
 *   promise for one (deferred tests keep the promise for later resolution).
 * @returns the recorded call list; the caller must `delete sandbox.fetch`.
 */
function stubTreeFetch(handler) {
	const calls = [];
	sandbox.fetch = (url, options) => {
		calls.push({ url: String(url), options });
		return Promise.resolve(handler(calls.length));
	};
	return calls;
}

await checkAsync('client: a ready session tree sums root and subagent spend (v1.2)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	const calls = stubTreeFetch(() => treeResponse(TREE_VALUE));
	try {
		await mountLive({ split: ZERO_SPLIT, sessionId: 'root-1' });
		const tree = render({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(labelOf(tree), '花费 ¥3.63 · 余额 ¥12.34', 'the tree total replaces the root-only total');
		assert.equal(calls.length, 1, 'one tree fetch on mount');
		const url = new URL(calls[0].url);
		assert.equal(url.origin, 'http://localhost', 'the route is same-origin to document.baseURI');
		assert.equal(url.pathname, '/api/plugin/session-cost');
		assert.equal(url.searchParams.get('sessionId'), 'root-1');
		assert.equal(calls[0].options.method, 'GET');
		assert.equal(calls[0].options.credentials, 'same-origin');
		chipOf(tree).props.onClick();
		const parts = partsOf(panelOf(render({ split: ZERO_SPLIT, sessionId: 'root-1' })));
		assert.deepEqual(parts.top, [
			['计价模型', 'deepseek-flash'],
			['计价口径', '按每笔用量发生的时段（高峰 ×2）'],
			['子代理会话（3 个）', '¥2.06'],
		], 'the top grid names the subagent share');
		assert.equal(parts.sections[0].head, '高峰时段（×2）');
		assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存未命中'), '500,000 tok ¥1.00');
		assert.equal(pairValue(parts.sections[0].rows, '输入 · 缓存命中'), '4,250,000 tok ¥0.17');
		assert.equal(parts.sections[1].head, '空闲时段（×1）');
		assert.equal(pairValue(parts.sections[1].rows, '输入 · 缓存未命中'), '1,500,000 tok ¥1.50');
		assert.equal(pairValue(parts.sections[1].rows, '输出'), '240,000 tok ¥0.96');
	} finally {
		delete sandbox.fetch;
	}
});

await checkAsync('client: subagent entries are priced with their own model row (v1.2)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	stubTreeFetch(() => treeResponse(PRO_TREE_VALUE));
	try {
		await mountLive({ split: ZERO_SPLIT, sessionId: 'root-1' });
		const tree = render({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(
			labelOf(tree),
			'花费 ¥9.00 · 余额 ¥12.34',
			'the pro child uses the pro peak row, not the display flash row (¥2.00)',
		);
		chipOf(tree).props.onClick();
		const parts = partsOf(panelOf(render({ split: ZERO_SPLIT, sessionId: 'root-1' })));
		assert.deepEqual(parts.top[2], ['子代理会话（1 个）', '¥9.00']);
	} finally {
		delete sandbox.fetch;
	}
});

await checkAsync('client: tree fetch failures fall back to the v1.1 session-only figure (v1.2)', async () => {
	const rejections = [];
	const onRejection = (reason) => rejections.push(reason);
	process.on('unhandledRejection', onRejection);
	const expectFallback = (label) => {
		const tree = render({ split: SPLIT, sessionId: 'root-1' });
		assert.equal(labelOf(tree), '花费 ¥3.00 · 余额 ¥12.34', label);
		chipOf(tree).props.onClick();
		const parts = partsOf(panelOf(render({ split: SPLIT, sessionId: 'root-1' })));
		assert.deepEqual(parts.top.map(([title]) => title), ['计价模型', '计价口径'], 'no subagent row without a tree');
	};
	try {
		// (a) fetch rejects.
		account.balance = remoteReady([wallet('CNY', '12.34')]);
		sandbox.fetch = () => Promise.reject(new Error('network down'));
		await mountLive({ split: SPLIT, sessionId: 'root-1' });
		expectFallback('a rejected fetch keeps the root-only total');
		// (b) fetch is absent entirely.
		delete sandbox.fetch;
		await mountLive({ split: SPLIT, sessionId: 'root-1' });
		expectFallback('an absent fetch keeps the root-only total');
		// (c) an empty session id never fetches.
		const calls = stubTreeFetch(() => treeResponse(TREE_VALUE));
		await mountLive({ split: SPLIT, sessionId: '' });
		assert.equal(calls.length, 0, 'no tree fetch without a session id');
		expectFallback('an empty session id keeps the root-only total');
		delete sandbox.fetch;
		// (d) an unsuccessful or non-envelope response also degrades silently.
		sandbox.fetch = () => Promise.resolve(new Response('{}', { status: 500 }));
		await mountLive({ split: SPLIT, sessionId: 'root-1' });
		expectFallback('an error response keeps the root-only total');
		sandbox.fetch = () => Promise.resolve(new Response(
			JSON.stringify({ ok: false, error: { code: 'tree-unavailable' } }),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		));
		await mountLive({ split: SPLIT, sessionId: 'root-1' });
		expectFallback('a tree-unavailable envelope keeps the root-only total');
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(rejections, [], 'the client never leaves a fetch rejection unhandled');
	} finally {
		process.off('unhandledRejection', onRejection);
		delete sandbox.fetch;
	}
});

await checkAsync('client: the tree refreshes on the 20s interval (v1.2)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	const payloads = [TREE_VALUE, REFRESHED_TREE_VALUE];
	const calls = stubTreeFetch((index) => treeResponse(payloads[Math.min(index - 1, payloads.length - 1)]));
	try {
		await mountLive({ split: ZERO_SPLIT, sessionId: 'root-1' });
		let tree = render({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(labelOf(tree), '花费 ¥3.63 · 余额 ¥12.34');
		assert.equal(calls.length, 1);
		fireTreeTicks(1);
		await settleAsync();
		assert.equal(calls.length, 2, 'the 20s interval refetches the tree');
		tree = render({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(labelOf(tree), '花费 ¥4.06 · 余额 ¥12.34', 'the refreshed tree wins');
	} finally {
		delete sandbox.fetch;
	}
});

await checkAsync('client: a superseded tree response does not overwrite a newer one (v1.2)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	const pending = [];
	stubTreeFetch(() => new Promise((resolve) => {
		pending.push(resolve);
	}));
	try {
		await mountLive({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(pending.length, 1, 'the mount fetch is in flight');
		pending[0](treeResponse(TREE_VALUE));
		await settleAsync();
		chipOf(render({ split: ZERO_SPLIT, sessionId: 'root-1' }))
			.props.onClick();
		assert.equal(
			labelOf(render({ split: ZERO_SPLIT, sessionId: 'root-1' })),
			'花费 ¥3.63 · 余额 ¥12.34',
			'baseline tree settled',
		);
		fireTreeTicks(2);
		assert.equal(pending.length, 3, 'two overlapping tree reads are in flight');
		pending[2](treeResponse(REFRESHED_TREE_VALUE)); // newer answers first: ¥4.06
		await settleAsync();
		pending[1](treeResponse(STALE_TREE_VALUE)); // older answers last: ¥3.00, no children
		await settleAsync();
		const tree = render({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(labelOf(tree), '花费 ¥4.06 · 余额 ¥12.34', 'the stale tree response is dropped');
		const parts = partsOf(panelOf(render({ split: ZERO_SPLIT, sessionId: 'root-1' })));
		assert.deepEqual(parts.top[2], ['子代理会话（3 个）', '¥2.06'], 'the newer tree keeps its subagent row');
	} finally {
		delete sandbox.fetch;
	}
});

await checkAsync('client: unmount aborts the in-flight tree fetch (v1.2)', async () => {
	account.balance = remoteReady([wallet('CNY', '12.34')]);
	const pending = [];
	stubTreeFetch(() => new Promise((resolve) => {
		pending.push(resolve);
	}));
	try {
		await mountLive({ split: ZERO_SPLIT, sessionId: 'root-1' });
		assert.equal(pending.length, 1, 'the mount fetch is in flight');
		const controller = RecordingAbortController.instances[RecordingAbortController.instances.length - 1];
		assert.equal(controller.aborted, false, 'the tree request starts unaborted');
		resetMountState(); // simulate unmount: runs the effect cleanups
		assert.equal(controller.aborted, true, 'unmount aborts the in-flight request');
		pending[0](treeResponse(TREE_VALUE));
		await settleAsync(); // resolving after unmount must be a no-op, not a crash
		assert.equal(slots.length, 0, 'no component state was mounted again');
	} finally {
		delete sandbox.fetch;
	}
});

console.log(results.join('\n'));
console.log(process.exitCode === 1 ? '\nRESULT: failures present' : '\nRESULT: all checks passed');
