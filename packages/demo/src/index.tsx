import LoadInterstitial from "./components/LoadInterstitial";
import App from "./App";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import { HttpCachePlugin } from "@mercuryworkshop/scramjet-utils";
import { demoSettingsStore } from "./store";

let app = document.getElementById("app")!;

let controller: InstanceType<typeof Controller>;
const cachePlugin = new HttpCachePlugin();

type RawHeaders = [string, string][];
type WebSocketData = Blob | ArrayBuffer | string;
type TransportResponse = {
	body: ReadableStream | ArrayBuffer | Blob | string;
	headers: RawHeaders;
	status: number;
	statusText: string;
};
type TransportLike = {
	ready: boolean;
	init(): Promise<void>;
	request(
		remote: URL,
		method: string,
		body: any,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransportResponse>;
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketData) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: WebSocketData) => void,
		(code: number, reason: string) => void,
	];
};

class ResilientTransport {
	ready = false;
	private active: TransportLike | null = null;

	constructor(
		private primary: TransportLike,
		private secondary: TransportLike
	) {}

	private async activate(transport: TransportLike) {
		if (!transport.ready) await transport.init();
		this.active = transport;
		this.ready = true;
	}

	async init() {
		if (this.active?.ready) {
			this.ready = true;
			return;
		}

		try {
			await this.activate(this.primary);
			return;
		} catch (primaryError) {
			console.warn(
				"[scramjet] primary transport init failed, trying fallback",
				primaryError
			);
		}

		try {
			await this.activate(this.secondary);
		} catch (secondaryError) {
			this.ready = false;
			throw new Error("Both Scramjet transports failed to initialize", {
				cause: secondaryError,
			});
		}
	}

	private alternate() {
		return this.active === this.primary ? this.secondary : this.primary;
	}

	async request(
		remote: URL,
		method: string,
		body: any,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransportResponse> {
		await this.init();
		const current = this.active!;

		try {
			return await current.request(remote, method, body, headers, signal);
		} catch (firstError) {
			const fallback = this.alternate();
			try {
				await this.activate(fallback);
			} catch {
				throw firstError;
			}

			// Never replay a potentially state-changing request. The fallback
			// becomes active for future requests, but only idempotent requests
			// are retried automatically.
			if (method !== "GET" && method !== "HEAD") {
				throw firstError;
			}

			console.warn(
				"[scramjet] transport request failed, retrying on fallback",
				remote.href
			);
			return fallback.request(remote, method, body, headers, signal);
		}
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketData) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: WebSocketData) => void,
		(code: number, reason: string) => void,
	] {
		const current = this.active!;
		let sendImpl: (data: WebSocketData) => void = () => {};
		let closeImpl: (code: number, reason: string) => void = () => {};
		let opened = false;
		let switching = false;
		let intentionallyClosed = false;

		const start = (transport: TransportLike, allowFallback: boolean) => {
			const fallbackBeforeOpen = async (
				error: string,
				closeInfo?: [number, string]
			) => {
				if (
					opened ||
					switching ||
					intentionallyClosed ||
					!allowFallback
				) {
					if (closeInfo) onclose(...closeInfo);
					else onerror(error);
					return;
				}

				switching = true;
				const fallback =
					transport === this.primary ? this.secondary : this.primary;
				try {
					await this.activate(fallback);
					switching = false;
					start(fallback, false);
				} catch {
					switching = false;
					onerror(error);
				}
			};

			const [send, close] = transport.connect(
				url,
				protocols,
				requestHeaders,
				(protocol, extensions) => {
					opened = true;
					onopen(protocol, extensions);
				},
				onmessage,
				(code, reason) => {
					void fallbackBeforeOpen("transport closed before open", [
						code,
						reason,
					]);
				},
				(error) => {
					void fallbackBeforeOpen(error);
				}
			);

			sendImpl = send;
			closeImpl = close;
		};

		start(current, true);

		return [
			(data) => sendImpl(data),
			(code, reason) => {
				intentionallyClosed = true;
				closeImpl(code, reason);
			},
		];
	}
}

export function getTransport(): ResilientTransport {
	const wispUrl = demoSettingsStore.wispUrl;
	const libcurl = new LibcurlClient({ wisp: wispUrl });
	const epoxy = new EpoxyClient({ wisp: wispUrl });

	if (demoSettingsStore.transport === "epoxy") {
		return new ResilientTransport(epoxy, libcurl);
	}
	return new ResilientTransport(libcurl, epoxy);
}

async function waitForControllerOrReady(timeoutMs = 10000): Promise<void> {
	if (navigator.serviceWorker.controller) return;

	const ready = navigator.serviceWorker.ready.then(() => {});
	const controllerChanged = new Promise<void>((resolve) => {
		const onChange = () => {
			navigator.serviceWorker.removeEventListener("controllerchange", onChange);
			resolve();
		};
		navigator.serviceWorker.addEventListener("controllerchange", onChange, {
			once: true,
		} as any);
	});
	const timeout = new Promise<void>((resolve) =>
		setTimeout(resolve, timeoutMs)
	);

	// Wait for whichever happens first; on timeout we continue to avoid blocking the UI.
	await Promise.race([ready, controllerChanged, timeout]);
}

async function init() {
	const interstitial: any = (
		<LoadInterstitial status={"Loading"}></LoadInterstitial>
	);
	document.body.append(interstitial);
	interstitial.showModal();

	try {
		const registration = await navigator.serviceWorker.register("./sw.js");

		// Non-blocking progress updates on state transitions.
		const updateStatus = (sw: ServiceWorker | null) => {
			if (!sw) return;
			const set = (msg: string) => (interstitial.$.state.status = msg);
			const apply = () => {
				switch (sw.state) {
					case "installing":
						set("Installing service worker...");
						break;
					case "installed":
						set("Service worker installed, waiting to activate...");
						break;
					case "activating":
						set("Activating service worker...");
						break;
					case "activated":
						set("Service worker activated");
						break;
					case "redundant":
						set("Service worker became redundant");
						break;
				}
			};
			apply();
			sw.addEventListener("statechange", apply);
		};

		updateStatus(registration.installing ?? registration.waiting ?? null);

		// Wait for control or readiness with a timeout; don't hang the UI on updates.
		interstitial.$.state.status =
			"Waiting for service worker to take control...";
		await waitForControllerOrReady(10000);
		interstitial.$.state.status =
			"Service worker ready, waiting for controller init";
		const readySw = navigator.serviceWorker.controller ?? registration.active;
		if (!readySw) {
			throw new Error("No service worker available for controller");
		}
		controller = new Controller({
			serviceworker: readySw,
			transport: getTransport(),
			scramjetConfig: defaultConfigDev,
		});
		await controller.wait();
		console.log(controller);
		interstitial.$.state.status = "Controller initialized";
		interstitial.close();
	} catch (e) {
		console.error("Error during service worker registration:", e);
		// Always close the modal on error to prevent hanging UI.
		try {
			interstitial.close();
		} catch {}
		app.innerText =
			"Failed to register service worker. Check console for details.";
	}
}

async function mount() {
	try {
		const root = <App />;
		app.replaceWith(root);
	} catch (e) {
		let err = e as any;
		app.replaceWith(
			document.createTextNode(
				`Error mounting: ${"message" in err ? err.message : err}`
			)
		);
		console.error(err);
		throw e;
	}
}

init().then(() => mount());
export { controller, cachePlugin };
