// The scraper's leads → the SCRAP tab of your sheet (Code.gs: saveScraped).
// Whenever the scraper captures leads (scrapedLeads) or fills in someone's profile (p:<key>),
// the rows that changed are sent a few seconds later — through the Sheet outbox, so they wait
// and retry if the sheet can't be reached. Columns: "key", "inMyLeads" (filled in by Code.gs) and
// "requestSent" (ReplyTrack already sent them a connection request — its history, h:<key>), then the
// Deep Run export columns (scraper/export-cols.js), then the Standard Run ones Deep Run doesn't have.
//
// storage.local  scSent { <key>: hash } — what the sheet already has
//                scLast { at, rows }   — the last batch sent (the dashboard's Scraper tab)
const ScrapeSync = (() => {
	const SENT = "scSent";
	const LAST = "scLast";
	const BATCH = 100; // rows per request
	const DELAY_MS = 10000; // wait for a burst of changes to settle
	const leadKey = l => (l.memberId || `${l.name}|${l.company}`).toLowerCase(); // the scraper's own key

	// The ids ReplyTrack's sent history could know this person by: their profile id, and the
	// /in/<name> of any link the scraper has for them.
	const idsOf = l => [l.memberId, l.vanityUrl, l.publicProfileUrl, l.defaultProfileUrl].map(x => (x && /linkedin\.com/.test(x) ? profileKey(x) : String(x || "").toLowerCase())).filter(Boolean);
	let history = {}; // the h:<key> entries, set by flush()
	const requestSent = l => (idsOf(l).some(id => ("h:" + id) in history) ? "yes" : "");

	let cols = null;
	function columns() {
		if (cols) return cols;
		const X = globalThis.SNExport;
		const have = new Set(X.FULL_COLUMNS.map(c => c[0]));
		const extra = X.PB_COLUMNS.filter(c => !have.has(c[0]) && c[0] !== "name"); // "name" = fullName
		cols = [["key", leadKey], ["inMyLeads", () => ""], ["requestSent", requestSent], ...X.FULL_COLUMNS, ...extra];
		return cols;
	}

	const cell = (f, l, account) => {
		try {
			const v = f(l, account);
			return v == null ? "" : String(v);
		} catch (e) {
			return "";
		}
	};

	let timer = null;
	let running = null;
	let again = false;
	function soon() {
		clearTimeout(timer);
		timer = setTimeout(() => flush().catch(e => console.warn("[Scraper] sheet:", e)), DELAY_MS);
	}

	async function flush() {
		if (running) {
			again = true;
			return running;
		}
		running = (async () => {
			if (!Sheet.configured(await Sheet.settings())) return; // sent once your sheet is connected
			const all = await chrome.storage.local.get(null);
			const leads = (all.scrapedLeads || []).map(l => ({ ...l, ...(all["p:" + leadKey(l)] || {}) }));
			if (!leads.length) return;
			history = Object.fromEntries(Object.keys(all).filter(k => k.startsWith("h:")).map(k => [k, true]));
			const c = columns();
			const account = all.searchAccount || {};
			const sent = all[SENT] || {};
			const changed = [];
			for (const l of leads) {
				const row = c.map(([, f]) => cell(f, l, account));
				if (!row[0]) continue;
				const h = hash(row.join("\u0001"));
				if (sent[row[0]] !== h) changed.push({ row, h });
			}
			if (!changed.length) return;
			const names = c.map(x => x[0]);
			for (let i = 0; i < changed.length; i += BATCH) {
				const part = changed.slice(i, i + BATCH);
				await Sheet.enqueue("saveScraped", { columns: names, rows: part.map(x => x.row) }, `${plural(part.length, "scraped lead")} → SCRAP`);
				for (const x of part) sent[x.row[0]] = x.h;
			}
			await chrome.storage.local.set({ [SENT]: sent, [LAST]: { at: Date.now(), rows: changed.length } });
		})().finally(() => {
			running = null;
			if (again) {
				again = false;
				soon();
			}
		});
		return running;
	}

	// A batch the sheet refused (e.g. its Code.gs is older and doesn't know "saveScraped" yet):
	// forget those rows as sent, so they go again with the next change or the 15-minute check.
	Sheet.afterWrite(async (job, r) => {
		if (job.action !== "saveScraped" || (r && r.ok)) return;
		const s = await getLocal(SENT, {});
		for (const row of (job.data && job.data.rows) || []) delete s[row[0]];
		await chrome.storage.local.set({ [SENT]: s });
		console.warn("[Scraper] The sheet refused scraped leads:", r && r.error, "— they'll be sent again later.");
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && (changes.scrapedLeads || Object.keys(changes).some(k => k.startsWith("p:")))) soon();
	});

	return { flush };
})();
