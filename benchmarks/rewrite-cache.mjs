import {
	CookieJar,
	defaultConfig,
	rewriteJs,
} from "../packages/core/dist/scramjet_bundled.mjs";

const config = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: false,
		scramitize: false,
		sourcemaps: false,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: true,
		debugSourceURL: false,
		encapsulateWorkers: true,
	},
	siteFlags: {},
};

const context = {
	config,
	prefix: new URL("https://proxy.invalid/~/sj/bench/"),
	cookieJar: new CookieJar(),
	interface: {
		codecEncode: encodeURIComponent,
		codecDecode: decodeURIComponent,
		getInjectScripts: () => [],
		getWorkerInjectScripts: () => "",
	},
};

const pageUrl = new URL("https://www.youtube.com/watch?v=bench");
const meta = {
	origin: pageUrl,
	base: pageUrl,
};

const source =
	"globalThis.__scramjetBench=(globalThis.__scramjetBench||0)+1;\n".repeat(
		18000
	);
const sourceBytes = Buffer.byteLength(source);
const sourceUrl = "https://www.youtube.com/s/player/scramjet-benchmark.js";

const cacheValidator = '"scramjet-benchmark-v1"';

const timed = () => {
	const start = performance.now();
	const output = rewriteJs(
		source,
		sourceUrl,
		context,
		meta,
		false,
		`etag:${cacheValidator}`
	);
	const elapsed = performance.now() - start;
	return { elapsed, output };
};

const cold = timed();
const warmSamples = [];
let last = cold.output;
for (let i = 0; i < 7; i++) {
	const sample = timed();
	warmSamples.push(sample.elapsed);
	last = sample.output;
}

warmSamples.sort((a, b) => a - b);
const warmMedian = warmSamples[Math.floor(warmSamples.length / 2)];
const speedup = cold.elapsed / Math.max(warmMedian, 0.0001);

const outputLength = (value) =>
	typeof value === "string" ? value.length : value.byteLength;

if (outputLength(cold.output) !== outputLength(last)) {
	throw new Error("Cached rewrite output length differs from cold rewrite output");
}

console.log(
	[
		"REWRITE_CACHE_BENCH",
		`source_bytes=${sourceBytes}`,
		`cold_ms=${cold.elapsed.toFixed(3)}`,
		`warm_median_ms=${warmMedian.toFixed(3)}`,
		`speedup=${speedup.toFixed(2)}x`,
		`warm_samples_ms=${warmSamples.map((v) => v.toFixed(3)).join(",")}`,
	].join(" ")
);
