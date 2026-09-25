import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import {
	Array_from,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
	_Map,
} from "../snapshot";

// eslint-disable-next-line scramjet-core/no-globals
Error.stackTraceLimit = 50;

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};

type RewriteFailureMode = "compat" | "passthrough";

const REWRITE_FAILURE_CACHE_LIMIT = 256;
const rewriteFailureCache = new _Map<string, RewriteFailureMode>();

type RewriteSuccessEntry = {
	value: string;
	bytes: number;
};

const REWRITE_SUCCESS_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const REWRITE_SUCCESS_CACHE_MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const REWRITE_SUCCESS_CACHE_MIN_ENTRY_BYTES = 1024;
const rewriteSuccessCache = new _Map<string, RewriteSuccessEntry>();
let rewriteSuccessCacheBytes = 0;

function inputLength(input: string | Uint8Array): number {
	return typeof input === "string" ? input.length : input.byteLength;
}

function hashInput(input: string | Uint8Array): string {
	let hash = 0x811c9dc5;
	if (typeof input === "string") {
		for (let i = 0; i < input.length; i++) {
			const code = input.charCodeAt(i);
			hash ^= code & 0xff;
			hash = Math.imul(hash, 0x01000193);
			hash ^= code >>> 8;
			hash = Math.imul(hash, 0x01000193);
		}
	} else {
		for (let i = 0; i < input.length; i++) {
			hash ^= input[i];
			hash = Math.imul(hash, 0x01000193);
		}
	}
	return (hash >>> 0).toString(16);
}

function rewriteFlagsSignature(
	context: ScramjetContext,
	meta: URLMeta
): string {
	let signature = "";
	for (const flag of Object_keys(context.config.flags)) {
		signature += flagEnabled(flag as any, context, meta.base) ? "1" : "0";
	}
	return signature;
}

function makeRewriteSuccessKey(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean,
	cacheValidator?: string | null
): string {
	return [
		isModule ? "m" : "s",
		source || "(unknown)",
		context.prefix.pathname,
		meta.base.href,
		rewriteFlagsSignature(context, meta),
		inputLength(input),
		cacheValidator ? "v:" + cacheValidator : "h:" + hashInput(input),
	].join("|");
}

function getCachedRewrite(key: string): string | null {
	const entry = rewriteSuccessCache.get(key);
	if (!entry) return null;

	// Refresh insertion order so this behaves like a small LRU. Cached JS is
	// stored as an immutable string, so a hit does not clone megabytes of bytes.
	rewriteSuccessCache.delete(key);
	rewriteSuccessCache.set(key, entry);

	return entry.value;
}

function rememberSuccessfulRewrite(
	key: string,
	value: string | Uint8Array
): void {
	// JavaScript source is UTF-8 text. Decode byte output once on the cold path
	// so warm cache hits can return an immutable string without allocating or
	// copying a second multi-megabyte buffer.
	const stored =
		typeof value === "string" ? value : TextDecoder_decode(value);
	const bytes = stored.length * 2;
	if (
		bytes < REWRITE_SUCCESS_CACHE_MIN_ENTRY_BYTES ||
		bytes > REWRITE_SUCCESS_CACHE_MAX_ENTRY_BYTES
	) {
		return;
	}

	const existing = rewriteSuccessCache.get(key);
	if (existing) {
		rewriteSuccessCacheBytes -= existing.bytes;
		rewriteSuccessCache.delete(key);
	}

	rewriteSuccessCache.set(key, { value: stored, bytes });
	rewriteSuccessCacheBytes += bytes;

	while (
		rewriteSuccessCacheBytes > REWRITE_SUCCESS_CACHE_MAX_BYTES &&
		rewriteSuccessCache.size > 0
	) {
		const oldestKey = rewriteSuccessCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = rewriteSuccessCache.get(oldestKey);
		rewriteSuccessCache.delete(oldestKey);
		if (oldest) rewriteSuccessCacheBytes -= oldest.bytes;
	}
}

function makeRewriteFingerprint(
	input: string | Uint8Array,
	source: string | null,
	isModule: boolean
): string {
	const length = typeof input === "string" ? input.length : input.byteLength;
	let head = "";
	let tail = "";

	if (typeof input === "string") {
		head = input.slice(0, 64);
		tail = input.slice(-64);
	} else {
		const encodeEdge = (start: number, end: number) => {
			let out = "";
			for (let i = start; i < end; i++) {
				out += input[i].toString(16).padStart(2, "0");
			}
			return out;
		};
		head = encodeEdge(0, Math.min(24, input.length));
		tail = encodeEdge(Math.max(0, input.length - 24), input.length);
	}

	return `${isModule ? "m" : "s"}:${source || "(unknown)"}:${length}:${head}:${tail}`;
}

function rememberRewriteFailure(key: string, mode: RewriteFailureMode) {
	if (!rewriteFailureCache.has(key) && rewriteFailureCache.size >= REWRITE_FAILURE_CACHE_LIMIT) {
		const oldest = rewriteFailureCache.keys().next().value;
		if (oldest !== undefined) rewriteFailureCache.delete(oldest);
	}
	rewriteFailureCache.set(key, mode);
}

function previewJs(input: string | Uint8Array): string {
	const limit = 512;
	if (typeof input === "string") {
		return input.length > limit ? input.slice(0, limit) + "…" : input;
	}
	const slice = input.subarray(0, Math.min(limit, input.length));
	const decoded = TextDecoder_decode(slice);
	return input.length > limit ? decoded + "…" : decoded;
}

function rewriteJsCompatibility(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): string | Uint8Array {
	return rewriteJsWasm(js, url, context, meta, isModule, {
		destructureRewrites: false,
		captureErrors: false,
		scramitize: false,
		sourcemaps: false,
	}).js;
}
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean,
	flagOverrides?: Record<string, boolean>
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}
	if (flagOverrides) {
		for (const flag of Object_keys(flagOverrides)) {
			flagsobj[flag] = flagOverrides[flag];
		}
	}

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false,
	cacheValidator?: string | null
): string | Uint8Array {
	const failureKey = makeRewriteFingerprint(js, url, isModule);
	const knownFailure = rewriteFailureCache.get(failureKey);
	const successCacheEnabled =
		inputLength(js) >= REWRITE_SUCCESS_CACHE_MIN_ENTRY_BYTES &&
		!flagEnabled("sourcemaps", context, meta.base);
	const successKey = successCacheEnabled
		? makeRewriteSuccessKey(
				js,
				url,
				context,
				meta,
				isModule,
				cacheValidator
			)
		: null;

	if (successKey) {
		const cached = getCachedRewrite(successKey);
		if (cached !== null) return cached;
	}

	if (knownFailure === "passthrough" && flagEnabled("allowInvalidJs", context, meta.base)) {
		return js;
	}

	if (knownFailure === "compat") {
		try {
			const compat = rewriteJsCompatibility(
				js,
				url,
				context,
				meta,
				isModule
			);
			if (successKey) rememberSuccessfulRewrite(successKey, compat);
			return compat;
		} catch {
			if (flagEnabled("allowInvalidJs", context, meta.base)) {
				rememberRewriteFailure(failureKey, "passthrough");
				return js;
			}
		}
	}

	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base) && res.map) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${newjs}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		if (successKey) rememberSuccessfulRewrite(successKey, newjs);
		return newjs;
	} catch (err) {
		const firstError = err as Error;
		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			firstError.message,
			`length=${typeof js === "string" ? js.length : js.byteLength}`,
			previewJs(js)
		);

		// Compatibility retry: a number of large/minified applications trip
		// experimental transforms even though the underlying JS is valid.
		// Retry once with the highest-risk transforms disabled before falling
		// back to the original source.
		try {
			const retry = rewriteJsCompatibility(js, url, context, meta, isModule);
			rememberRewriteFailure(failureKey, "compat");
			if (flagEnabled("rewriterLogs", context, meta.base)) {
				dbg.warn("compatibility rewrite succeeded for", url || "(unknown)");
			}
			if (successKey) rememberSuccessfulRewrite(successKey, retry);
			return retry;
		} catch (retryErr) {
			const secondError = retryErr as Error;
			dbg.warn(
				"compatibility rewrite also failed for",
				url || "(unknown)",
				secondError.message
			);
		}

		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			rememberRewriteFailure(failureKey, "passthrough");
			return js;
		}
		throw firstError;
	}
}
