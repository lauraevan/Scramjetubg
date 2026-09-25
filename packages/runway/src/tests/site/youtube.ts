import { playwrightTest } from "../../testcommon.ts";

export default [
	playwrightTest({
		name: "site-youtube-frontpage",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/");

			// Wait for the YouTube logo to be visible
			const logo = frame.locator("#logo-icon > span > div").first();
			await logo.waitFor({ state: "visible", timeout: 30000 });
		},
	}),

	playwrightTest({
		name: "site-youtube-search",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/results?search_query=bad+apple");

			// Wait for search results to load
			const title = frame.locator("#video-title > yt-formatted-string").first();
			await title.waitFor({ state: "visible", timeout: 30000 });

			const thumbnail = frame.locator(
				"#contents > ytd-video-renderer:nth-child(1) > #dismissible > ytd-thumbnail > a > yt-image > img"
			);
			await thumbnail.waitFor({ state: "visible", timeout: 30000 });
		},
	}),

	playwrightTest({
		name: "site-youtube-player",
		fn: async ({ frame, navigate }) => {
			// Stable public YouTube video used only as a playback smoke test.
			await navigate("https://www.youtube.com/watch?v=jNQXAC9IVRw");

			const video = frame.locator("video.html5-main-video").first();
			await video.waitFor({ state: "attached", timeout: 45000 });

			await video.evaluate(async (node: HTMLVideoElement) => {
				const deadline = Date.now() + 30000;
				while (node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
					if (Date.now() > deadline) {
						throw new Error(
							`YouTube video never received media data (readyState=${node.readyState}, networkState=${node.networkState})`
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			});

			// Use a real click first so Chromium treats this like a user gesture.
			const player = frame.locator("#movie_player").first();
			await player.click({ position: { x: 320, y: 180 }, timeout: 10000 }).catch(
				() => {}
			);

			await video.evaluate(async (node: HTMLVideoElement) => {
				if (node.paused) {
					await node.play().catch(() => {});
				}
				const start = node.currentTime;
				const deadline = Date.now() + 15000;
				while (node.currentTime <= start + 0.5) {
					if (Date.now() > deadline) {
						throw new Error(
							`YouTube playback did not advance (readyState=${node.readyState}, networkState=${node.networkState}, currentTime=${node.currentTime})`
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			});
		},
	}),
];
