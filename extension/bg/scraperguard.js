// The scraper follows ReplyTrack's rules for LinkedIn:
//   - While it runs (a search, or the profile step) it holds the lock as "scraper", so outreach,
//     the accepted check and Admin Replies wait for it; a reply sync waits too.
//   - It can't start while outreach or an Admin Reply is using LinkedIn: it's stopped at once,
//     with a line in its log saying why.
//   - "Pause everything" stops it, and it can't start while paused.
// The scraper's own code isn't changed for this: its runs are watched through its storage keys
// (scrapingConfig.active, enrichState.active) and stopped the way its own Stop button does.
const ScraperGuard = (() => {
	const OWNER = "scraper";
	const BLOCKERS = ["outreach", "admin"]; // long or one-shot jobs the scraper never runs next to
	const BEAT_MS = 20000;
	let timer = null;

	async function state() {
		const s = await chrome.storage.local.get(["scrapingConfig", "enrichState"]);
		return { search: s.scrapingConfig || {}, profiles: s.enrichState || {} };
	}
	const isRunning = st => !!(st.search.active || st.profiles.active);

	// A line in the scraper's own log (shown in its popup).
	async function note(level, msg) {
		const r = await chrome.storage.local.get("debugLog");
		const all = (r.debugLog || []).concat({ t: Date.now(), level, source: "ReplyTrack", msg }).slice(-200);
		await chrome.storage.local.set({ debugLog: all });
	}

	// Stops a search run and the profile step, like the scraper's Stop button.
	async function stop(why) {
		const st = await state();
		if (!isRunning(st)) return false;
		if (st.search.active) await chrome.storage.local.set({ scrapingConfig: { ...st.search, active: false, stoppedByUser: true } });
		if (st.profiles.active) await chrome.storage.local.set({ enrichState: { ...st.profiles, active: false } }); // the scraper stops on this change
		const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/sales/*" }).catch(() => []);
		for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "STOP_SCRAPING" }).catch(() => {});
		await note("warn", why);
		console.warn("[Scraper]", why);
		return true;
	}

	async function check() {
		const st = await state();
		if (!isRunning(st)) {
			clearInterval(timer);
			timer = null;
			await Lock.release(OWNER);
			return;
		}
		if (await Control.isPaused()) return stop("Stopped — “Pause everything” is on in ReplyTrack. Press “Start again” there first.");
		const l = await Lock.holder();
		if (l && l.owner !== OWNER && BLOCKERS.includes(l.owner)) return stop(`Stopped — ReplyTrack is using LinkedIn for ${Lock.NAMES[l.owner]}. Start the scraper again when it's done.`);
		if (await Lock.tryAcquire(OWNER)) await Lock.beat(OWNER);
		// else: a short job (reply sync, accepted check) is finishing — the scraper takes over on the next check.
		if (!timer) timer = setInterval(() => check().catch(e => console.warn("[Scraper] guard:", e)), BEAT_MS);
	}

	chrome.storage.onChanged.addListener((c, area) => {
		if (area === "local" && (c.scrapingConfig || c.enrichState)) check().catch(e => console.warn("[Scraper] guard:", e));
	});
	check().catch(() => {});

	return { stop };
})();
