// Isolated-world content script. Runs at document_start so its message
// listener exists before Sales Nav's first search API response arrives.
(() => {
	const TAG = "[SN-Scraper:content]";
	const LOG_KEY = "debugLog";
	const MAX_LOG = 200;
	const RESULTS_PER_PAGE = 25;
	const SN_CAP = 2500; // Sales Navigator lists at most this many results per search (100 pages)
	const PAGE_LIMIT = 400; // "Search pages to scrape" upper bound (10,000 results)
	const DEFAULT_CONFIG = { active: false, maxPages: 1, currentPage: 1 };

	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const jitter = (min, max) => min + Math.random() * (max - min);

	// ---------------------------------------------------------------------------
	// Logging: console + a rolling buffer in storage that the popup displays
	// ---------------------------------------------------------------------------
	function extAlive() {
		try {
			return !!(chrome.runtime && chrome.runtime.id);
		} catch (e) {
			return false;
		}
	}

	let logQueue = [];
	let flushTimer = null;

	function pushLog(level, source, msg) {
		logQueue.push({ t: Date.now(), level, source, msg });
		if (!flushTimer) flushTimer = setTimeout(flushLogs, 400);
	}

	async function flushLogs() {
		flushTimer = null;
		if (!extAlive()) {
			console.warn(TAG, "Extension was reloaded — refresh this tab so the new content script runs.");
			logQueue = [];
			return;
		}
		const batch = logQueue;
		logQueue = [];
		try {
			const res = await chrome.storage.local.get(LOG_KEY);
			const all = (res[LOG_KEY] || []).concat(batch).slice(-MAX_LOG);
			await chrome.storage.local.set({ [LOG_KEY]: all });
		} catch (e) {
			console.warn(TAG, "log flush failed", e);
		}
	}

	function log(level, msg, extra) {
		const fn = level === "debug" ? console.log : console[level] || console.log;
		extra !== undefined ? fn.call(console, TAG, msg, extra) : fn.call(console, TAG, msg);
		if (level !== "debug") pushLog(level, "content", msg);
	}

	// ---------------------------------------------------------------------------
	// Config helpers
	// ---------------------------------------------------------------------------
	async function getConfig() {
		const r = await chrome.storage.local.get("scrapingConfig");
		return { ...DEFAULT_CONFIG, ...(r.scrapingConfig || {}) };
	}

	async function patchConfig(patch) {
		const next = { ...(await getConfig()), ...patch };
		await chrome.storage.local.set({ scrapingConfig: next });
		return next;
	}

	// ---------------------------------------------------------------------------
	// Saving leads — serialized so concurrent saves can't overwrite each other
	// ---------------------------------------------------------------------------
	let saveChain = Promise.resolve();
	let runAdded = 0; // new leads added during the current run
	let apiPaging = null; // latest {start, count, total} from a search response
	const apiBatches = new Map(); // search API result offset → {n, skipped, total, keys}
	const leadKey = l => (l.memberId || `${l.name}|${l.company}`).toLowerCase();

	function saveLeads(newLeads, source) {
		saveChain = saveChain
			.then(async () => {
				if (!extAlive()) {
					console.warn(TAG, "Extension context invalidated — refresh the tab.");
					return;
				}
				const cfg = await getConfig();
				if (!cfg.active) {
					log("debug", `${source}: ${newLeads.length} lead(s) ignored (scraper not active).`);
					return;
				}

				const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
				const index = new Map(scrapedLeads.map((l, i) => [leadKey(l), i]));
				let added = 0;
				let updated = 0;

				for (const lead of newLeads) {
					const k = leadKey(lead);
					if (index.has(k)) {
						// Fill in any fields the earlier copy was missing (API vs DOM).
						const existing = scrapedLeads[index.get(k)];
						let changed = false;
						for (const f of Object.keys(lead)) {
							if (!existing[f] && lead[f]) {
								existing[f] = lead[f];
								changed = true;
							}
						}
						if (changed) updated++;
					} else {
						index.set(k, scrapedLeads.length);
						scrapedLeads.push(lead);
						added++;
					}
				}

				runAdded += added;
				if (added || updated) await chrome.storage.local.set({ scrapedLeads });
				log("info", `${source}: +${added} new, ${updated} enriched. Total stored: ${scrapedLeads.length}`);
			})
			.catch(e => log("error", `Save failed: ${e.message}`));
		return saveChain;
	}

	// ---------------------------------------------------------------------------
	// Messages from injected.js (page) and popup
	// ---------------------------------------------------------------------------
	window.addEventListener("message", e => {
		if (e.source !== window || !e.data) return;
		if (e.data.type === "SN_SCRAPER_LOG") {
			pushLog(e.data.level, "api", e.data.msg);
		} else if (e.data.type === "SALES_NAV_INTERCEPTED_LEADS" && Array.isArray(e.data.payload)) {
			if (e.data.start != null) {
				apiBatches.set(e.data.start, {
					n: e.data.payload.length,
					skipped: e.data.skipped || 0,
					total: e.data.total,
					keys: e.data.payload.map(leadKey),
				});
			}
			saveLeads(e.data.payload, "API");
		} else if (e.data.type === "SN_NATIVE_PROFILE_DECO" && e.data.deco) {
			chrome.storage.local.get("nativeProfileDecoration").then(r => {
				if (r.nativeProfileDecoration !== e.data.deco) {
					chrome.storage.local.set({ nativeProfileDecoration: e.data.deco });
					log("info", "Learned Sales Nav's own profile request (includes job history) — past-experience lookups will use it.");
				}
			});
		} else if (e.data.type === "SN_SCRAPER_PAGING" && e.data.paging) {
			apiPaging = e.data.paging;
		}
	});

	let stopRequested = false;

	// ---------------------------------------------------------------------------
	// Step 2 relay: background → here → api-helper.js (page) → back.
	// ---------------------------------------------------------------------------
	let apiSeq = 0;
	// Generic request/response with api-helper.js (MAIN world).
	function callHelper(type, payload = {}, timeout = 45000) {
		const id = `${Date.now()}-${++apiSeq}`;
		return new Promise(resolve => {
			const t = setTimeout(() => {
				window.removeEventListener("message", onMsg);
				resolve({ ok: false, error: `${type}: no answer from the page helper (refresh the Sales Nav tab)` });
			}, timeout);
			function onMsg(e) {
				if (e.source !== window || !e.data || e.data.type !== type + "_RESPONSE" || e.data.id !== id) return;
				clearTimeout(t);
				window.removeEventListener("message", onMsg);
				resolve(e.data.result);
			}
			window.addEventListener("message", onMsg);
			window.postMessage({ type, id, ...payload }, location.origin);
		});
	}

	function callApiHelper(lead, preferred, timeout = 70000) {
		const id = `${Date.now()}-${++apiSeq}`;
		return new Promise(resolve => {
			const t = setTimeout(() => {
				window.removeEventListener("message", onMsg);
				resolve({ ok: false, error: "API helper didn't answer (refresh this Sales Nav tab)", log: [] });
			}, timeout);
			function onMsg(e) {
				if (e.source !== window || !e.data || e.data.type !== "SN_API_RESPONSE" || e.data.id !== id) return;
				clearTimeout(t);
				window.removeEventListener("message", onMsg);
				resolve(e.data.result);
			}
			window.addEventListener("message", onMsg);
			window.postMessage({ type: "SN_API_REQUEST", id, lead, preferred }, location.origin);
		});
	}

	function mapContact(ci) {
		const out = { email: [], phone: [], websites: [], other: [] };
		if (!ci || typeof ci !== "object") return out;
		const label = t => (t ? ` (${String(t).toLowerCase().replace(/_/g, " ")})` : "");
		for (const [k, v] of Object.entries(ci)) {
			const arr = Array.isArray(v) ? v : v ? [v] : [];
			if (!arr.length) continue;
			if (/email/i.test(k)) out.email.push(...arr.map(x => (typeof x === "string" ? x : x.emailAddress || x.email || x.value)).filter(Boolean));
			else if (/phone/i.test(k)) out.phone.push(...arr.map(x => (typeof x === "string" ? x : (x.number || x.value || "") + label(x.type))).filter(s => s.trim()));
			else if (/website/i.test(k)) out.websites.push(...arr.map(x => (typeof x === "string" ? x : (x.url || x.value || "") + label(x.category || x.type))).filter(s => s.trim()));
			else {
				const vals = arr.map(x => (typeof x === "string" ? x : x.name || x.handle || x.value || x.address || "")).filter(Boolean);
				if (vals.length) out.other.push(`${k.replace(/Handles?$/, "").replace(/([A-Z])/g, " $1").trim()}: ${vals.join(", ")}`);
			}
		}
		return out;
	}

	// Sales Nav positions → our experience shape, keeping the richer Voyager
	// entry (location, employment type…) wherever both have the same role.
	function mergeExperience(voyagerExp, positions) {
		const { fmtDate, duration } = window.SNVoyagerMap;
		const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
		const byKey = new Map(voyagerExp.map(e => [`${norm(e.title)}|${norm(e.company)}`, e]));
		const used = new Set();
		const out = positions.map(p => {
			const k = `${norm(p.title)}|${norm(p.companyName)}`;
			if (byKey.has(k) && !used.has(k)) {
				used.add(k);
				return byKey.get(k);
			}
			const range = { dateRange: { start: p.startedOn || null, end: p.current ? null : p.endedOn || null } };
			const s = fmtDate(p.startedOn);
			const e = p.current || !p.endedOn ? (s ? "Present" : "") : fmtDate(p.endedOn);
			return {
				title: p.title || "",
				company: p.companyName || "",
				employmentType: "",
				dates: s && e ? `${s} - ${e}` : s || e,
				duration: duration(range),
				location: typeof p.location === "string" ? p.location : "",
				workplaceType: "",
				description: p.description || "",
			};
		});
		for (const [k, e] of byKey) if (!used.has(k)) out.push(e); // never drop a Voyager role
		return out;
	}

	// Mode 2 option: just the lead's Sales Nav positions, for the pastExperience* columns.
	async function fetchPastForBackground(lead) {
		const { nativeProfileDecoration: nativeDeco } = await chrome.storage.local.get("nativeProfileDecoration");
		const r = await callHelper("SN_PAST_POSITIONS", { lead, nativeDeco }, 60000);
		if (!r || !r.ok) return { ...(r || {}), ok: false, log: (r && r.log) || [] };
		const past = r.positions.filter(p => !p.current && (p.endedOn || p.startedOn));
		past.sort((a, b) => ((b.endedOn || {}).year || 0) * 12 + ((b.endedOn || {}).month || 0) - (((a.endedOn || {}).year || 0) * 12 + ((a.endedOn || {}).month || 0)));
		const p = past[0] || null;
		return {
			ok: true,
			vanityUrl: r.flagshipProfileUrl || "",
			pastPosition: p ? { title: p.title || "", companyName: p.companyName || "", companyUrn: p.companyUrn || "", startedOn: p.startedOn || null, endedOn: p.endedOn || null } : null,
			timings: r.timings || {},
			log: r.log || [],
		};
	}

	async function fetchProfileForBackground(lead) {
		const { voyagerDecoration: preferred } = await chrome.storage.local.get("voyagerDecoration");
		const r = await callApiHelper(lead, preferred);
		if (!r.ok) return { ...r, profile: undefined, sales: undefined };
		if (r.decoration && r.decoration !== preferred) chrome.storage.local.set({ voyagerDecoration: r.decoration });
		const m = window.SNVoyagerMap.mapProfile(r.profile);
		if (!m.data.about && r.sales && r.sales.summary) m.data.about = r.sales.summary;
		let truncated = m.truncatedInfo || [];
		let experienceFrom = "";
		if (Array.isArray(r.salesPositions) && r.salesPositions.length > m.data.experience.length) {
			m.data.experience = mergeExperience(m.data.experience, r.salesPositions);
			truncated = truncated.filter(x => !/^experience|^roles at/.test(x));
			experienceFrom = `experience completed from Sales Nav (${m.data.experience.length} roles)`;
		}
		return {
			ok: true,
			data: m.data,
			truncated,
			experienceFrom,
			salesOk: r.salesOk,
			timings: r.timings || {},
			contact: mapContact(r.sales && r.sales.contactInfo),
			publicProfileUrl: r.vanity ? `https://www.linkedin.com/in/${r.vanity}/` : m.publicIdentifier ? `https://www.linkedin.com/in/${m.publicIdentifier}/` : "",
			publicIdentifier: r.vanity || m.publicIdentifier || "",
			headline: m.headline || "",
			firstName: m.firstName || "",
			lastName: m.lastName || "",
			searchFields: m.searchFields || {},
			decoration: r.decoration.split(".").pop(),
			vanityHow: r.vanityHow,
			log: r.log,
		};
	}

	chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
		if (msg.type === "PROFILE_FETCH") {
			const job = msg.job === "past" ? fetchPastForBackground(msg.lead) : fetchProfileForBackground(msg.lead);
			job.then(sendResponse, e => sendResponse({ ok: false, error: e.message, log: [] }));
			return true;
		}
		if (msg.type === "PING") {
			sendResponse({ ok: true, path: location.pathname });
			return;
		}
		if (msg.type === "STOP_SCRAPING") {
			stopRequested = true;
			log("info", "Stop requested from popup.");
			patchConfig({ active: false, stoppedByUser: true });
			sendResponse({ ok: true });
		} else if (msg.type === "DETECT_PAGES") {
			const pages = detectTotalPages(true);
			sendResponse({
				pages,
				leadRows: getLeadRows().length,
				currentPage: readCurrentPage(),
				url: location.href,
			});
		}
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.scrapingConfig) {
			const nv = changes.scrapingConfig.newValue;
			// Only an explicit Stop counts. The loop also sets active=false itself
			// when step 1 finishes, and that must NOT cancel step 2 (v2.1 bug).
			if (nv && !nv.active && nv.stoppedByUser) stopRequested = true;
		}
	});

	// Ask injected.js to replay anything it caught before we were listening.
	window.postMessage({ type: "SN_SCRAPER_READY" }, location.origin);

	// ---------------------------------------------------------------------------
	// DOM helpers
	// ---------------------------------------------------------------------------
	async function waitFor(fn, timeout = 15000, interval = 300) {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const v = fn();
			if (v) return v;
			await sleep(interval);
		}
		return null;
	}

	function describe(el) {
		if (!el) return "none";
		const cls =
			typeof el.className === "string" && el.className.trim()
				? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
				: "";
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
	}

	const getLeadAnchors = () => Array.from(document.querySelectorAll('a[href*="/sales/lead/"]'));

	function getLeadRows() {
		const rows = new Set();
		for (const a of getLeadAnchors()) {
			const row = a.closest("li.artdeco-list__item") || a.closest("li");
			if (row) rows.add(row);
		}
		return [...rows];
	}

	const firstLeadHref = () => {
		const a = getLeadAnchors()[0];
		return a ? a.getAttribute("href") : null;
	};

	// ---------------------------------------------------------------------------
	// Scrolling — Sales Nav scrolls an inner container, not the window, and only
	// renders rows' text once they come into view.
	// ---------------------------------------------------------------------------
	function findScrollContainer() {
		const byId = document.querySelector("#search-results-container");
		if (byId && byId.scrollHeight > byId.clientHeight + 10) return byId;

		let el = getLeadAnchors()[0];
		while (el && el !== document.body) {
			const s = getComputedStyle(el);
			if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
			el = el.parentElement;
		}
		return document.scrollingElement || document.documentElement;
	}

	async function scrollThroughResults() {
		const sc = findScrollContainer();
		log("info", `Scrolling results in <${describe(sc)}>`);
		sc.scrollTop = 0;
		await sleep(300);

		for (let i = 0; i < 40; i++) {
			const before = sc.scrollTop;
			sc.scrollTop = before + Math.max(200, sc.clientHeight * 0.7);
			await sleep(jitter(400, 700));
			if (sc.scrollTop === before) break; // reached bottom
		}
		await sleep(800);
	}

	// ---------------------------------------------------------------------------
	// DOM extraction (fallback / enrichment for the API path)
	// ---------------------------------------------------------------------------
	function firstText(root, selectors) {
		for (const s of selectors) {
			const el = root.querySelector(s);
			const t = el && el.innerText && el.innerText.trim();
			if (t) return t.split("\n")[0].trim();
		}
		return "";
	}

	function parseLeadHref(href) {
		let decoded = href || "";
		try {
			decoded = decodeURIComponent(decoded);
		} catch (e) {}
		const m = decoded.match(/\/sales\/lead\/([^/?#]+)/);
		if (!m) return { inner: "", memberId: "" };
		return { inner: m[1], memberId: m[1].split(",")[0] };
	}

	function extractDOMLeads() {
		const rows = getLeadRows();
		const leads = [];
		let unnamed = 0;

		for (const row of rows) {
			// FIX: the first /sales/lead/ link in a row is usually the *photo*,
			// which has no text. Prefer the dedicated name element.
			const nameEl =
				row.querySelector('[data-anonymize="person-name"]') ||
				Array.from(row.querySelectorAll('a[href*="/sales/lead/"]')).find(
					a => a.innerText && a.innerText.trim()
				);
			const name = nameEl ? nameEl.innerText.trim().split("\n")[0].trim() : "";
			if (!name || name === "LinkedIn Member") {
				unnamed++;
				continue;
			}

			const linkEl =
				(nameEl && nameEl.closest('a[href*="/sales/lead/"]')) ||
				row.querySelector('a[href*="/sales/lead/"]');
			const { inner, memberId } = parseLeadHref(linkEl ? linkEl.getAttribute("href") : "");

			leads.push({
				name,
				title: firstText(row, [
					'[data-anonymize="title"]',
					'[data-anonymize="job-title"]',
					".artdeco-entity-lockup__subtitle",
				]),
				company: firstText(row, [
					'[data-anonymize="company-name"]',
					'a[href*="/sales/company/"]',
					".artdeco-entity-lockup__caption",
				]),
				location: firstText(row, ['[data-anonymize="location"]', ".artdeco-entity-lockup__metadata"]),
				memberId,
				publicProfileUrl: memberId.startsWith("AC") ? `https://www.linkedin.com/in/${memberId}` : "",
				salesNavProfileUrl: inner ? `https://www.linkedin.com/sales/lead/${inner}` : "",
				source: "dom",
			});
		}

		return { leads, rows: rows.length, unnamed };
	}

	// ---------------------------------------------------------------------------
	// Page count detection
	// ---------------------------------------------------------------------------
	let lastDetected = null;

	function detectTotalPages(verbose = false) {
		const found = {};

		// A) "Page 1 of 2" — this number IS the page count (old code treated it
		//    as a result count and divided by 25, giving 1).
		const stateEl = document.querySelector(".artdeco-pagination__page-state");
		if (stateEl) {
			const m = stateEl.innerText.match(/of\s+([\d,]+)/i);
			if (m) found.pageState = parseInt(m[1].replace(/,/g, ""), 10);
		}

		// B) Highest numbered pagination button
		let maxBtn = 0;
		document
			.querySelectorAll(".artdeco-pagination__pages li, button[aria-label^='Page ']")
			.forEach(el => {
				const src = el.getAttribute("aria-label") || el.innerText || "";
				const m = src.match(/(\d+)/);
				if (m) maxBtn = Math.max(maxBtn, parseInt(m[1], 10));
			});
		if (maxBtn) found.pageButtons = maxBtn;

		// C) "45 results" text -> ceil(45 / 25)
		const countEl = Array.from(document.querySelectorAll("span, div, p, h1, h2, h3")).find(
			el => el.childElementCount === 0 && /^\s*[\d,]+\s+results?\s*$/i.test(el.textContent)
		);
		if (countEl) {
			const n = parseInt(countEl.textContent.replace(/[^\d]/g, ""), 10);
			if (n) found.resultCount = Math.ceil(n / RESULTS_PER_PAGE);
		}

		// D) Result total from the API response. Reported alongside the others,
		//    but NOT allowed to lower the count: over-estimating is harmless (the
		//    run stops at the disabled "Next"), under-estimating loses pages.
		if (apiPaging && apiPaging.total > 0) {
			found.apiTotal = Math.ceil(apiPaging.total / RESULTS_PER_PAGE);
		}

		const values = Object.values(found).filter(n => n > 0);
		if (!values.length) {
			// FIX: don't write "1" when pagination simply hasn't rendered yet.
			if (verbose) log("warn", "Page detection: no pagination found yet (try scrolling to the bottom).");
			return null;
		}

		const pages = Math.min(PAGE_LIMIT, Math.max(...values));
		if (pages !== lastDetected || verbose) {
			const totalTxt = apiPaging ? `, API result total=${apiPaging.total}` : "";
			log("info", `Detected ${pages} page(s) — sources: ${JSON.stringify(found)}${totalTxt}`);
		}
		const isNew = pages !== lastDetected;
		lastDetected = pages;
		chrome.storage.local.set({ detectedMaxPages: pages, ...(apiPaging && apiPaging.total ? { detectedTotalResults: apiPaging.total } : {}) });
		// Pre-fill "Search pages to scrape" with the total — only when a new count
		// is detected (so a value the user typed afterwards is left alone) and
		// never while a run is using that setting.
		if (isNew) {
			getConfig().then(cfg => {
				if (!cfg.active && cfg.maxPages !== pages) patchConfig({ maxPages: pages });
			});
		}
		return pages;
	}

	function findNextButton() {
		return (
			document.querySelector("button.artdeco-pagination__button--next") ||
			document.querySelector("button[aria-label='Next']") ||
			Array.from(document.querySelectorAll("button")).find(b => /^\s*next\s*$/i.test(b.innerText))
		);
	}

	// ---------------------------------------------------------------------------
	// Main loop. Sales Nav is a single-page app: clicking "Next" does NOT reload
	// the page, so this loop has to drive every page itself.
	// ---------------------------------------------------------------------------
	let loopRunning = false;

	// The real Sales Nav page number currently shown (not the run counter).
	function readCurrentPage() {
		const stateEl = document.querySelector(".artdeco-pagination__page-state");
		if (stateEl) {
			const m = stateEl.innerText.match(/page\s+(\d+)/i);
			if (m) return parseInt(m[1], 10);
		}
		const activeBtn = document.querySelector(
			".artdeco-pagination__indicator--number.active button, .artdeco-pagination__pages button[aria-current='true']"
		);
		if (activeBtn) {
			const n = parseInt(activeBtn.innerText, 10);
			if (n) return n;
		}
		const p = new URLSearchParams(location.search).get("page");
		return p ? parseInt(p, 10) : null;
	}

	// Backup for the popup's URL rewrite: if we're still not on page 1, click "1".
	async function ensureFirstPage() {
		const cur = readCurrentPage();
		if (!cur || cur === 1) return true;
		log("info", `Tab is on page ${cur}; jumping to page 1 before scraping.`);
		const btn = Array.from(
			document.querySelectorAll(".artdeco-pagination__pages button, button[aria-label='Page 1']")
		).find(b => (b.getAttribute("aria-label") || b.innerText).trim().match(/^(page\s+)?1$/i));
		if (!btn) {
			log("error", `Can't find a "page 1" button (tab is on page ${cur}). Go to page 1 manually and press Start.`);
			return false;
		}
		const before = firstLeadHref();
		btn.click();
		const changed = await waitFor(() => {
			const h = firstLeadHref();
			return h && h !== before;
		}, 20000);
		if (!changed) log("error", "Results didn't change after clicking page 1.");
		await sleep(1500);
		return !!changed;
	}

	async function collectCurrentPage(runPage) {
		// If the search API already delivered every result on this page, the DOM
		// pass (≈5s of scrolling) can't add anything — skip it.
		const pageNo = readCurrentPage() || runPage;
		const start = (pageNo - 1) * RESULTS_PER_PAGE;
		const complete = () => {
			const b = apiBatches.get(start);
			if (!b || b.total == null) return null;
			const expected = Math.min(RESULTS_PER_PAGE, b.total - start);
			return b.n + b.skipped >= expected ? b : null;
		};
		const batch = await waitFor(complete, 4000, 250);
		let stored = false;
		if (batch) {
			await saveChain;
			const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
			const have = new Set(scrapedLeads.map(leadKey));
			stored = batch.keys.every(k => have.has(k));
		}
		if (batch && stored) {
			log("info", `Page ${pageNo} (run page ${runPage}): API delivered all ${batch.n} lead(s)${batch.skipped ? ` (+${batch.skipped} anonymous)` : ""} — no scrolling needed.`);
			return { rows: batch.n, keys: batch.keys, realPage: pageNo };
		}
		await scrollThroughResults();
		const realPage = readCurrentPage();
		const label = realPage ? `Page ${realPage}` : `Page ?`;
		const { leads, rows, unnamed } = extractDOMLeads();
		if (!rows) {
			log(
				"warn",
				`${label} (run page ${runPage}): 0 result rows found (${getLeadAnchors().length} lead links). Selectors may be outdated.`
			);
		} else {
			log(
				"info",
				`${label} (run page ${runPage}): DOM rows=${rows}, parsed=${leads.length}, skipped (no name)=${unnamed}`
			);
		}
		if (leads.length) await saveLeads(leads, `DOM p${realPage || runPage}`);
		return { rows, keys: leads.map(leadKey), realPage };
	}

	async function logRunSummary(run) {
		await saveChain;
		const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
		const storedKeys = new Set(scrapedLeads.map(leadKey));
		const missing = run.keys.filter(k => !storedKeys.has(k)).length;
		const range =
			run.firstPage && run.lastPage ? `pages ${run.firstPage}–${run.lastPage}` : `${run.pages} page(s)`;
		log(
			missing ? "warn" : "info",
			`Run summary: ${run.rows} result rows on ${range}; ${runAdded} new leads this run; ` +
				`${scrapedLeads.length} total stored.` +
				(missing ? ` ${missing} on-screen lead(s) did NOT get stored.` : " Every on-screen lead is stored.")
		);
	}

	// Step 2: hand over to the background worker, which visits each lead's
	// LinkedIn profile in its own window.
	async function startProfileStep() {
		const cfg = await getConfig();
		if (cfg.stoppedByUser) return;
		const mode = cfg.mode || (cfg.includeProfiles ? "full" : "basic");
		let job = null;
		if (mode === "full") job = "full";
		else if (mode === "pb" && cfg.fillPast) job = "past";
		if (!job) {
			log("info", `Done. Export with "Export CSV" (${mode === "pb" ? "PhantomBuster format" : "basic format"}).`);
			return;
		}
		log("info", job === "full" ? "Step 1 done — starting step 2 (each lead's profile)." : "Step 1 done — filling past-experience columns.");
		const { enrichOptions } = await chrome.storage.local.get("enrichOptions");
		try {
			const res = await chrome.runtime.sendMessage({ type: "ENRICH_START", options: { ...(enrichOptions || {}), job } });
			if (res && !res.ok) log(res.nothingToDo ? "info" : "warn", `${job === "past" ? "Past experience" : "Step 2 — profiles"}: ${res.error}`);
		} catch (e) {
			log("error", `Couldn't start profile scraping: ${e.message}`);
		}
	}

	// ---------------------------------------------------------------------------
	// Search stage, fast path: ask api-helper to replay the page's own
	// salesApiLeadSearch request with start=25, 50, … (no rendering, no clicks).
	// Pacing is per PAGE here (the profile stage paces per profile).
	// ---------------------------------------------------------------------------
	const stat = arr => {
		if (!arr.length) return "–";
		const s = arr.slice().sort((a, b) => a - b);
		const avg = s.reduce((x, y) => x + y, 0) / s.length;
		return `avg ${(avg / 1000).toFixed(1)}s, p90 ${(s[Math.floor(s.length * 0.9)] / 1000).toFixed(1)}s`;
	};

	async function pageViaApi(run, firstPageNo, config, cap = SN_CAP) {
		const { searchPacing: sp = {} } = await chrome.storage.local.get("searchPacing");
		const dMin = Math.max(0.5, Number(sp.minDelay) || 2);
		const dMax = Math.max(dMin, Number(sp.maxDelay) || 4);
		const t = { req: [], parse: [], pause: [] };
		const t0 = Date.now();
		let untilLong = 9 + Math.floor(Math.random() * 3); // long pause every ~10 pages (jittered)
		const lastPageNo = firstPageNo + config.maxPages - 1;

		for (let pageNo = firstPageNo + 1; pageNo <= lastPageNo; pageNo++) {
			const start = (pageNo - 1) * RESULTS_PER_PAGE;
			const b0 = apiBatches.get(0) || apiBatches.get((firstPageNo - 1) * RESULTS_PER_PAGE);
			const total = (apiPaging && apiPaging.total) || (b0 && b0.total) || null;
			if (total != null && start >= Math.min(total, cap)) {
				log("info", `Reached the end of the results (${total} total${total > cap ? `, Sales Nav shows at most ${cap.toLocaleString()}` : ""}).`);
				break;
			}

			// pause (per page), with a longer break every ~10 pages
			let pause = (dMin + Math.random() * (dMax - dMin)) * 1000;
			if (--untilLong <= 0) {
				untilLong = 9 + Math.floor(Math.random() * 3);
				pause = (15 + Math.random() * 15) * 1000;
				log("info", `Short break (${Math.round(pause / 1000)}s) before page ${pageNo}.`);
			}
			const pEnd = Date.now() + pause;
			while (Date.now() < pEnd) {
				if (stopRequested || !(await getConfig()).active) {
					log("info", "Stopped by user.");
					return "stopped";
				}
				await sleep(Math.min(300, pEnd - Date.now()));
			}
			t.pause.push(pause);

			let r = await callHelper("SN_SEARCH_PAGE", { start }, 40000);
			if (r && r.noRequest) return pageNo === firstPageNo + 1 ? "fallback" : "done";
			if (r && !r.ok && !r.fatal) {
				log("warn", `Page ${pageNo}: ${r.error} — retrying once in 5s.`);
				await sleep(5000);
				r = await callHelper("SN_SEARCH_PAGE", { start }, 40000);
			}
			if (!r || !r.ok) {
				log("error", `Page ${pageNo}: ${(r && r.error) || "no answer"}. Stopping search stage — use "Start from the current page (resume)" to continue.`);
				await patchConfig({ stoppedByUser: !!(r && r.fatal) });
				return "error";
			}
			t.req.push(r.ms || 0);
			if (r.note) log(r.extended ? "info" : "warn", `Search API: ${r.note}.`);
			if (r.extended && r.note) {
				// Page 1 came from Sales Nav's own (standard) request — fetch it once more
				// with the extended fields so its leads get past experience + profile URL too.
				const s1 = (firstPageNo - 1) * RESULTS_PER_PAGE;
				const again = await callHelper("SN_SEARCH_PAGE", { start: s1 }, 40000);
				if (again && again.ok) {
					await waitFor(() => apiBatches.get(s1), 8000, 100);
					await saveChain;
					log("info", `Page ${firstPageNo}: re-read with the extended fields.`);
				}
			}

			// injected.js parses the same response and posts the leads; wait for them to be saved
			const w0 = Date.now();
			const batch = await waitFor(() => apiBatches.get(start), 8000, 100);
			await saveChain;
			t.parse.push(Date.now() - w0);
			const n = batch ? batch.n : 0;
			run.rows += n;
			if (batch) run.keys.push(...batch.keys);
			run.pages++;
			run.lastPage = pageNo;
			await patchConfig({ currentPage: pageNo - firstPageNo + 1 });
			chrome.storage.local.set({ searchProgress: { query: searchQueryKey(), nextPage: pageNo + 1, at: Date.now() } });
			log("info", `Page ${pageNo}: ${n} lead(s) via API (${(r.ms / 1000).toFixed(1)}s)${batch && batch.skipped ? `, ${batch.skipped} anonymous skipped` : ""}.`);
			if (!r.n) {
				log("info", "No more results.");
				break;
			}
		}
		const mins = ((Date.now() - t0) / 60000).toFixed(1);
		log("info", `Search stage timing: ${run.pages} pages in ${mins} min — request ${stat(t.req)}; parse+save ${stat(t.parse)}; pause ${stat(t.pause)}.`);
		return "done";
	}

	// -------------------------------------------------------------------------
	// v5.2 — past the 2,500-result limit (api-helper.js has the details):
	//  • if LinkedIn's API answers beyond result 2,500 → page straight to the end;
	//  • else split the search into slices of ≤ 2,500 with one extra filter each
	//    (chosen so slices barely overlap; a "none of these" slice catches the rest)
	//    and page through every slice. Leads already stored are never added twice.
	// Progress is checkpointed per slice page ("Resume" continues it).
	// -------------------------------------------------------------------------
	const SLICE_KEY = "searchSlices";
	const fmtN = n => Number(n || 0).toLocaleString();

	async function pastTheCap(run, config, total, firstPageNo) {
		const { [SLICE_KEY]: saved } = await chrome.storage.local.get(SLICE_KEY);
		const resume = config.startFromCurrent && saved && saved.query === searchQueryKey() && !saved.done;
		let plan = resume ? saved.plan : null;
		if (resume) log("info", `Resuming the split search: slice ${saved.idx + 1} of ${plan.slices.length}, from its page ${Math.floor(saved.start / RESULTS_PER_PAGE) + 1}.`);
		else {
			log("info", `This search has ${fmtN(total)} results — Sales Nav lists only the first ${fmtN(SN_CAP)}. Checking whether LinkedIn returns results past ${fmtN(SN_CAP)}…`);
			const probe = await callHelper("SN_BEYOND_CAP", {}, 45000);
			if (probe && probe.ok && probe.uncapped) {
				log("info", `LinkedIn does return results past ${fmtN(SN_CAP)} for this search — paging straight through all ${fmtN(total)}.`);
				return pageViaApi(run, firstPageNo, config, total);
			}
			log("info", `LinkedIn stops at ${fmtN(SN_CAP)} (${probe ? probe.status || probe.error : "no answer"}). Splitting the search into slices of ≤ ${fmtN(SN_CAP)} with one extra filter each — measuring slice sizes (≈1–2 min, 1 result per request)…`);
			await patchConfig({ sliceText: "measuring slice sizes for the split search…" });
			plan = await callHelper("SN_SLICE_PLAN", { total }, 10 * 60000);
			if (!plan || !plan.ok) {
				log("warn", `Can't split this search: ${(plan && plan.error) || "no answer"}. Collecting the first ${fmtN(SN_CAP)} only.`);
				await patchConfig({ sliceText: "" });
				return "fallback";
			}
			for (const line of plan.log || []) log("info", `  size check — ${line}`);
			log(
				"info",
				`Split into ${plan.slices.length} slices (${plan.probes} size checks, ${(plan.ms / 1000).toFixed(0)}s): ${fmtN(plan.reads)} results to read for ${fmtN(plan.total)} people` +
					(plan.reads > plan.total ? ` (${fmtN(plan.reads - plan.total)} read twice — skipped when saving)` : " — no overlap") +
					(plan.lost ? `. ⚠ About ${fmtN(plan.lost)} can't be reached (a slice LinkedIn won't split further).` : ".")
			);
			plan.slices.forEach((sl, i) => log("info", `  slice ${i + 1}: ${sl.label} — ${fmtN(sl.n)}${sl.capped ? ` (first ${fmtN(SN_CAP)} only)` : ""}`));
		}
		return sliceRun(run, plan, config, resume ? saved : null);
	}

	async function sliceRun(run, plan, config, ck) {
		const { searchPacing: sp = {} } = await chrome.storage.local.get("searchPacing");
		const dMin = Math.max(0.5, Number(sp.minDelay) || 2);
		const dMax = Math.max(dMin, Number(sp.maxDelay) || 4);
		const want = Math.min(config.maxPages * RESULTS_PER_PAGE, plan.total); // new leads wanted this run
		const n = plan.slices.length;
		const totalPages = plan.pages;
		let pagesDone = ck ? ck.pagesDone || 0 : 0;
		let untilLong = 9 + Math.floor(Math.random() * 3);
		let first = true;
		const t0 = Date.now();
		const save = (idx, start) => chrome.storage.local.set({ [SLICE_KEY]: { query: searchQueryKey(), plan, idx, start, pagesDone, at: Date.now(), done: false } });
		for (let idx = ck ? ck.idx : 0; idx < n; idx++) {
			const sl = plan.slices[idx];
			const lim = Math.min(sl.n, SN_CAP);
			let start = ck && idx === ck.idx ? ck.start : 0;
			if (start === 0) log("info", `Slice ${idx + 1}/${n}: ${sl.label} — ${fmtN(sl.n)} results.`);
			for (; start < lim; start += RESULTS_PER_PAGE) {
				// pause (per page), with a longer break every ~10 pages — same as normal paging
				if (!first) {
					let pause = (dMin + Math.random() * (dMax - dMin)) * 1000;
					if (--untilLong <= 0) {
						untilLong = 9 + Math.floor(Math.random() * 3);
						pause = (15 + Math.random() * 15) * 1000;
						log("info", `Short break (${Math.round(pause / 1000)}s).`);
					}
					const pEnd = Date.now() + pause;
					while (Date.now() < pEnd) {
						if (stopRequested || !(await getConfig()).active) {
							log("info", "Stopped by user — tick “Resume” and Start to continue this split search.");
							await save(idx, start);
							return "stopped";
						}
						await sleep(Math.min(300, pEnd - Date.now()));
					}
				}
				first = false;
				let r = await callHelper("SN_SLICE_PAGE", { filters: sl.filters, start }, 45000);
				if (r && !r.ok && !r.fatal) {
					log("warn", `Slice ${idx + 1} page ${start / RESULTS_PER_PAGE + 1}: ${r.error} — retrying once in 5s.`);
					await sleep(5000);
					r = await callHelper("SN_SLICE_PAGE", { filters: sl.filters, start }, 45000);
				}
				if (!r || !r.ok) {
					await save(idx, start);
					log("error", `Slice ${idx + 1} page ${start / RESULTS_PER_PAGE + 1}: ${(r && r.error) || "no answer"}. Stopped — tick “Resume” and Start to continue from here.`);
					await patchConfig({ stoppedByUser: !!(r && r.fatal), sliceText: "" });
					return "error";
				}
				if (r.note) log(r.note.startsWith("extended fields accepted") ? "info" : "warn", `Search API: ${r.note}.`);
				if (r.leads.length) await saveLeads(r.leads, `slice ${idx + 1}/${n} p${start / RESULTS_PER_PAGE + 1}`);
				run.rows += r.leads.length;
				run.keys.push(...r.leads.map(leadKey));
				run.pages++;
				pagesDone++;
				await save(idx, start + RESULTS_PER_PAGE);
				await patchConfig({ currentPage: Math.min(config.maxPages, pagesDone), sliceText: `slice ${idx + 1} of ${n} (${sl.label}) · page ${pagesDone} of ~${totalPages} · ${fmtN(runAdded)} new leads` });
				if (runAdded >= want) {
					log("info", `Collected the ${fmtN(want)} leads asked for (“Search pages to scrape”).`);
					idx = n;
					break;
				}
				if (r.n < RESULTS_PER_PAGE) break; // last page of this slice
			}
		}
		await chrome.storage.local.set({ [SLICE_KEY]: { query: searchQueryKey(), plan, idx: n, start: 0, pagesDone, at: Date.now(), done: true } });
		const mins = ((Date.now() - t0) / 60000).toFixed(1);
		log("info", `Split search done in ${mins} min: ${pagesDone} pages read, ${fmtN(runAdded)} new leads this run (search total ${fmtN(plan.total)}).`);
		return "done";
	}

	const searchQueryKey = () => {
		const u = new URL(location.href);
		u.searchParams.delete("page");
		return u.toString();
	};

	// Search stage, fallback: the old click-"Next" loop.
	async function clickPaging(run, config) {
		while (true) {
			config = await getConfig();
			if (!config.active || stopRequested) {
				log("info", "Stopped by user.");
				return;
			}
			if (config.currentPage >= config.maxPages) {
				log("info", `Done — scraped the requested ${config.maxPages} page(s).`);
				return;
			}
			const next = findNextButton();
			if (!next || next.disabled) {
				log("info", `No enabled "Next" button — this is the last page.`);
				return;
			}
			const before = firstLeadHref();
			await sleep(jitter(2000, 4000));
			if (stopRequested) return;
			next.click();
			const changed = await waitFor(() => {
				const h = firstLeadHref();
				return h && h !== before;
			}, 20000);
			if (!changed) {
				log("error", "Results didn't change within 20s after clicking Next. Stopping.");
				return;
			}
			await patchConfig({ currentPage: config.currentPage + 1 });
			await sleep(1500);
			const pr = await collectCurrentPage(config.currentPage + 1);
			run.rows += pr.rows;
			run.keys.push(...pr.keys);
			run.pages++;
			if (pr.realPage) run.lastPage = pr.realPage;
		}
	}

	async function runAutoScrapingLoop() {
		if (loopRunning) return;
		loopRunning = true;

		try {
			let config = await getConfig();

			if (!config.active) {
				log("debug", "Scraper idle — running passive page detection.");
				await waitFor(() => detectTotalPages(), 30000, 2000);
				return;
			}

			stopRequested = false;
			// runAdded is per page load (each Start reloads the tab), so leads the API
			// delivered before this loop began still count for this run.
			const run = { rows: 0, keys: [], pages: 0, firstPage: null, lastPage: null };
			const finish = async () => {
				await patchConfig({ active: false, sliceText: "" });
				await logRunSummary(run);
				await startProfileStep();
			};
			log(
				"info",
				`Step 1 — search results: scraping ${config.maxPages} page(s). ` +
					`Start: ${config.startFromCurrent ? "current page" : "page 1"}. URL: ${location.pathname}`
			);

			if (!(await waitFor(() => getLeadAnchors().length > 0, 20000))) {
				log("error", "No lead links appeared within 20s. Are you on a lead search results page?");
				await patchConfig({ active: false });
				return;
			}
			if (!config.startFromCurrent && !(await ensureFirstPage())) {
				await patchConfig({ active: false });
				return;
			}

			// Who is running the search (PhantomBuster's searchAccountProfile* columns).
			callHelper("SN_ME", {}, 15000).then(me => me && me.id && chrome.storage.local.set({ searchAccount: me }));

			// --- page 1 (or the current page when resuming) comes from the page itself ---
			const first = await collectCurrentPage(config.currentPage);
			run.rows += first.rows;
			run.keys.push(...first.keys);
			run.pages++;
			const firstPageNo = first.realPage || readCurrentPage() || 1;
			run.firstPage = run.lastPage = firstPageNo;
			detectTotalPages();

			if (config.maxPages <= 1) {
				log("info", "Done — scraped the requested 1 page.");
				await finish();
				return;
			}

			// v5.2: more than 2,500 results and the user wants more than 100 pages.
			const total = (apiPaging && apiPaging.total) || 0;
			if (total > SN_CAP && config.maxPages * RESULTS_PER_PAGE > SN_CAP) {
				const outcome = await pastTheCap(run, config, total, firstPageNo);
				if (outcome === "stopped") {
					await logRunSummary(run);
					return;
				}
				if (outcome !== "fallback") {
					if (outcome === "done") await finish();
					else await patchConfig({ active: false, sliceText: "" });
					return;
				}
			}

			// Resuming the same search: continue after the last page that was saved.
			let basePage = firstPageNo;
			if (config.startFromCurrent) {
				const { searchProgress: sp } = await chrome.storage.local.get("searchProgress");
				if (sp && sp.query === searchQueryKey() && sp.nextPage - 1 > basePage) {
					basePage = sp.nextPage - 1;
					log("info", `Resuming this search after page ${basePage} (saved checkpoint).`);
				}
			}

			// --- remaining pages: replay Sales Nav's own search API call ---
			const outcome = await pageViaApi(run, basePage, config);
			if (outcome === "fallback") {
				log("warn", "Direct search paging unavailable — falling back to clicking Next.");
				await clickPaging(run, config);
			}
			if (outcome === "stopped") {
				await logRunSummary(run);
				return;
			}
			await finish();
		} catch (e) {
			log("error", `Loop crashed: ${e.message}`);
			console.error(TAG, e);
		} finally {
			loopRunning = false;
		}
	}

	log("info", `Content script loaded on ${location.pathname}`);

	const start = () => setTimeout(runAutoScrapingLoop, 1200);
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
