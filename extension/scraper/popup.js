document.addEventListener("DOMContentLoaded", () => {
	const TAG = "[SN-Scraper:popup]";
	const LOG_KEY = "debugLog";
	const MAX_LOG = 200;
	const SN_RE = /^https:\/\/www\.linkedin\.com\/sales\//;
	const OPTS_KEY = "enrichOptions";
	const SEARCH_KEY = "searchPacing";
	const MODE_KEY = "scrapeMode";
	const PAGE_LIMIT = 400; // 10,000 results; past 2,500 the search is split into slices (v5.2)

	const $ = id => document.getElementById(id);
	const maxPagesInput = $("maxPagesInput");
	const toggleBtn = $("toggleBtn");
	const logEl = $("log");
	$("ver").textContent = "ReplyTrack v" + chrome.runtime.getManifest().version + " · built by Yash";

	// Internal keys stay the same (saved settings/leads keep working); only the names changed.
	const MODES = {
		pb: { label: "Standard Run", short: "Standard Run", job: "past" },
		basic: { label: "Quick Run", short: "Quick Run", job: null },
		full: { label: "Deep Run", short: "Deep Run", job: "full" },
	};
	const currentMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value || "pb";

	// ---------------------------------------------------------------------------
	// Logging
	// ---------------------------------------------------------------------------
	async function plog(level, msg) {
		(console[level] || console.log).call(console, TAG, msg); // "start" falls back to console.log
		const res = await chrome.storage.local.get(LOG_KEY);
		const all = (res[LOG_KEY] || []).concat({ t: Date.now(), level, source: "popup", msg }).slice(-MAX_LOG);
		await chrome.storage.local.set({ [LOG_KEY]: all });
	}
	const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
	const fmtTime = t => new Date(t).toLocaleTimeString([], { hour12: false });
	const logLine = e => `${fmtTime(e.t)} [${e.level}] ${e.source}: ${e.msg}`;
	const byTime = entries => (entries || []).slice().sort((x, y) => x.t - y.t);

	function renderLog(entries) {
		const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 5;
		logEl.innerHTML = byTime(entries)
			.map(e => `<div class="${e.level}">${fmtTime(e.t)} <span class="src">${esc(e.source)}</span> ${esc(e.msg)}</div>`)
			.join("");
		if (atBottom) logEl.scrollTop = logEl.scrollHeight;
	}

	// ---------------------------------------------------------------------------
	// Options
	// ---------------------------------------------------------------------------
	// ReplyTrack's daily LinkedIn limit (shared with outreach): what's left for profiles today.
	chrome.storage.local.get(["orSettings", "orCounts"]).then(s => {
		const limit = Number((s.orSettings || {}).dailyCap ?? 1000) || 0;
		const d = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
		const c = s.orCounts && s.orCounts.day === d ? s.orCounts : {};
		$("dailyCap").value = limit > 0 ? Math.max(1, limit + (c.extra || 0) - (c.n || 0)) : 0;
	});
	const num = (id, def, lo, hi) => Math.min(hi, Math.max(lo, Number($(id).value) || def));
	function readEnrichOptions() {
		const minDelay = num("delayMin", 3, 0.5, 300);
		return {
			minDelay,
			maxDelay: Math.max(minDelay, num("delayMax", 6, 0.5, 600)),
			concurrency: Math.round(num("concurrency", 2, 1, 3)),
			dailyCap: Math.round(Math.min(5000, Math.max(0, Number($("dailyCap").value) || 0))),
			findContacts: $("deepContacts").checked,
			v4: true,
		};
	}
	function readSearchPacing() {
		const minDelay = num("searchMin", 2, 0.5, 120);
		return { minDelay, maxDelay: Math.max(minDelay, num("searchMax", 4, 0.5, 300)) };
	}
	async function saveOptions() {
		await chrome.storage.local.set({
			[OPTS_KEY]: readEnrichOptions(),
			[SEARCH_KEY]: readSearchPacing(),
			[MODE_KEY]: { mode: currentMode(), fillPast: $("fillPast").checked },
		});
	}
	["delayMin", "delayMax", "concurrency", "dailyCap", "searchMin", "searchMax"].forEach(id =>
		$(id).addEventListener("change", () => saveOptions().then(fullRender))
	);
	document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener("change", () => saveOptions().then(fullRender)));
	$("fillPast").addEventListener("change", () => saveOptions().then(fullRender));
	$("deepContacts").addEventListener("change", () => saveOptions().then(fullRender));

	async function loadOptions() {
		const r = await chrome.storage.local.get([OPTS_KEY, SEARCH_KEY, MODE_KEY, "includeProfiles"]);
		let o = r[OPTS_KEY];
		if (o && !o.v4) {
			// v3 saved page-loading defaults (8–15s, 50 profiles) — replace once.
			o = {
				...o,
				maxProfiles: o.maxProfiles === 50 ? 500 : o.maxProfiles,
				minDelay: o.minDelay === 8 ? 3 : o.minDelay,
				maxDelay: o.maxDelay === 15 ? 6 : o.maxDelay,
				v4: true,
			};
		}
		if (o) {
			$("delayMin").value = o.minDelay ?? 3;
			$("delayMax").value = o.maxDelay ?? 6;
			$("concurrency").value = o.concurrency ?? 2;
			$("deepContacts").checked = o.findContacts !== false;
		}
		const sp = r[SEARCH_KEY];
		if (sp) {
			$("searchMin").value = sp.minDelay;
			$("searchMax").value = sp.maxDelay;
		}
		const m = r[MODE_KEY] || { mode: r.includeProfiles ? "full" : "pb", fillPast: false };
		const radio = document.querySelector(`input[name="mode"][value="${m.mode}"]`);
		if (radio) radio.checked = true;
		$("fillPast").checked = !!m.fillPast;
		await saveOptions();
	}

	// ---------------------------------------------------------------------------
	// Estimate
	// ---------------------------------------------------------------------------
	const fmtDur = s => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

	// Time for the past-experience step: ~0.5s per call + the per-worker pause, plus breaks.
	function pastSeconds(n) {
		const o = readEnrichOptions();
		return (n * (0.5 + (o.minDelay + o.maxDelay) / 2)) / o.concurrency + Math.floor(n / 40) * 67;
	}

	// Leads the past-experience step would still have to do (already-filled ones are skipped).
	function pastLeftCount(state, fallback) {
		const stored = state.scrapedLeads || [];
		return stored.length ? stored.filter(l => l.memberId && l.pastStatus !== "done").length : fallback;
	}

	function estimate(state) {
		const detected = state.detectedMaxPages || 0;
		const total = state.detectedTotalResults || 0;
		if (!detected && !total) return "Open a Sales Navigator search to see an estimate.";
		const pages = Math.min(Number(maxPagesInput.value) || 1, detected || PAGE_LIMIT, PAGE_LIMIT);
		const leads = Math.min(pages * 25, total || pages * 25);
		const sp = readSearchPacing();
		// Past 2,500 results the search is split into slices (v5.2): ~1–2 min to size them,
		// plus a few pages read twice where slices overlap.
		const split = leads > 2500;
		const readPages = split ? Math.ceil((leads * 1.05) / 25) : pages;
		const searchS = readPages * (1.2 + (sp.minDelay + sp.maxDelay) / 2) + Math.floor(readPages / 10) * 22 + (split ? 90 : 0);
		let txt = `~${fmtDur(searchS)} for ${pages} page${pages > 1 ? "s" : ""} (~${leads.toLocaleString()} leads${split ? ", split into slices of ≤ 2,500" : ""})`;
		const mode = currentMode();
		const o = readEnrichOptions();
		const pause = (o.minDelay + o.maxDelay) / 2;
		if (mode === "full") {
			const capLeft = o.dailyCap ? Math.max(0, o.dailyCap - (state.todayCount || 0)) : Infinity;
			const n = Math.min(leads, capLeft);
			const s = (n * (2.7 + (o.findContacts ? 0.8 : 0) + pause)) / o.concurrency + Math.floor(n / 40) * 67;
			txt += ` + ~${fmtDur(s)} for ${n.toLocaleString()} profiles`;
			if (n < leads) txt += ` (daily cap: the other ${(leads - n).toLocaleString()} wait for tomorrow's Continue)`;
		} else if (mode === "pb" && $("fillPast").checked) {
			txt += ` + up to ~${fmtDur(pastSeconds(pastLeftCount(state, leads)))} for past experience`;
		}
		return "Estimated time: " + txt + ".";
	}

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------
	function render(state) {
		const leads = state.scrapedLeads || [];
		const config = { active: false, maxPages: 1, currentPage: 1, ...(state.scrapingConfig || {}) };
		const detected = state.detectedMaxPages || 0;
		const es = state.enrichState || {};
		const mode = currentMode();

		$("leadCount").textContent = leads.length;
		$("detectedPagesCount").textContent = detected > 0 ? detected : "--";
		if (document.activeElement !== maxPagesInput) maxPagesInput.value = config.maxPages || 1;

		const withId = leads.filter(l => l.memberId);
		const breakdown = [];
		if (mode === "full" || leads.some(l => l.enrichStatus)) {
			const done = leads.filter(l => l.enrichStatus === "done").length;
			const failed = leads.filter(l => l.enrichStatus === "failed").length;
			const missing = leads.filter(l => l.enrichStatus === "not_found").length;
			const waiting = withId.filter(l => !l.enrichStatus).length;
			$("profileWrap").style.display = "";
			$("profileCount").textContent = `${done}/${withId.length}`;
			if (waiting) breakdown.push(`${waiting} waiting`);
			if (failed) breakdown.push(`${failed} failed`);
			if (missing) breakdown.push(`${missing} unavailable`);
		} else $("profileWrap").style.display = "none";
		if (mode === "pb" && $("fillPast").checked) {
			const pd = leads.filter(l => l.pastStatus === "done").length;
			breakdown.push(`past experience ${pd}/${withId.length}`);
		}
		$("profileBreakdown").textContent = breakdown.join(" · ");

		const job = mode === "full" ? "full" : mode === "pb" && $("fillPast").checked ? "past" : null;
		const willProfiles = !!job;
		if (config.active) {
			toggleBtn.className = "btn-stop";
			$("toggleLabel").textContent = "Stop";
			$("toggleSub").textContent = `${MODES[config.mode || "basic"].short} — search stage running`;
			$("runState").textContent =
				(willProfiles ? "Step 1 of 2 — " : "") + (config.sliceText ? `search results, ${config.sliceText}` : `search results: page ${config.currentPage} of ${config.maxPages}`);
		} else if (es.active) {
			toggleBtn.className = "btn-stop";
			$("toggleLabel").textContent = "Stop";
			$("toggleSub").textContent = es.job === "past" ? "Filling past experience" : "Step 2 of 2 — profiles";
			let eta = "";
			if (es.processed > 2 && es.startedAt) {
				const per = (Date.now() - es.startedAt) / es.processed;
				const left = (per * (es.target - es.processed)) / 1000;
				eta = ` · ~${fmtDur(left)} left`;
			}
			$("runState").textContent =
				`${es.job === "past" ? "Past experience" : "Step 2 of 2 — profiles"}: ${es.processed || 0} of ${es.target || 0} done${eta}` +
				(es.current ? ` · now: ${es.current}` : "");
		} else {
			toggleBtn.className = "btn-start";
			$("toggleLabel").textContent = "Start Auto-Scraping";
			$("toggleSub").textContent =
				MODES[mode].short + (mode === "full" ? " — search, then profiles" : mode === "pb" && $("fillPast").checked ? " — search, then past experience" : " — search only");
			$("runState").textContent = "Idle";
		}

		const pendingForJob = job ? withId.filter(l => (job === "past" ? l.pastStatus !== "done" : !l.enrichStatus || l.enrichStatus === "failed")).length : 0;
		const showContinue = !config.active && !es.active && pendingForJob > 0;
		$("continueBox").style.display = showContinue ? "" : "none";
		if (showContinue) {
			const what = job === "past" ? "past experience + public profile URL" : "full profile data";
			const secs = job === "past" ? pastSeconds(pendingForJob) : (pendingForJob * (2.7 + (readEnrichOptions().minDelay + readEnrichOptions().maxDelay) / 2)) / readEnrichOptions().concurrency;
			$("continueText").textContent =
				`⚠ ${pendingForJob.toLocaleString()} lead${pendingForJob > 1 ? "s are" : " is"} still missing ${what}. ` +
				`Their cells stay empty in the CSV until you continue.`;
			$("profilesOnlyBtn").textContent = `Continue (${pendingForJob.toLocaleString()} left · ~${fmtDur(secs)})`;
		}
		// Standard Run checkbox: say what it costs
		const est = pastLeftCount(state, Math.min((state.detectedTotalResults || 0) || (Number(maxPagesInput.value) || 1) * 25, (Number(maxPagesInput.value) || 1) * 25));
		$("pastInfo").textContent = est ? `— adds ~${fmtDur(pastSeconds(est))} after the search (1 API call per lead)` : "— adds 1 API call per lead after the search";
		$("todayCount").textContent = `Profiles fetched today: ${state.todayCount || 0}.`;
		$("estimate").textContent = estimate(state);
	}

	async function fullRender() {
		const state = await chrome.storage.local.get([
			"scrapedLeads",
			"scrapingConfig",
			"detectedMaxPages",
			"detectedTotalResults",
			"enrichState",
			"dailyProfileCount",
			LOG_KEY,
		]);
		const d = new Date();
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		state.todayCount = state.dailyProfileCount && state.dailyProfileCount.day === day ? state.dailyProfileCount.n : 0;
		render(state);
		renderLog(state[LOG_KEY]);
	}

	let renderTimer = null;
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes[LOG_KEY]) renderLog(changes[LOG_KEY].newValue);
		if (
			changes.scrapedLeads ||
			changes.scrapingConfig ||
			changes.detectedMaxPages ||
			changes.detectedTotalResults ||
			changes.enrichState ||
			changes.dailyProfileCount
		) {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(fullRender, 150); // coalesce bursts from parallel workers
		}
	});

	loadOptions().then(fullRender);

	// ---------------------------------------------------------------------------
	// Tab health check
	// ---------------------------------------------------------------------------
	async function getActiveTab() {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		return tab;
	}

	(async () => {
		const tab = await getActiveTab();
		// Only shown when something needs fixing.
		const warn = t => {
			$("tabWarn").textContent = t;
			$("tabWarn").style.display = "";
		};
		if (tab && profileVanity(tab.url)) return; // profile page: the contact finder is the feature here
		if (!tab || !SN_RE.test(tab.url || "")) return warn("Open a Sales Navigator search tab to start.");
		try {
			await chrome.tabs.sendMessage(tab.id, { type: "DETECT_PAGES" });
		} catch (e) {
			warn("Refresh the Sales Nav tab (the extension can't reach it yet).");
		}
	})();

	// ---------------------------------------------------------------------------
	// Contact finder (only on linkedin.com/in/<vanity> tabs): single lookup. Lookups run
	// in background.js, so closing the popup
	// doesn't cancel them; results are read back from storage.local["cf:<vanity>"].
	// ---------------------------------------------------------------------------
	function profileVanity(url) {
		const m = String(url || "").match(/^https:\/\/www\.linkedin\.com\/in\/([^/?#]+)/i);
		if (!m) return "";
		try {
			return decodeURIComponent(m[1]);
		} catch (e) {
			return m[1];
		}
	}

	// Results live per profile in storage.local["cf:<vanity>"] (written by background.js).
	const CF_STALE_MS = 3 * 60 * 1000; // a "running" entry older than this is treated as dead
	const cfKey = v => "cf:" + v.toLowerCase();
	let cfVanity = "";
	let cfTabId = null;

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function copyButton(input) {
		const b = el("button", "cf-copy", "Copy");
		b.type = "button";
		b.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(input.value);
			} catch (e) {
				input.select();
				document.execCommand("copy");
			}
			b.textContent = "Copied";
			b.classList.add("done");
			setTimeout(() => {
				b.textContent = "Copy";
				b.classList.remove("done");
			}, 1200);
		});
		return b;
	}

	function contactRow(label, items) {
		const row = el("div", "cf-row");
		row.appendChild(el("span", "cf-label", label));
		if (!items.length) {
			row.appendChild(el("div", "cf-none", "Not found"));
			return row;
		}
		for (const it of items) {
			const f = el("div", "cf-field");
			const input = el("input");
			input.type = "text";
			input.readOnly = true;
			input.value = it.value;
			input.addEventListener("focus", () => input.select());
			f.append(input, copyButton(input));
			row.appendChild(f);
			if (it.source) row.appendChild(el("div", "cf-src", `from ${it.source}`));
		}
		return row;
	}

	function uncheckedNote(r) {
		const notes = [];
		if ((r.unchecked || []).includes("contact info section")) notes.push("LinkedIn didn't return the Contact info section this time — try again in a moment.");
		if ((r.unchecked || []).includes("about & other sections")) notes.push("Couldn't read the About and other sections. Try again in a moment.");
		return notes;
	}

	function renderContact(entry) {
		const btn = $("findContactBtn");
		const out = $("contactResult");
		const running = !!entry && entry.status === "running" && Date.now() - (entry.startedAt || 0) < CF_STALE_MS;
		btn.disabled = running;
		btn.textContent = running ? "Fetching..." : "Find contact info";
		out.replaceChildren();
		const r = !running && entry && entry.result;
		out.style.display = r ? "" : "none";
		if (!r) return;
		if (!r.ok) {
			out.appendChild(el("div", "cf-error", r.error || "Couldn't read this profile."));
			return;
		}
		const emails = (r.emails || []).slice(0, 3);
		const phones = (r.phones || []).slice(0, 3);
		const contactUnchecked = (r.unchecked || []).includes("contact info section");
		if (!emails.length && !phones.length) out.appendChild(el("div", "cf-none all", contactUnchecked ? "Not found in About & other sections" : "Not found"));
		else out.append(contactRow(emails.length > 1 ? "Emails" : "Email", emails), contactRow(phones.length > 1 ? "Phone numbers" : "Phone number", phones));
		for (const n of uncheckedNote(r)) out.appendChild(el("div", "cf-note", n));
	}

	async function loadContact() {
		const r = await chrome.storage.local.get(cfKey(cfVanity));
		renderContact(r[cfKey(cfVanity)]);
	}

	(async () => {
		const tab = await getActiveTab();
		cfVanity = profileVanity(tab && tab.url);
		if (!cfVanity) return; // Sales Nav (or any other page): UI unchanged
		cfTabId = tab.id;
		$("contactBox").style.display = "";
		await loadContact();
	})();

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !cfVanity) return;
		if (changes[cfKey(cfVanity)]) renderContact(changes[cfKey(cfVanity)].newValue);
	});

	$("findContactBtn").addEventListener("click", async () => {
		if (!cfVanity || !cfTabId) return;
		renderContact({ status: "running", startedAt: Date.now() });
		try {
			const res = await chrome.runtime.sendMessage({ type: "CONTACT_FIND", tabId: cfTabId, vanity: cfVanity });
			if (!res || !res.ok) renderContact({ status: "done", result: { ok: false, error: (res && res.error) || "Couldn't start the lookup." } });
		} catch (e) {
			renderContact({ status: "done", result: { ok: false, error: e.message } });
		}
	});

	// ---------------------------------------------------------------------------
	// Pages input
	// ---------------------------------------------------------------------------
	async function saveMaxPages(val) {
		const res = await chrome.storage.local.get("scrapingConfig");
		await chrome.storage.local.set({ scrapingConfig: { active: false, currentPage: 1, ...(res.scrapingConfig || {}), maxPages: val } });
	}
	maxPagesInput.addEventListener("input", () => {
		const v = parseInt(maxPagesInput.value, 10);
		if (v >= 1) saveMaxPages(Math.min(v, PAGE_LIMIT));
		fullRender();
	});
	maxPagesInput.addEventListener("change", () => {
		let v = parseInt(maxPagesInput.value, 10);
		if (!(v >= 1)) v = 1;
		v = Math.min(v, PAGE_LIMIT);
		maxPagesInput.value = v;
		saveMaxPages(v);
	});

	// ---------------------------------------------------------------------------
	// Start / Stop
	// ---------------------------------------------------------------------------
	async function stopAll() {
		const res = await chrome.storage.local.get(["scrapingConfig", "enrichState"]);
		await chrome.storage.local.set({ scrapingConfig: { ...(res.scrapingConfig || {}), active: false, stoppedByUser: true } });
		if (res.enrichState && res.enrichState.active) await chrome.runtime.sendMessage({ type: "ENRICH_STOP" }).catch(() => {});
		const tab = await getActiveTab();
		if (tab && SN_RE.test(tab.url || "")) chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPING" }).catch(() => {});
		await plog("info", "Stop clicked.");
	}

	toggleBtn.addEventListener("click", async () => {
		const res = await chrome.storage.local.get(["scrapingConfig", "enrichState"]);
		if ((res.scrapingConfig && res.scrapingConfig.active) || (res.enrichState && res.enrichState.active)) {
			await stopAll();
			return;
		}
		const tab = await getActiveTab();
		if (!tab || !SN_RE.test(tab.url || "")) {
			alert("Please open a LinkedIn Sales Navigator search results page first!");
			return;
		}
		await saveOptions();
		const mode = currentMode();
		const maxPages = Math.min(Math.max(parseInt(maxPagesInput.value, 10) || 1, 1), PAGE_LIMIT);
		const startFromCurrent = $("startFromCurrent").checked;
		const fillPast = $("fillPast").checked;
		await chrome.storage.local.set({
			scrapingConfig: { active: true, maxPages, currentPage: 1, startFromCurrent, mode, fillPast, includeProfiles: mode === "full" },
		});
		const u = new URL(tab.url);
		const what = `${MODES[mode].label}${mode === "pb" && fillPast ? " + past experience" : ""}, ${maxPages} search page(s)`;
		await plog("start", `════════ RUN STARTED — ${what}${startFromCurrent ? " (resume)" : ""} ════════`);
		if (!startFromCurrent && u.searchParams.has("page") && u.searchParams.get("page") !== "1") {
			u.searchParams.set("page", "1");
			await plog("info", `Start: ${what}, from page 1.`);
			chrome.tabs.update(tab.id, { url: u.toString() });
		} else {
			await plog("info", `Start: ${what}${startFromCurrent ? " (resume)" : ""}. Reloading tab…`);
			chrome.tabs.reload(tab.id);
		}
	});

	$("profilesOnlyBtn").addEventListener("click", async () => {
		await saveOptions();
		const mode = currentMode();
		const job = mode === "pb" ? "past" : "full";
		await plog("start", `════════ CONTINUE STARTED — ${job === "past" ? "past experience" : "Deep Run profiles"} ════════`);
		const res = await chrome.runtime.sendMessage({ type: "ENRICH_START", options: { ...readEnrichOptions(), job, retryAll: true } });
		if (!res || !res.ok) alert((res && res.error) || "Couldn't start.");
	});

	$("clearLeadsBtn").addEventListener("click", async () => {
		if (!confirm("Delete all captured leads (including profile data)?")) return;
		const all = await chrome.storage.local.get(null);
		await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith("p:")).concat("searchProgress"));
		await chrome.storage.local.set({ scrapedLeads: [] });
		plog("info", "Cleared captured leads.");
	});

	$("clearLogBtn").addEventListener("click", () => {
		chrome.storage.local.set({ [LOG_KEY]: [] });
	});
	$("copyLogBtn").addEventListener("click", async () => {
		const res = await chrome.storage.local.get(LOG_KEY);
		const txt = byTime(res[LOG_KEY]).map(logLine).join("\n");
		try {
			await navigator.clipboard.writeText(txt);
			$("copyLogBtn").textContent = "Copied";
			setTimeout(() => ($("copyLogBtn").textContent = "Copy"), 1200);
		} catch (e) {
			console.log(txt);
			alert("Clipboard blocked — log printed to the popup console instead.");
		}
	});
});

// ReplyTrack: this popup opens from ReplyTrack's toolbar icon on Sales Navigator and profile
// pages — this link gets to the dashboard from there.
document.getElementById("openDashboard")?.addEventListener("click", e => {
	e.preventDefault();
	chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
	window.close();
});
