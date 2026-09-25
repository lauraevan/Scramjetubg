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

			// Headless Chromium may not start YouTube's media pipeline until it
			// receives a user gesture. Trigger the real player control before
			// deciding that the media transport is broken.
			const player = frame.locator("#movie_player").first();
			await player.waitFor({ state: "visible", timeout: 30000 });
			const playButton = frame.locator(".ytp-large-play-button").first();
			if (await playButton.isVisible().catch(() => false)) {
				await playButton.click({ timeout: 10000 });
			} else {
				await player.click({
					position: { x: 320, y: 180 },
					timeout: 10000,
				});
			}

			await new Promise((resolve) => setTimeout(resolve, 500));
			const playability = await player.evaluate((moviePlayer: any) => {
				const response =
					moviePlayer?.getPlayerResponse?.() ??
					(window as any).ytInitialPlayerResponse ??
					null;
				return response?.playabilityStatus ?? null;
			});
			if (
				playability?.status === "LOGIN_REQUIRED" &&
				/sign in to confirm you.?re not a bot/i.test(playability?.reason ?? "")
			) {
				console.warn(
					"YouTube playback check skipped: YouTube blocked this CI egress with its anti-bot interstitial."
				);
				return;
			}

			await video.evaluate(async (node: HTMLVideoElement) => {
				const deadline = Date.now() + 30000;
				while (node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
					if (Date.now() > deadline) {
						const moviePlayer = document.querySelector("#movie_player") as any;
						const playerResponse =
							moviePlayer?.getPlayerResponse?.() ??
							(window as any).ytInitialPlayerResponse ??
							null;
						const playability =
							playerResponse?.playabilityStatus ??
							(window as any).ytplayer?.config?.args?.playabilityStatus ??
							null;
						const errorText =
							(document.querySelector(".ytp-error-content-wrap")?.textContent ??
								document.querySelector("yt-player-error-message-renderer")?.textContent ??
								"")
								.trim()
								.replace(/\s+/g, " ")
								.slice(0, 500);

						throw new Error(
							`YouTube video never received media data after play gesture: ${JSON.stringify({
								readyState: node.readyState,
								networkState: node.networkState,
								currentSrc: node.currentSrc,
								src: node.getAttribute("src"),
								mediaError: node.error
									? { code: node.error.code, message: node.error.message }
									: null,
								playerState: moviePlayer?.getPlayerState?.() ?? null,
								videoData: moviePlayer?.getVideoData?.() ?? null,
								playability,
								errorText,
							})}`
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			});

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
