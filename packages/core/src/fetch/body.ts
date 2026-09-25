import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";
import {
	flagEnabled,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import { _TextDecoder } from "@/shared/snapshot";

function isAmbiguousDocumentMimeType(contentType: string): boolean {
	const mime = contentType.split(";", 1)[0].trim().toLowerCase();
	return (
		mime === "" ||
		mime === "text/plain" ||
		mime === "application/octet-stream" ||
		mime === "binary/octet-stream"
	);
}

function looksLikeHtml(content: string): boolean {
	const prefix = content.slice(0, 2048).trimStart().toLowerCase();
	return (
		prefix.startsWith("<!doctype html") ||
		prefix.startsWith("<html") ||
		prefix.startsWith("<head") ||
		prefix.startsWith("<body") ||
		prefix.startsWith("<!--")
	);
}

export async function rewriteBody(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document": {
			const contentType = response.headers.get("content-type") ?? "";
			const declaredHtml = isHtmlMimeType(contentType);
			if (!declaredHtml && !isAmbiguousDocumentMimeType(contentType)) {
				return response.body;
			}

			const buf = await response.arrayBuffer();
			const bytes = new Uint8Array(buf);
			const encoding = sniffEncoding(bytes, contentType);
			const htmlContent = new _TextDecoder(encoding).decode(bytes);

			// Some CDNs and small sites serve HTML with no MIME type, text/plain,
			// or application/octet-stream. Only override those ambiguous types
			// when the payload itself strongly resembles an HTML document.
			if (!declaredHtml && !looksLikeHtml(htmlContent)) {
				return buf;
			}

			return rewriteHtml(htmlContent, handler.context, parsed.meta, {
				loadScripts: true,
				inline: true,
				source: parsed.url.href,
				headers: response.rawHeaders,
				// reasonably confident that a document fetch is impossible without a client
				history: parsed.trackedClient!.history,
			});
		}
		case "script": {
			// do not attempt to rewrite a 404 response
			if (response.ok) {
				const ct = response.headers.get("content-type");
				// don't rewrite invalid module scripts when the server declares a non-JS type
				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}

				let rewritten = rewriteJs(
					new Uint8Array(await response.arrayBuffer()),
					response.url,
					handler.context,
					parsed.meta,
					parsed.isModule
				);

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (rewritten instanceof Uint8Array) {
						rewritten = new TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style":
			return rewriteCss(await response.text(), handler.context, parsed.meta);
		case "sharedworker":
		case "worker":
			return rewriteWorkers(
				new Uint8Array(await response.arrayBuffer()),
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
		default:
			return response.body;
	}
}
