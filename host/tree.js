/**
 * Session-tree spend query for the Host half of `@local/dsh-session-cost`.
 *
 * The plugin's client already shows this session's own token cost. Agent teams
 * and subagents run in **separate durable Sessions** (their header carries
 * `parentSession`), so a conversation's real cost is the sum over its session
 * tree. This module answers that sum from the Host's trusted services:
 *
 * - `ctx.get('sessionQuery')` observes any live or durable session and exposes
 *   the wire value of every registered session projection, including this
 *   bundle's own `sessionCost` unit and the shipped `modelSelection` unit.
 * - `ctx.get('subagents')` walks the catalog of descendant Sessions; when that
 *   service is absent (or its walk fails) the same graph is walked directly
 *   from each parent's `subagentCatalog` projection.
 *
 * The route handler in `index.js` serves the envelope this module returns.
 * Everything here is read-only, bounded by {@link MAX_TREE_SESSIONS}, and
 * disposes every session observation it opens.
 */

/** Exact route path registered inside the Host Connection authentication fence. */
export const ROUTE_PATH = '/api/plugin/session-cost';

/** Maximum number of Sessions (root included) one tree query may inspect. */
export const MAX_TREE_SESSIONS = 40;

/** The four disjoint provider-reported token buckets, exactly as `tokenUsage` names them. */
const BUCKET_KEYS = Object.freeze(['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']);

/** Session-id grammar accepted from the query string. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;

/** Lazily read one optional Host service without letting a missing one throw. */
function serviceOf(ctx, name) {
	if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined;
	try {
		return ctx.get(name);
	} catch {
		return undefined;
	}
}

/** Release a `sessionQuery.observeSession` observation (it is a sync disposable). */
function disposeObservation(observation) {
	if (observation === null || typeof observation !== 'object') return;
	try {
		if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]();
		else if (typeof observation.dispose === 'function') observation.dispose();
	} catch {
		// A failed release of a read-only observation must not fail the request.
	}
}

/** Normalize one bucket set from a projection wire view; null when unusable. */
export function bucketsOf(value) {
	if (value === null || typeof value !== 'object') return null;
	const buckets = {};
	for (const key of BUCKET_KEYS) {
		const amount = value[key];
		if (!Number.isInteger(amount) || amount < 0) return null;
		buckets[key] = amount;
	}
	return buckets;
}

/** The model id a session's `modelSelection` wire view reports, if any. */
function modelOf(values) {
	const selection = values === null || typeof values !== 'object' ? undefined : values.modelSelection;
	if (selection === null || typeof selection !== 'object') return null;
	const model = selection.next?.model ?? selection.lastUsed?.model;
	return typeof model === 'string' && model !== '' ? model : null;
}

/**
 * Project one observed Session into a tree entry.
 *
 * @param observation - a `sessionQuery.observeSession` result.
 * @param meta - identity fields (`id`, `parentId`, `depth`, `mode`, `label`, `activity`).
 * @returns the entry, or null when that session has no usable `sessionCost` view.
 */
export function entryOf(observation, meta) {
	const values = observation?.projections?.values;
	const cost = values === null || typeof values !== 'object' ? undefined : values.sessionCost;
	if (cost === null || typeof cost !== 'object') return null;
	const peak = bucketsOf(cost.peak);
	const off = bucketsOf(cost.off);
	if (peak === null || off === null) return null;
	return {
		id: meta.id,
		parentId: meta.parentId,
		depth: meta.depth,
		mode: meta.mode,
		label: meta.label,
		activity: meta.activity,
		model: modelOf(values),
		split: { peak, off },
	};
}

/** Catalog rows a session reports for its direct subagent children. */
function catalogOf(observation) {
	const catalog = observation?.projections?.values?.subagentCatalog;
	return Array.isArray(catalog) ? catalog : [];
}

/** Children ledger rows exposed by `subagents.listDescendants`. */
async function descendantsOf(ctx, rootId, signal) {
	const subagents = serviceOf(ctx, 'subagents');
	if (subagents === undefined || typeof subagents.listDescendants !== 'function') return null;
	try {
		const rows = await subagents.listDescendants(rootId, signal);
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

/**
 * Query the spend of one session tree.
 *
 * @param ctx - Host plugin context (only lazy optional service lookups are used).
 * @param sessionId - root Session whose tree is requested.
 * @param signal - optional cancellation forwarded to the session services.
 * @returns `{ok:true,value:{root,children,truncated}}` or `{ok:false,error}`.
 */
export async function queryTree(ctx, sessionId, signal) {
	if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
		return { ok: false, error: { code: 'invalid-session-id', message: 'sessionId must be a Session id' } };
	}
	const sessionQuery = serviceOf(ctx, 'sessionQuery');
	if (sessionQuery === undefined || typeof sessionQuery.observeSession !== 'function') {
		return { ok: false, error: { code: 'tree-unavailable', message: 'the session query service is not available' } };
	}

	const observe = async (id) => {
		const observation = await sessionQuery.observeSession(id, signal === undefined ? undefined : { signal });
		return observation;
	};

	/* Root: one observation gives both its cost and the direct-child catalog, so
	   the catalog fallback never needs a second read of the root. */
	let rootObservation;
	try {
		rootObservation = await observe(sessionId);
	} catch {
		return { ok: false, error: { code: 'session-not-found', message: `session "${sessionId}" was not found` } };
	}
	const rootMeta = { id: sessionId, parentId: null, depth: 0, mode: 'main', label: null, activity: null };
	let root = null;
	let rootCatalog = [];
	try {
		root = entryOf(rootObservation, rootMeta);
		rootCatalog = catalogOf(rootObservation);
	} finally {
		disposeObservation(rootObservation);
	}

	const children = [];
	const seen = new Set([sessionId]);
	let truncated = false;

	/* Preferred path: the subagent service knows the whole graph. It may throw
	   when only one of its own prerequisites is missing, which is not a request
	   failure — the catalog walk below is equivalent. */
	const descendants = await descendantsOf(ctx, sessionId, signal);
	if (descendants !== null) {
		const rows = descendants.filter((row) => row !== null && typeof row === 'object' && row.kind !== 'diagnostic');
		for (const row of rows) {
			if (typeof row.id !== 'string' || seen.has(row.id)) continue;
			if (seen.size >= MAX_TREE_SESSIONS) {
				truncated = true;
				break;
			}
			seen.add(row.id);
			const meta = {
				id: row.id,
				parentId: typeof row.parentId === 'string' ? row.parentId : sessionId,
				depth: Number.isInteger(row.depth) && row.depth > 0 ? row.depth : 1,
				mode: typeof row.mode === 'string' ? row.mode : null,
				label: typeof row.label === 'string' ? row.label : null,
				activity: typeof row.activity === 'string' ? row.activity : null,
			};
			let observation;
			try {
				observation = await observe(row.id);
			} catch {
				continue;
			}
			try {
				const entry = entryOf(observation, meta);
				if (entry !== null) children.push(entry);
			} finally {
				disposeObservation(observation);
			}
		}
		return { ok: true, value: { root, children, truncated } };
	}

	/* Fallback: walk `subagentCatalog` from each parent. Breadth-first order keeps
	   the output stable and the cap bounds the number of observations. */
	const queue = [{ id: sessionId, depth: 0, catalog: rootCatalog }];
	while (queue.length > 0) {
		const parent = queue.shift();
		for (const row of parent.catalog) {
			if (row === null || typeof row !== 'object' || typeof row.id !== 'string' || seen.has(row.id)) continue;
			if (seen.size >= MAX_TREE_SESSIONS) {
				truncated = true;
				break;
			}
			seen.add(row.id);
			const meta = {
				id: row.id,
				parentId: parent.id,
				depth: parent.depth + 1,
				mode: typeof row.mode === 'string' ? row.mode : null,
				label: typeof row.label === 'string' ? row.label : null,
				activity: null,
			};
			let observation;
			try {
				observation = await observe(row.id);
			} catch {
				continue;
			}
			try {
				const entry = entryOf(observation, meta);
				if (entry !== null) children.push(entry);
				queue.push({ id: row.id, depth: meta.depth, catalog: catalogOf(observation) });
			} finally {
				disposeObservation(observation);
			}
		}
		if (truncated) break;
	}
	return { ok: true, value: { root, children, truncated } };
}
