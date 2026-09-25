import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 10000);
const host = "0.0.0.0";
const fileCache = new Map();

const mimeTypes = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".map": "application/json; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf"
};

function safePath(urlPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(urlPath.split("?")[0]);
	} catch {
		decoded = "/";
	}
	const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, "");
	const candidate = path.join(publicDir, normalized);
	if (!candidate.startsWith(publicDir)) return path.join(publicDir, "index.html");
	return candidate;
}

function cacheControlFor(filePath) {
	const rel = path.relative(publicDir, filePath).replaceAll("\\", "/");
	if (
		rel === "index.html" ||
		rel === "sw.js" ||
		rel.startsWith("scramjet/") ||
		rel.startsWith("controller/")
	) {
		return "no-cache";
	}
	if (/^assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(rel)) {
		return "public, max-age=31536000, immutable";
	}
	return "public, max-age=300, must-revalidate";
}

function resolveEncoding(req, filePath) {
	const accept = String(req.headers["accept-encoding"] || "");
	if (accept.includes("br") && fs.existsSync(filePath + ".br")) {
		return { path: filePath + ".br", encoding: "br" };
	}
	if (accept.includes("gzip") && fs.existsSync(filePath + ".gz")) {
		return { path: filePath + ".gz", encoding: "gzip" };
	}
	return { path: filePath, encoding: null };
}

function loadFile(filePath) {
	const stat = fs.statSync(filePath);
	const cached = fileCache.get(filePath);
	if (
		cached &&
		cached.size === stat.size &&
		cached.mtimeMs === stat.mtimeMs
	) {
		return cached;
	}
	const data = fs.readFileSync(filePath);
	const entry = {
		data,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
	};
	fileCache.set(filePath, entry);
	return entry;
}

function sendFile(req, res, requestedPath) {
	let filePath = requestedPath;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) throw new Error("not-file");
	} catch {
		filePath = path.join(publicDir, "index.html");
	}

	const originalPath = filePath;
	const chosen = resolveEncoding(req, originalPath);
	let entry;
	try {
		entry = loadFile(chosen.path);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
		return;
	}

	const originalStat = fs.statSync(originalPath);
	const etag = `W/"${originalStat.size.toString(16)}-${Math.floor(originalStat.mtimeMs).toString(16)}"`;
	const headers = {
		"Content-Type":
			mimeTypes[path.extname(originalPath).toLowerCase()] ||
			"application/octet-stream",
		"Cache-Control": cacheControlFor(originalPath),
		"ETag": etag,
		"Vary": "Accept-Encoding",
		"Content-Length": String(entry.data.byteLength)
	};
	if (chosen.encoding) headers["Content-Encoding"] = chosen.encoding;

	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, headers);
		res.end();
		return;
	}

	res.writeHead(200, headers);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	res.end(entry.data);
}

const server = http.createServer((req, res) => {
	if (req.url === "/healthz") {
		res.writeHead(200, {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store"
		});
		res.end("ok");
		return;
	}

	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, {
			"Content-Type": "text/plain; charset=utf-8",
			"Allow": "GET, HEAD"
		});
		res.end("Method not allowed");
		return;
	}

	sendFile(req, res, safePath(req.url || "/"));
});

wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

server.on("upgrade", (req, socket, head) => {
	wisp.routeRequest(req, socket, head);
});

server.listen(port, host, () => {
	console.log(`Scramjet Render server listening on http://${host}:${port}`);
});
