/**
 * Host half of `@local/dsh-session-cost`.
 *
 * Registers one session-projection unit (`sessionCost`) that folds every
 * provider-reported token-usage sample into a **peak-hour** bucket and an
 * **off-peak** bucket according to the timestamp of the session event that
 * reported it. The Client half prices each bucket at the rate in effect when
 * the tokens were spent, so a session that crosses a rate boundary is priced in
 * two parts instead of being repriced as a whole whenever the clock changes.
 *
 * The fold mirrors `@deepseek-ai/dsh-token-meter`'s `tokenUsage` unit exactly —
 * same source events (`assistant/message` / `assistant/attempt`), same
 * "replacement slot" handling of retried steps (`llm/retry-started`), so the
 * two totals always agree — and adds the period dimension on top.
 *
 * The unit is registered through `ctx.sessionProjections` (whole durable log,
 * survives paging and compaction). Its state is plain JSON because the
 * projection cache persists it, and its `stateVersion` gates that cache.
 */

/** Peak window in Beijing time: Monday-Friday 09:00-12:00 and 14:00-18:00. */
const PEAK_MORNING = [9 * 60, 12 * 60];
const PEAK_AFTERNOON = [14 * 60, 18 * 60];

/** Session-projection key this bundle owns. */
const KEY = 'sessionCost';

/** Bump when the state shape or the fold semantics change (persisted-cache invalidation). */
const STATE_VERSION = 1;

/** The four disjoint provider-reported token buckets. */
const BUCKET_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];

/** An empty bucket set. */
function zeroBuckets() {
	return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
}

/** Provider usage → the four buckets, named exactly as `tokenUsage` names them. */
function bucketsFrom(usage) {
	return {
		uncachedInputTokens: usage.inputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		outputTokens: usage.outputTokens,
	};
}

/** Value equality of two bucket sets. */
function bucketsEqual(left, right) {
	return BUCKET_KEYS.every((key) => left[key] === right[key]);
}

/** Add one bucket set into another, returning a new object. */
function bucketsPlus(target, source, sign) {
	const next = { ...target };
	for (const key of BUCKET_KEYS) next[key] += sign * source[key];
	return next;
}

/**
 * Whether the published peak window covers one instant.
 * Chinese public holidays are not modelled; a holiday reads as a peak window.
 * @param epochMs - session event time, Unix epoch milliseconds.
 * @returns true inside a peak window.
 */
function isPeakBeijing(epochMs) {
	const beijing = new Date(epochMs + 8 * 3600 * 1000);
	const weekday = beijing.getUTCDay();
	if (weekday === 0 || weekday === 6) return false;
	const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
	return (minutes >= PEAK_MORNING[0] && minutes < PEAK_MORNING[1])
		|| (minutes >= PEAK_AFTERNOON[0] && minutes < PEAK_AFTERNOON[1]);
}

/** The rate period covering one event timestamp. */
function periodOf(epochMs) {
	return isPeakBeijing(epochMs) ? 'peak' : 'off';
}

/**
 * The usage one durable Assistant settlement reports for its attempt, if any.
 * Mirrors the token-meter helper: the message carries `usage` directly, while a
 * message-less attempt keeps it as the last raw `usage` chunk of its stream.
 * @param event - one committed session event.
 * @returns the provider usage, or undefined when the event reports none.
 */
function usageOf(event) {
	if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
	const stream = event.data.stream;
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index];
		if (record !== null && typeof record === 'object'
			&& record.type === 'chunk'
			&& record.chunk !== null && typeof record.chunk === 'object'
			&& record.chunk.type === 'usage') {
			return record.chunk.usage;
		}
	}
	return undefined;
}

/** Empty unit state: two empty buckets and no open replacement slot. */
function initialState() {
	return { peak: zeroBuckets(), off: zeroBuckets(), last: null };
}

/**
 * Pure transition: fold one committed event into the period buckets.
 *
 * A usage sample replaces the previous sample of the same `turn`/`step` (so a
 * retried attempt is not double counted); the slot remembers which period it
 * was added to, so a replacement removes from that same period.
 * @param state - state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state; the same reference for events the unit ignores.
 */
function fold(state, event) {
	if (event.type === 'llm/retry-started') {
		return state.last !== null
			&& state.last.turn === event.data.turn
			&& state.last.step === event.data.step
			? { ...state, last: null }
			: state;
	}
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;
	const sample = usageOf(event);
	if (sample === undefined) return state;
	const { turn, step } = event.data;
	const buckets = bucketsFrom(sample);
	const period = periodOf(event.time);
	const previous = state.last !== null && state.last.turn === turn && state.last.step === step
		? state.last
		: null;
	if (previous !== null && previous.period === period && bucketsEqual(previous.buckets, buckets)) return state;
	const peak = previous !== null && previous.period === 'peak'
		? bucketsPlus(state.peak, previous.buckets, -1)
		: state.peak;
	const off = previous !== null && previous.period === 'off'
		? bucketsPlus(state.off, previous.buckets, -1)
		: state.off;
	return {
		peak: period === 'peak' ? bucketsPlus(peak, buckets, 1) : peak,
		off: period === 'off' ? bucketsPlus(off, buckets, 1) : off,
		last: { turn, step, period, buckets },
	};
}

/** Throwing check for one bucket set. */
function requireBuckets(value, label) {
	if (value === null || typeof value !== 'object') {
		throw new Error(`session-cost: projection ${label} is not an object`);
	}
	for (const key of BUCKET_KEYS) {
		const amount = value[key];
		if (!Number.isInteger(amount) || amount < 0) {
			throw new Error(`session-cost: projection ${label}.${key} is not a non-negative integer`);
		}
	}
	return value;
}

/** Throwing check for the full unit state (persisted-cache shape). */
function requireState(value) {
	if (value === null || typeof value !== 'object') {
		throw new Error('session-cost: projection state is not an object');
	}
	requireBuckets(value.peak, 'peak');
	requireBuckets(value.off, 'off');
	if (value.last !== null) {
		const last = value.last;
		if (last === null || typeof last !== 'object') {
			throw new Error('session-cost: projection last slot is invalid');
		}
		if (!Number.isInteger(last.turn) || last.turn < 0 || !Number.isInteger(last.step) || last.step < 0) {
			throw new Error('session-cost: projection last slot coordinates are invalid');
		}
		if (last.period !== 'peak' && last.period !== 'off') {
			throw new Error('session-cost: projection last slot period is invalid');
		}
		requireBuckets(last.buckets, 'last.buckets');
	}
	return value;
}

/** Throwing check for the wire view shape. */
function requireView(value) {
	if (value === null || typeof value !== 'object') {
		throw new Error('session-cost: projection view is not an object');
	}
	requireBuckets(value.peak, 'peak');
	requireBuckets(value.off, 'off');
	return value;
}

/** Wrap a throwing validator in the `{ parse, safeParse }` face the registry expects. */
function schemaOf(validate) {
	return {
		parse(value) {
			return validate(value);
		},
		safeParse(value) {
			try {
				return { success: true, data: validate(value) };
			} catch (error) {
				return { success: false, error };
			}
		},
	};
}

const stateSchema = schemaOf(requireState);
const viewSchema = schemaOf(requireView);

/** Memoized wire value: a state change that leaves both bucket sets equal must not publish. */
let publishedView = null;

/**
 * Client view: the two period bucket sets.
 * @param state - current unit state.
 * @returns the whole client value, reusing the published reference when unchanged.
 */
function view(state) {
	if (publishedView !== null
		&& bucketsEqual(publishedView.peak, state.peak)
		&& bucketsEqual(publishedView.off, state.off)) {
		return publishedView;
	}
	publishedView = { peak: { ...state.peak }, off: { ...state.off } };
	return publishedView;
}

/** The projection unit this bundle contributes. */
const unit = {
	key: KEY,
	stateVersion: STATE_VERSION,
	stateSchema,
	init: initialState,
	apply: fold,
	wire: { viewSchema, view },
};

export const inject = ['sessionProjections'];

/**
 * Register the unit on the projection registry.
 * @param ctx - host plugin context carrying `sessionProjections`.
 */
export function apply(ctx) {
	ctx.sessionProjections.register(unit);
}
