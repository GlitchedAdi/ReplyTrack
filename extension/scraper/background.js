// SalesNav Scraper (v5.2) — loaded by ReplyTrack's background.js with importScripts().
// Wrapped in a function so its names (sleep, rand, log, running, …) can't clash with ReplyTrack's.
(() => {
// MV3 service worker. The contact finder (v5.0.3) is in the second half of this file.
importScripts("scraper/contact-parse.js");

// Drives step 2 (profile data) without opening any pages:
// each lead is fetched through LinkedIn's own APIs from inside a logged-in
// Sales Navigator tab (content.js → api-helper.js). Fields already captured
// in step 1 (name, title, company, location) are not fetched again.
const TAG = "[SN-Scraper:profiles]";
const LOG_KEY = "debugLog";
const MAX_LOG = 200;
const STATE_KEY = "enrichState";
const SN_TAB_URL = "https://www.linkedin.com/sales/*";
const SN_HOME = "https://www.linkedin.com/sales/home";

const MAX_ATTEMPTS = 3; // per lead, across runs
const BREAK_EVERY = 40; // take a longer pause every N profiles…
const BREAK_SECONDS = [45, 90]; // …of this many seconds
const MAX_CONSECUTIVE_ERRORS = 5;
const DAY_KEY = "dailyProfileCount"; // { day: "YYYY-MM-DD", n }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const leadKey = l => (l.memberId || `${l.name}|${l.company}`).toLowerCase();

let running = false;
let stopFlag = false;

// ---------------------------------------------------------------------------
// Logging (shared debug panel in the popup)
// ---------------------------------------------------------------------------
let logChain = Promise.resolve();
function log(level, msg, source = "profiles") {
	(level === "error" ? console.error : level === "warn" ? console.warn : console.log)(TAG, msg);
	logChain = logChain
		.then(async () => {
			const r = await chrome.storage.local.get(LOG_KEY);
			const all = (r[LOG_KEY] || []).concat({ t: Date.now(), level, source, msg }).slice(-MAX_LOG);
			await chrome.storage.local.set({ [LOG_KEY]: all });
		})
		.catch(() => {});
	return logChain;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
async function getState() {
	const r = await chrome.storage.local.get(STATE_KEY);
	return r[STATE_KEY] || { active: false };
}

async function patchState(p) {
	const s = { ...(await getState()), ...p };
	await chrome.storage.local.set({ [STATE_KEY]: s });
	return s;
}

// Bulky profile sections live in their own storage entry per lead ("p:<key>"),
// so saving one profile doesn't rewrite every other profile's data. The popup
// merges them back at export time.
const HEAVY = ["about", "experience", "education", "publications", "certifications", "honors", "testScores", "organizations", "volunteering"];

let leadChain = Promise.resolve();
function updateLead(key, patch) {
	leadChain = leadChain.then(async () => {
		const heavy = {};
		const light = {};
		for (const [k, v] of Object.entries(patch)) (HEAVY.includes(k) ? heavy : light)[k] = v;
		const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
		const lead = scrapedLeads.find(l => leadKey(l) === key);
		if (!lead) return; // leads were cleared mid-run
		if (Object.keys(heavy).length) {
			await chrome.storage.local.set({ ["p:" + key]: heavy });
			for (const k of HEAVY) delete lead[k]; // drop copies stored inline by older versions
		}
		Object.assign(lead, light);
		await chrome.storage.local.set({ scrapedLeads });
	});
	return leadChain;
}

// Which leads a job still has to do. Checkpointing is per lead (keyed by the
// Sales Nav member id / vmid), so any run can stop and the next one resumes.
// retryAll: an explicit "Continue" click also retries leads that used up their
// automatic attempts (e.g. failures caused by an earlier bug).
const isPending = (l, job = "full", retryAll = false) =>
	!!l.memberId &&
	(job === "past"
		? l.pastStatus !== "done" && (retryAll || (l.pastAttempts || 0) < MAX_ATTEMPTS)
		: l.enrichStatus !== "done" && l.enrichStatus !== "not_found" && (retryAll || (l.enrichAttempts || 0) < MAX_ATTEMPTS));

// ---------------------------------------------------------------------------
// Worker tab: any open Sales Navigator tab (usually the one step 1 ran in).
// Only if none is open do we open /sales/home once, in the background.
// ---------------------------------------------------------------------------
async function ping(tabId) {
	try {
		const r = await chrome.tabs.sendMessage(tabId, { type: "PING" });
		return !!(r && r.ok);
	} catch (e) {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Background worker window (v5.12). Tabs the extension needs (a Sales Navigator or
// LinkedIn page to make the API calls from) open in ONE minimized window instead of
// the user's window. The window keeps an about:blank tab, so closing a worker tab
// never closes the window; the whole window is closed when no job is running.
// ---------------------------------------------------------------------------
const WIN_KEY = "workerWindowId";
let winP = null;
async function workerWindow() {
	const { [WIN_KEY]: id } = await chrome.storage.session.get(WIN_KEY);
	if (id && (await chrome.windows.get(id).catch(() => null))) return id;
	if (!winP)
		winP = chrome.windows
			.create({ url: "about:blank", focused: false, state: "minimized" })
			.then(async w => {
				await chrome.storage.session.set({ [WIN_KEY]: w.id });
				return w.id;
			})
			.finally(() => (winP = null));
	return winP;
}
async function openWorkerTab(url) {
	let windowId;
	try {
		windowId = await workerWindow();
	} catch (e) {
		windowId = undefined; // no window could be made — fall back to a background tab
	}
	return chrome.tabs.create({ ...(windowId ? { windowId } : {}), url, active: false });
}
async function closeWorkerWindowIfIdle() {
	if (running) return;
	const { [WIN_KEY]: id } = await chrome.storage.session.get(WIN_KEY);
	if (!id) return;
	await chrome.storage.session.remove(WIN_KEY);
	await chrome.windows.remove(id).catch(() => {});
}

// One tab search at a time: parallel workers share it instead of each opening a tab.
let snTabP = null;
function getWorkerTab() {
	return snTabP || (snTabP = findSalesTab().finally(() => (snTabP = null)));
}
async function findSalesTab() {
	const st = await getState();
	if (st.workerTabId && (await ping(st.workerTabId))) return st.workerTabId;
	const tabs = await chrome.tabs.query({ url: SN_TAB_URL });
	tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
	for (const t of tabs) {
		if (t.id !== st.workerTabId && (await ping(t.id))) {
			await patchState({ workerTabId: t.id, openedTab: false });
			return t.id;
		}
	}
	if (st.openedTab && st.workerTabId) await chrome.tabs.remove(st.workerTabId).catch(() => {}); // ours, but not answering
	log("info", "No Sales Navigator tab is open — opening one in the minimized worker window to make the API calls from.");
	const tab = await openWorkerTab(SN_HOME);
	await patchState({ workerTabId: tab.id, openedTab: true });
	const deadline = Date.now() + 45000;
	while (Date.now() < deadline) {
		await sleep(1000);
		if (await ping(tab.id)) return tab.id;
	}
	throw new Error("Couldn't load a Sales Navigator tab to work from.");
}

// A LinkedIn (not Sales Nav) tab for Deep Run's contact finder and for leads from a
// CSV — state keys cfTabId / cfOpenedTab.
const deepLinkedInTab = async () => {
	const cur = await getState();
	return cfWorkerTab({ workerTabId: cur.cfTabId, openedTab: cur.cfOpenedTab }, p => patchStateSerial({ cfTabId: p.workerTabId, cfOpenedTab: p.openedTab }));
};

async function fetchViaTab(lead, job) {
	// Leads from an uploaded CSV don't need Sales Navigator: the profile comes from
	// LinkedIn's profile API, called from a normal LinkedIn tab (contact-finder.js).
	const viaLinkedIn = lead.source === "csv"; // Deep Run and Standard Run from a CSV
	const leadMsg = {
		name: lead.name,
		memberId: lead.memberId,
		idIsVanity: !!lead.idIsVanity,
		salesNavUrn: lead.salesNavUrn || "",
		salesNavProfileUrl: lead.salesNavProfileUrl || "",
		publicProfileUrl: lead.publicProfileUrl || "",
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const tabId = viaLinkedIn ? await deepLinkedInTab() : await getWorkerTab();
		try {
			return await chrome.tabs.sendMessage(tabId, viaLinkedIn ? { type: "CF_DEEP_PROFILE", lead: leadMsg } : { type: "PROFILE_FETCH", job, lead: leadMsg });
		} catch (e) {
			// Tab reloaded/navigated mid-request — find it again once.
			await patchStateSerial(viaLinkedIn ? { cfTabId: null } : { workerTabId: null });
			if (attempt) throw e;
			await sleep(2000);
		}
	}
}

// ---------------------------------------------------------------------------
// One lead
// ---------------------------------------------------------------------------
async function enrichOne(lead, job, st = {}) {
	const t0 = Date.now();
	const r = await fetchViaTab(lead, job);
	if (!r) throw new Error(lead.source === "csv" ? "No answer from the LinkedIn tab" : "No answer from the Sales Navigator tab");
	const ms = Date.now() - t0;
	const secs = (ms / 1000).toFixed(1);
	const trail = r.log && r.log.length ? ` [${r.log.join("; ")}]` : "";

	if (r.fatal) {
		const e = new Error(r.error + trail);
		e.fatal = true;
		e.rateLimited = !!r.rateLimited;
		throw e;
	}

	if (job === "past" && lead.source === "csv") {
		// Standard Run from a CSV (v5.13): no search card, so every Standard Run column
		// comes from the one profile request — past experience included.
		if (r.inaccessible) throw new Error("profile can't be accessed from your account");
		if (!r.ok) throw new Error(`profile lookup failed (${r.error || "unknown error"})`);
		const sf = r.searchFields || {};
		const empty = v => v == null || v === "";
		const patch = { pastStatus: "done", pastError: "", pastPosition: sf.pastPosition || null };
		for (const [k, v] of Object.entries(sf)) if (k !== "pastPosition" && empty(lead[k]) && !empty(v)) patch[k] = v;
		if (empty(lead.summary) && r.data && r.data.about) patch.summary = r.data.about;
		if (r.publicProfileUrl) patch.vanityUrl = r.publicProfileUrl;
		const p = patch.pastPosition;
		return {
			patch,
			summary: `${patch.title || lead.title || "?"} @ ${patch.company || lead.company || "?"}, ` + (p ? `past: ${p.title || "?"} @ ${p.companyName || "?"}` : "no past position") + `, profile URL ${r.publicProfileUrl ? "✓" : "–"} (${secs}s)`,
			level: "info",
			timings: { ...(r.timings || {}), total: ms },
			calls: 1,
		};
	}

	if (job === "past") {
		if (!r.ok) throw new Error(`past-experience lookup failed (${r.error || "unknown error"})`);
		const p = r.pastPosition;
		return {
			patch: { pastPosition: p || null, ...(r.vanityUrl ? { vanityUrl: r.vanityUrl } : {}), pastStatus: "done", pastError: "" },
			summary: (p ? `past: ${p.title || "?"} @ ${p.companyName || "?"}` : "no past position") + `, profile URL ${r.vanityUrl ? "✓" : "–"} (${secs}s)`,
			level: "info",
			timings: { ...(r.timings || {}), total: ms },
			calls: 1,
		};
	}

	if (r.inaccessible) {
		return {
			patch: { enrichStatus: "not_found", enrichError: "Profile can't be accessed from your account", enrichedAt: new Date().toISOString() },
			summary: `profile can't be accessed from your account (${secs}s)`,
			level: "warn",
			timings: { ...(r.timings || {}), total: ms },
			calls: 2,
		};
	}
	if (!r.ok) throw new Error((r.error || "unknown error") + trail);

	const d = r.data;
	const c = r.contact || {};
	const patch = {
		about: d.about || "",
		email: (c.email || []).join("; "),
		phone: (c.phone || []).join("; "),
		websites: (c.websites || []).join("; "),
		otherContact: (c.other || []).join("; "),
		experience: d.experience || [],
		education: d.education || [],
		publications: d.publications || [],
		certifications: d.certifications || [],
		honors: d.honors || [],
		testScores: d.testScores || [],
		organizations: d.organizations || [],
		volunteering: d.volunteering || [],
		profileNotes: [(r.truncated || []).length ? `LinkedIn returned only part of: ${r.truncated.join("; ")}` : "", r.experienceFrom || ""]
			.filter(Boolean)
			.join(" | "),
		enrichStatus: "done",
		enrichError: "",
		enrichedAt: new Date().toISOString(),
	};
	if (r.publicProfileUrl) patch.publicProfileUrl = r.publicProfileUrl;
	// v5.11: Standard Run's search-card fields (company id, tenure, past experience,
	// photo…) from the same profile answer — only where the search gave none (CSV leads,
	// or a search that didn't return past positions). No extra request.
	const sf = r.searchFields || {};
	const empty = v => v == null || v === "";
	for (const [k, v] of Object.entries(sf)) if (empty(lead[k]) && !empty(v)) patch[k] = v;

	// v5.1: email / phone from the contact finder — LinkedIn's Contact info card (one
	// request from a linkedin.com tab), Sales Nav's contact info and the profile text.
	let cardMark = "";
	if (st.findContacts) {
		const cc = await cfDeepContacts(lead, r, st);
		if (cc.fatal) {
			const e = new Error(cc.error);
			e.fatal = true;
			e.rateLimited = !!cc.rateLimited;
			throw e;
		}
		Object.assign(patch, cfContactPatch(cc.emails, cc.phones));
		if (cc.note) patch.profileNotes = [patch.profileNotes, cc.note].filter(Boolean).join(" | ");
		cardMark = `, contact card ${cc.cardChecked ? "✓" : "n/a"}`;
	}

	const n = k => patch[k].length;
	const nz = [
		["exp", "experience"],
		["edu", "education"],
		["certs", "certifications"],
		["pubs", "publications"],
		["honors", "honors"],
		["tests", "testScores"],
		["orgs", "organizations"],
		["vol", "volunteering"],
	]
		.filter(([, k]) => n(k))
		.map(([a, k]) => `${a} ${n(k)}`);
	// "–" = Sales Nav answered but the person shares nothing; "n/a" = that call failed.
	const contactMark = v => (v ? "✓" : r.salesOk || st.findContacts ? "–" : "n/a");
	const tm = r.timings || {};
	const slow = ms > 10000;
	const summary =
		`${nz.join(", ") || "no list sections"}, about ${patch.about ? "✓" : "–"}, ` +
		`email ${contactMark(patch.email)}, phone ${contactMark(patch.phone)}${cardMark} (${secs}s` +
		(slow ? `: ${Object.entries(tm).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(", ")}` : "") +
		")" +
		(r.experienceFrom ? ` — ${r.experienceFrom}` : "") +
		((r.truncated || []).length ? ` — partial: ${r.truncated.join("; ")}` : "") +
		(slow && trail ? trail : "");
	return {
		patch,
		summary,
		level: "info",
		salesOk: r.salesOk,
		hasContact: !!(patch.email || patch.phone),
		timings: { ...tm, total: ms },
		calls: (r.vanityHow === "profile API" ? 1 : 2) + (tm.positions != null ? 1 : 0) + (tm.redirect != null ? 1 : 0) + (st.findContacts ? 1 : 0),
	};
}

// ---------------------------------------------------------------------------
// Daily cap (profiles fetched per local calendar day, across runs)
// ---------------------------------------------------------------------------
const today = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let dayChain = Promise.resolve();
function bumpDaily() {
	dayChain = dayChain.then(async () => {
		const r = await chrome.storage.local.get(DAY_KEY);
		const cur = r[DAY_KEY] && r[DAY_KEY].day === today() ? r[DAY_KEY] : { day: today(), n: 0 };
		cur.n++;
		await chrome.storage.local.set({ [DAY_KEY]: cur });
		return cur.n;
	});
	return dayChain;
}
// ReplyTrack: one daily LinkedIn limit (the Outreach page → Pace & limits) for connection requests and scraped
// profiles together. The profile step may use what's left after today's requests: the cap it
// gets is limit − requests (its own count of profiles is then compared with that, as before).
// → 0 = no limit, -1 = nothing left today.
async function sharedDailyCap() {
	const s = await chrome.storage.local.get(["orSettings", "orCounts"]);
	const limit = Number(((s.orSettings || {}).dailyCap ?? globalThis.ORShared.DEFAULTS.dailyCap)) || 0;
	if (limit <= 0) return 0;
	const c = s.orCounts && s.orCounts.day === startOfDay() ? s.orCounts : {};
	const cap = limit + (c.extra || 0) - (c.n || 0);
	return cap > 0 ? cap : -1;
}
async function dailyCount() {
	const r = await chrome.storage.local.get(DAY_KEY);
	return r[DAY_KEY] && r[DAY_KEY].day === today() ? r[DAY_KEY].n : 0;
}

// ---------------------------------------------------------------------------
// Run loop: N workers pull leads from the persisted list. Pauses are per
// profile per worker; the periodic longer break is shared by all workers.
// ---------------------------------------------------------------------------
const pct = (arr, q) => {
	if (!arr.length) return 0;
	const s = arr.slice().sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const fmtStat = arr => (arr.length ? `avg ${(arr.reduce((a, b) => a + b, 0) / arr.length / 1000).toFixed(1)}s, p90 ${(pct(arr, 0.9) / 1000).toFixed(1)}s` : "–");

let stateChain = Promise.resolve();
const patchStateSerial = p => (stateChain = stateChain.then(() => patchState(p)));

async function runLoop() {
	if (running) return;
	running = true;
	stopFlag = false;
	// Extension API calls reset the service worker's idle timer.
	const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);

	const st0 = await getState();
	const job = st0.job || "full";
	const workers = Math.max(1, Math.min(3, st0.concurrency || 1));
	const sh = {
		attempted: new Set(st0.attempted || []),
		picked: st0.processed || 0,
		done: st0.processed || 0,
		ok: st0.ok || 0,
		failed: st0.failed || 0,
		salesOk: st0.salesOk || 0,
		withContact: st0.withContact || 0,
		inFlight: new Map(),
		consecutiveErrors: 0,
		breakUntil: 0,
		stopReason: "",
		timings: {},
		pauses: [],
		calls: 0,
	};
	const noteTimings = t => {
		for (const [k, v] of Object.entries(t || {})) (sh.timings[k] = sh.timings[k] || []).push(v);
	};
	const publish = () =>
		patchStateSerial({
			processed: sh.done,
			ok: sh.ok,
			failed: sh.failed,
			salesOk: sh.salesOk,
			withContact: sh.withContact,
			current: [...sh.inFlight.values()].join(", "),
			attempted: [...sh.attempted],
		});

	async function nextLead() {
		// Reserve a slot BEFORE awaiting, so parallel workers can't overshoot the target.
		if (sh.picked >= st0.target) return null;
		sh.picked++;
		const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
		// (no await between find and add, so two workers can't take the same lead)
		const lead = scrapedLeads.find(l => isPending(l, job, st0.retryAll) && !sh.attempted.has(leadKey(l)));
		if (!lead) {
			sh.picked--;
			return null;
		}
		sh.attempted.add(leadKey(lead));
		return lead;
	}

	async function worker(w) {
		// stagger worker start so requests don't fire in lockstep
		await sleep(w * rand(800, 1800));
		while (!stopFlag && !sh.stopReason) {
			while (!stopFlag && Date.now() < sh.breakUntil) await sleep(300);
			if (stopFlag || sh.stopReason) return;
			if (st0.capped && st0.dailyCap && (await dailyCount()) >= st0.dailyCap) {
				sh.stopReason = `daily cap of ${st0.dailyCap} profiles reached — the rest stay pending for tomorrow`;
				return;
			}
			const lead = await nextLead();
			if (!lead) return;
			const key = leadKey(lead);
			sh.inFlight.set(w, lead.name);
			publish();
			const attemptsField = job === "past" ? "pastAttempts" : "enrichAttempts";
			const attempts = (lead[attemptsField] || 0) + 1;
			try {
				const res = await enrichOne(lead, job, st0);
				await updateLead(key, { ...res.patch, [attemptsField]: attempts });
				const ok = job === "past" || res.patch.enrichStatus === "done";
				sh.done++;
				sh.ok += ok ? 1 : 0;
				sh.failed += ok ? 0 : 1;
				sh.salesOk += res.salesOk ? 1 : 0;
				sh.withContact += res.hasContact ? 1 : 0;
				sh.calls += res.calls || 0;
				noteTimings(res.timings);
				sh.consecutiveErrors = 0;
				if (st0.capped) bumpDaily();
				log(res.level, `[${sh.done}/${st0.target}]${workers > 1 ? ` w${w + 1}` : ""} ${lead.name}: ${res.summary}`);
			} catch (e) {
				if (e.fatal) {
					sh.attempted.delete(key); // not this lead's fault — keep it pending
					sh.picked--;
					sh.stopReason = e.message + (e.rateLimited ? " Wait a few hours before the next run, and use longer pauses / fewer parallel requests." : "");
					sh.inFlight.delete(w);
					return;
				}
				const failPatch =
					job === "past"
						? { pastStatus: "failed", pastError: e.message, pastAttempts: attempts }
						: { enrichStatus: "failed", enrichError: e.message, enrichAttempts: attempts, enrichedAt: new Date().toISOString() };
				await updateLead(key, failPatch);
				sh.done++;
				sh.failed++;
				log("warn", `[${sh.done}/${st0.target}] ${lead.name}: failed — ${e.message}`);
				if (++sh.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
					sh.stopReason = `${sh.consecutiveErrors} failures in a row. Copy the log and send it over.`;
				}
			}
			sh.inFlight.delete(w);
			publish();
			if (sh.done >= st0.target) return;

			// per-profile pause (per worker) + a shared longer break every BREAK_EVERY profiles
			let wait = rand(st0.minDelay, st0.maxDelay) * 1000;
			if (sh.done > 0 && sh.done % BREAK_EVERY === 0 && Date.now() > sh.breakUntil) {
				const b = rand(BREAK_SECONDS[0], BREAK_SECONDS[1]) * 1000;
				sh.breakUntil = Date.now() + b;
				log("info", `Short break (${Math.round(b / 1000)}s) after ${sh.done} profiles — keeps the pace human-like.`);
			}
			sh.pauses.push(wait);
			const until = Date.now() + wait;
			while (!stopFlag && Date.now() < until) await sleep(300);
		}
	}

	const t0 = Date.now();
	try {
		await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
		if (sh.stopReason) log("error", `Stopping: ${sh.stopReason}`);
		else if (!stopFlag && sh.done < st0.target) log("info", "No more leads waiting.");
	} catch (e) {
		log("error", `Profile step crashed: ${e.message}`);
		console.error(TAG, e);
	} finally {
		clearInterval(keepAlive);
		await publish();
		const st = await getState();
		if (st.openedTab && st.workerTabId) chrome.tabs.remove(st.workerTabId).catch(() => {});
		if (st.cfOpenedTab && st.cfTabId) chrome.tabs.remove(st.cfTabId).catch(() => {});
		await patchState({ active: false, current: "", workerTabId: null, openedTab: false, cfTabId: null, cfOpenedTab: false });
		await chrome.storage.session.remove("enrichSession").catch(() => {});
		const mins = (Date.now() - (st.startedAt || t0)) / 60000;
		const perMin = mins > 0 ? (sh.done / mins).toFixed(1) : "?";
		const what = job === "past" ? "past-experience lookups" : "profiles";
		log(
			"info",
			`Finished in ${mins.toFixed(1)} min: ${sh.ok} ${what} done, ${sh.failed} failed/unavailable (${perMin}/min, ${workers} in parallel).` +
				(job === "full" ? ` Contact info: ${sh.withContact} had an email or phone${st0.findContacts ? "" : ` (Sales Nav answered for ${sh.salesOk})`}. Today so far: ${await dailyCount()} profiles.` : "")
		);
		const phases = Object.entries(sh.timings)
			.filter(([k]) => k !== "total")
			.map(([k, v]) => `${k} ${fmtStat(v)} (${v.length}×)`);
		log("info", `Timing — per lead ${fmtStat(sh.timings.total || [])}; ${phases.join("; ")}; pause ${fmtStat(sh.pauses)}; ${sh.calls} API calls.`);
		running = false;
		closeWorkerWindowIfIdle();
	}
}

async function startEnrich(opts = {}) {
	if (running) return { ok: false, error: "The profile step is already running." };
	const { scrapedLeads = [], scrapingConfig } = await chrome.storage.local.get(["scrapedLeads", "scrapingConfig"]);
	if (scrapingConfig && scrapingConfig.active) {
		return { ok: false, error: "The search stage is still running — this step starts automatically when it ends." };
	}
	if (!opts.v4) {
		// Settings saved by v3 (page loading): 8–15s / 50 profiles → API-era defaults.
		opts = {
			...opts,
			maxProfiles: +opts.maxProfiles === 50 ? 500 : opts.maxProfiles,
			minDelay: +opts.minDelay === 8 ? 3 : opts.minDelay,
			maxDelay: +opts.maxDelay === 15 ? 6 : opts.maxDelay,
		};
	}
	const job = opts.job === "past" ? "past" : "full";
	const retryAll = !!opts.retryAll;
	const pending = scrapedLeads.filter(l => isPending(l, job, retryAll));
	if (!pending.length) {
		return { ok: false, nothingToDo: true, error: job === "past" ? "Every lead's past experience is already filled." : "Every lead's profile is already scraped." };
	}

	const minDelay = Math.max(0.5, Number(opts.minDelay) || 3);
	const maxDelay = Math.max(minDelay, Number(opts.maxDelay) || 6);
	const concurrency = Math.max(1, Math.min(3, parseInt(opts.concurrency, 10) || 2));
	const dailyCap = await sharedDailyCap(); // ReplyTrack's daily LinkedIn limit (shared with outreach)
	const findContacts = job === "full" && opts.findContacts !== false;
	const capped = job === "full" || !!opts.fromCsv; // Standard Run from a CSV reads a full profile per lead too
	// No per-run limit: every pending lead is processed. Deep Run is bounded by the daily cap.
	let target = pending.length;
	const limitUsed = "Today's LinkedIn limit is used up (connection requests and scraped profiles share it — ReplyTrack's Outreach page). The rest stay pending — run again tomorrow.";
	if (capped && dailyCap < 0) return { ok: false, error: limitUsed };
	if (capped && dailyCap) {
		const left = dailyCap - (await dailyCount());
		if (left <= 0) return { ok: false, error: limitUsed };
		target = Math.min(target, left);
	}

	await chrome.storage.session.set({ enrichSession: true });
	await patchState({
		active: true,
		job,
		target,
		processed: 0,
		ok: 0,
		failed: 0,
		salesOk: 0,
		withContact: 0,
		current: "",
		attempted: [],
		minDelay,
		maxDelay,
		concurrency,
		dailyCap,
		retryAll,
		findContacts,
		capped,
		startedAt: Date.now(),
		workerTabId: null,
		openedTab: false,
		cfTabId: null,
		cfOpenedTab: false,
	});
	log(
		"info",
		(job === "past" ? (opts.fromCsv ? "Standard Run from CSV — one profile request each: " : "Past-experience lookups: ") : "Step 2 — profiles via API: ") +
			`${target} of ${pending.length} pending, ${concurrency} in parallel, ${minDelay}–${maxDelay}s pause per worker` +
			(capped && dailyCap ? `, daily cap ${dailyCap} (${await dailyCount()} used today)` : "") +
			(findContacts ? ", contact finder on" : "") +
			" (no pages opened)."
	);
	runLoop();
	return { ok: true, target };
}

async function stopEnrich() {
	stopFlag = true;
	await patchState({ active: false });
	if (!running) log("info", "Profile step stopped.");
}

// ---------------------------------------------------------------------------
// v5.0.3 — Contact finder engine. One code path for 1 profile (the popup's
// "Find contact info" button) and for a list of up to thousands (bulk).
//
//   job → a LinkedIn tab with contact-finder.js → lookup(vanity):
//           profile API (text, profile id)  +  Contact info request
//           (replayed; learned from LinkedIn's own traffic)       ≈ 1–2 s
//   → result saved per profile in storage.local["cf:<vanity>"]
//
// Bulk runs pace themselves (pause per profile, longer break every 40, daily
// cap), checkpoint every profile, stop on sign-out / rate limit, and resume
// after a service-worker restart.
// ---------------------------------------------------------------------------
const cfDbg = () => {}; // (the detailed debug log was removed)
const CF = {
	result: v => "cf:" + v.toLowerCase(),
	DAY: "cfDaily",
	TPL: "cfTemplate",
};

const cfBusy = new Set(); // vanities being looked up right now

const cfGet = async k => (await chrome.storage.local.get(k))[k];

// ---- tabs ------------------------------------------------------------------

async function cfPing(tabId) {
	try {
		const r = await chrome.tabs.sendMessage(tabId, { type: "CF_PING" });
		return !!(r && r.ok);
	} catch (e) {
		return false;
	}
}

// Tabs opened before the extension was (re)loaded don't have the content scripts yet.
async function cfEnsureFinder(tabId) {
	if (await cfPing(tabId)) return true;
	const files = ["scraper/contact-parse.js", "scraper/voyager-map.js", "scraper/contact-finder.js"];
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["scraper/net-tap.js"], world: "MAIN" });
		await chrome.scripting.executeScript({ target: { tabId }, files });
	} catch (e) {
		cfDbg("tab", `couldn't inject into tab ${tabId}: ${e.message}`);
		return false;
	}
	cfDbg("tab", `injected the finder into tab ${tabId}`);
	return cfPing(tabId);
}

async function cfWaitTabLoad(tabId, timeout = 30000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const t = await chrome.tabs.get(tabId).catch(() => null);
		if (!t) return false;
		if (t.status === "complete") return true;
		await sleep(400);
	}
	return false;
}

// A LinkedIn tab (not Sales Nav) of our own, in the minimized worker window — the
// user's own tabs are left alone (navigating one would break a running job).
// st: the job's state ({ workerTabId, openedTab }); patch(p) saves them into it.
let cfTabP = null;
async function cfWorkerTab(st, patch) {
	if (st && st.workerTabId && (await cfPing(st.workerTabId))) return st.workerTabId;
	return (
		cfTabP ||
		(cfTabP = (async () => {
			if (st && st.openedTab && st.workerTabId) await chrome.tabs.remove(st.workerTabId).catch(() => {}); // ours, but not answering
			log("info", "Opening a LinkedIn tab in the minimized worker window to make the lookups from.", "contact");
			const tab = await openWorkerTab("https://www.linkedin.com/in/me/");
			await patch({ workerTabId: tab.id, openedTab: true });
			// A page that failed to load (network blip, error page) gets two reloads.
			for (let i = 0; i < 3; i++) {
				if (i) await chrome.tabs.reload(tab.id).catch(() => {});
				await sleep(300);
				await cfWaitTabLoad(tab.id);
				if (await cfEnsureFinder(tab.id)) return tab.id;
			}
			throw new Error("Couldn't prepare a LinkedIn tab to work from.");
		})().finally(() => (cfTabP = null)))
	);
}

// ---- one lookup ----------------------------------------------------------------
function cfMerge(...lists) {
	const seen = new Map();
	for (const list of lists)
		for (const x of list || []) {
			const id = /@/.test(x.value) ? x.value.toLowerCase() : x.value.replace(/\D/g, "").slice(-10);
			const cur = seen.get(id);
			if (!cur) seen.set(id, { ...x });
			else for (const s of String(x.source).split(", ")) if (!cur.source.split(", ").includes(s)) cur.source += `, ${s}`;
		}
	return CFParse.dropGlued([...seen.values()]);
}
const cfTag = (arr, source) => (arr || []).map(x => (typeof x === "string" ? { value: x, source } : x));

// One lookup (≈1–2 s).
async function cfLookup(tabId, vanity) {
	const t0 = Date.now();
	if (!(await cfEnsureFinder(tabId))) return { ok: false, error: "Couldn't reach the LinkedIn tab. Refresh it and try again." };
	const r = await chrome.tabs.sendMessage(tabId, { type: "CF_LOOKUP", vanity, opts: {} }).catch(e => ({ ok: false, error: e.message }));
	if (!r || !r.ok) return { ok: false, fatal: !!(r && r.fatal), rateLimited: !!(r && r.rateLimited), error: (r && r.error) || "No answer from the LinkedIn tab.", log: (r && r.log) || [], ms: Date.now() - t0 };
	if (!r.contactChecked && !r.textChecked) return { ok: false, error: "Couldn't read this profile. Refresh the LinkedIn tab and try again.", log: r.log, ms: Date.now() - t0 };
	const unchecked = [];
	if (!r.contactChecked) unchecked.push("contact info section");
	if (!r.textChecked) unchecked.push("about & other sections");
	return {
		ok: true,
		emails: cfMerge(cfTag(r.contactEmails, "Contact info"), r.emails),
		phones: cfMerge(cfTag(r.contactPhones, "Contact info"), r.phones),
		unchecked,
		scanned: r.scanned,
		ignored: r.ignored || [],
		publicId: r.publicId || "",
		timings: r.timings,
		log: r.log,
		ms: Date.now() - t0,
	};
}

function cfLogResult(vanity, res, prefix = "") {
	const secs = ((res.ms || 0) / 1000).toFixed(1);
	const trail = res.log && res.log.length ? ` [${res.log.join("; ")}]` : "";
	if (!res.ok) return log("warn", `${prefix}/in/${vanity}: ${res.error} (${secs}s)${trail}`, "contact");
	const show = arr => (arr.length ? arr.map(x => `${x.value} (${x.source})`).join(", ") : "not found");
	const tm = Object.entries(res.timings || {})
		.filter(([k]) => k !== "total")
		.map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
		.join(", ");
	const kb = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n);
	const scanned = Object.entries(res.scanned || {}).map(([k, n]) => `${k} ${kb(n)}`).join(", ");
	log(
		"info",
		`${prefix}/in/${vanity}: email ${show(res.emails)}; phone ${show(res.phones)} (${secs}s${tm ? `: ${tm}` : ""})` +
			(res.unchecked.length ? ` — couldn't check: ${res.unchecked.join(", ")}` : "") +
			` — text read (chars): ${scanned || "none"}` +
			(res.ignored && res.ignored.length ? ` — ignored: ${res.ignored.join("; ")}` : "") +
			trail,
		"contact"
	);
}

// ---- single profile (popup button) ----------------------------------------------
async function cfFindOne(tabId, vanity) {
	const key = vanity.toLowerCase();
	if (cfBusy.has(key)) return;
	cfBusy.add(key);
	const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
	const startedAt = Date.now();
	const save = (status, result) => chrome.storage.local.set({ [CF.result(vanity)]: { vanity, status, startedAt, at: Date.now(), result } });
	await save("running");
	let res;
	try {
		res = await cfLookup(tabId, vanity);
		await save("done", res);
	} catch (e) {
		res = { ok: false, error: /cannot access|no tab|closed/i.test(e.message) ? "Couldn't reach the LinkedIn tab. Refresh it and try again." : e.message, ms: Date.now() - startedAt };
		await save("done", res);
	} finally {
		clearInterval(keepAlive);
		cfBusy.delete(key);
	}
	res.ms = Date.now() - startedAt;
	cfLogResult(vanity, res);
}

// The user opened Contact info on a profile we already have a result for → fill it in.
async function cfOnCaptured(vanity, emails, phones) {
	const k = CF.result(vanity);
	const rec = await cfGet(k);
	if (!rec || rec.status !== "done" || !rec.result || !rec.result.ok) return;
	const r = rec.result;
	r.emails = cfMerge(cfTag(emails, "Contact info"), r.emails);
	r.phones = cfMerge(cfTag(phones, "Contact info"), r.phones);
	r.unchecked = (r.unchecked || []).filter(x => x !== "contact info section");
	rec.at = Date.now();
	await chrome.storage.local.set({ [k]: rec });
	const vals = a => (a.length ? a.map(x => (typeof x === "string" ? x : x.value)).join(", ") : "none");
	log("info", `/in/${vanity}: Contact info card read (opened on the page) — email ${vals(emails)}, phone ${vals(phones)}.`, "contact");
}

// ---- Deep Run (v5.1): email & phone with the contact finder ----------------------
// r = the Sales Nav tab's profile result (content.js fetchProfileForBackground).
async function cfDeepContacts(lead, r, st) {
	const col = CFParse.collector();
	const d = r.data || {};
	let vanity = r.publicIdentifier || (String(r.publicProfileUrl || "").match(/\/in\/([^/?#]+)/) || [])[1] || "";
	try {
		vanity = decodeURIComponent(vanity);
	} catch (e) {}
	let card = null;
	let note = "";
	if (vanity && !/^AC[wo]AA/.test(vanity)) {
		try {
			const tabId = await deepLinkedInTab();
			const res = await chrome.tabs.sendMessage(tabId, { type: "CF_LOOKUP", vanity, opts: { contactOnly: true, first: r.firstName || "", last: r.lastName || "" } });
			if (res && res.fatal) return { fatal: true, rateLimited: !!res.rateLimited, error: res.error };
			if (res && res.ok && res.contactChecked) card = res;
			else note = "Contact info card: LinkedIn didn't return it" + (res && res.log && res.log.length ? ` [${res.log.join("; ")}]` : "");
		} catch (e) {
			await patchStateSerial({ cfTabId: null });
			note = `Contact info card not checked (${e.message})`;
		}
	} else note = "Contact info card not checked (no public profile URL)";
	// Order = which source is named first when a value is found in several places.
	if (card) {
		for (const x of card.contactEmails || []) col.email(x.value || x, "Contact info");
		for (const x of card.contactPhones || []) col.phone(x.value || x, "Contact info");
	}
	const c = r.contact || {};
	for (const e of c.email || []) col.email(e, "Sales Nav");
	for (const p of c.phone || []) col.phone(CFParse.classifyPhone(String(p).replace(/\s*\([^)]*\)\s*$/, ""), { labeled: true }), "Sales Nav");
	col.text(r.headline, "Headline");
	col.text(d.about, "About");
	const scan = (arr, sec, f) => (arr || []).forEach(x => col.text(f(x), sec));
	const J = (...a) => a.filter(Boolean).join("\n");
	scan(d.experience, "Experience", e => J(e.title, e.description));
	scan(d.education, "Education", e => J(e.activities, e.description));
	scan(d.certifications, "Certifications", x => x.name);
	scan(d.publications, "Publications", x => J(x.title, x.description));
	scan(d.honors, "Honors", x => J(x.title, x.description));
	scan(d.testScores, "Test scores", x => x.description);
	scan(d.organizations, "Organizations", x => J(x.name, x.description));
	scan(d.volunteering, "Volunteering", x => J(x.role, x.description));
	const o = col.out();
	if (o.ignored.length) cfDbg("deep", `${lead.name}: ignored ${o.ignored.join("; ")}`);
	return { emails: o.emails, phones: o.phones, cardChecked: !!card, note };
}

// Lead fields for the export (Email / Phone / Contact Source) + the list kept for merging.
function cfContactPatch(emails, phones) {
	const src = (label, arr) => (arr.length ? `${label}: ${arr.map(x => x.source).join(" | ")}` : "");
	return {
		email: emails.map(x => x.value).join("; "),
		phone: phones.map(x => x.value).join("; "),
		contactSources: [src("email", emails), src("phone", phones)].filter(Boolean).join("; "),
		contactFound: { emails, phones },
	};
}

// ---- messages --------------------------------------------------------------------
function cfHandleMessage(msg, sender, sendResponse) {
	switch (msg.type) {
		case "CONTACT_FIND":
			if (!msg.tabId || !msg.vanity) sendResponse({ ok: false, error: "No profile tab" });
			else {
				cfFindOne(msg.tabId, msg.vanity);
				sendResponse({ ok: true });
			}
			return true;
		case "CF_CAPTURED":
			cfOnCaptured(msg.vanity, msg.emails || [], msg.phones || []);
			sendResponse({ ok: true });
			return true;
	}
	return false;
}

// A worker window left over from a job that didn't survive a service-worker restart.
setTimeout(() => closeWorkerWindowIfIdle().catch(() => {}), 8000);

chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove("contactLookups")); // v5.0–5.0.2 results

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (cfHandleMessage(msg, sender, sendResponse)) return true;
	if (msg.type === "ENRICH_START") {
		startEnrich(msg.options).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
		return true;
	}
	if (msg.type === "ENRICH_STOP") {
		stopEnrich().then(() => sendResponse({ ok: true }));
		return true;
	}
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes[STATE_KEY] && running) {
		const nv = changes[STATE_KEY].newValue;
		if (nv && !nv.active) stopFlag = true;
	}
});

// If Chrome recycled the service worker mid-run, pick up where we left off.
(async () => {
	const st = await getState();
	if (!st.active) return;
	const { enrichSession } = await chrome.storage.session.get("enrichSession");
	if (enrichSession) {
		log("info", "Service worker restarted — resuming the profile step.");
		runLoop();
	} else if (!running) {
		await patchState({ active: false, current: "", workerTabId: null, openedTab: false });
	}
})();
})();
