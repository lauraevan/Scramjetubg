import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 10000);
const host = "0.0.0.0";

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
	".woff2": "font/woff2"
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

function sendFile(res, filePath) {
	fs.stat(filePath, (statErr, stat) => {
		if (statErr || !stat.isFile()) {
			filePath = path.join(publicDir, "index.html");
		}
		fs.readFile(filePath, (err, data) => {
			if (err) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not found");
				return;
			}
			const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
			res.writeHead(200, {
				"Content-Type": type,
				"Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600"
			});
			res.end(data);
		});
	});
}

const server = http.createServer((req, res) => {
	if (req.url === "/healthz") {
		res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("ok");
		return;
	}
	sendFile(res, safePath(req.url || "/"));
});

wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;

server.on("upgrade", (req, socket, head) => {
	wisp.routeRequest(req, socket, head);
});

server.listen(port, host, () => {
	console.log(`Scramjet Render server listening on http://${host}:${port}`);
});
