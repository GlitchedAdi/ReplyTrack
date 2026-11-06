// Runs in the page's MAIN world at document_start.
// Intercepts Sales Navigator API responses (fetch + XHR), parses lead objects,
// and hands them to content.js via window.postMessage.
(function () {
	if (window.__snInterceptorLoaded) return;
	window.__snInterceptorLoaded = true;

	const TAG = "[SN-Scraper:injected]";
	const SALES_API_RE = /\/sales-api\/|salesApi|\/graphql/i;
	// ONLY these endpoints contain actual search results. Other Sales Nav calls
	// (salesApiNavChrome = you, salesApiProfiles = sidebar/"recently viewed",
	// salesApiNotifications, salesApiCompanies…) also contain person objects
	// and must NOT be counted as leads.
	const SEARCH_RE = /salesApiLeadSearch|leadSearch|peopleSearch/i;
	const PERSON_URN_RE = /fs_salesProfile|fs_salesLead|salesProfile|urn:li:member:|fsd_profile/i;

	// Everything we've emitted, so content.js can ask for a replay if it
	// attached its listener after the first search response arrived.
	const emitted = [];

	function log(level, msg, extra) {
		const fn = level === "debug" ? console.log : console[level] || console.log;
		extra !== undefined ? fn.call(console, TAG, msg, extra) : fn.call(console, TAG, msg);
		// Only info/warn/error go to the popup's debug panel (debug is console-only).
		if (level !== "debug") {
			try {
				window.postMessage({ type: "SN_SCRAPER_LOG", level, msg }, location.origin);
			} catch (e) {}
		}
	}

	log("info", "API interceptor loaded (MAIN world).");

	function shortUrl(url) {
		try {
			const u = new URL(url, location.origin);
			const q = u.search.length > 70 ? u.search.slice(0, 70) + "…" : u.search;
			return u.pathname + q;
		} catch (e) {
			return String(url).slice(0, 120);
		}
	}

	function handleResponse(url, body, via) {
		if (!url || body == null || !SALES_API_RE.test(url)) return;

		if (!SEARCH_RE.test(url)) {
			log("debug", `${via}: ignored non-search endpoint ${shortUrl(url)}`);
			return;
		}

		let json;
		try {
			json = typeof body === "string" ? JSON.parse(body) : body;
		} catch (e) {
			log("debug", `${via}: non-JSON body from ${shortUrl(url)}`);
			return;
		}

		const { leads, skippedAnonymous } = parseSalesNavJSON(json);

		// Sales Nav's own result total, e.g. {start: 975, count: 25, total: 997}.
		const paging = extractPaging(json);
		// PhantomBuster's "query" column is the search URL of the page the lead was on.
		if (paging) {
			const pageNo = Math.floor(paging.start / (paging.count || 25)) + 1;
			for (const l of leads) l.query = searchQueryUrl(pageNo);
		}
		if (paging) {
			window.postMessage({ type: "SN_SCRAPER_PAGING", paging }, location.origin);
		}
		const pagingTxt = paging
			? ` — results ${paging.start + 1}–${paging.start + leads.length} of ${paging.total}`
			: "";

		if (leads.length) {
			log(
				"info",
				`${via}: parsed ${leads.length} lead(s)${pagingTxt}` +
					(skippedAnonymous ? ` (${skippedAnonymous} "LinkedIn Member" skipped)` : "")
			);
			const batch = {
				type: "SALES_NAV_INTERCEPTED_LEADS",
				payload: leads,
				start: paging ? paging.start : null,
				total: paging ? paging.total : null,
				skipped: skippedAnonymous,
			};
			emitted.push(batch);
			window.postMessage(batch, location.origin);
		} else {
			log(
				"warn",
				`${via}: search response had 0 parsable leads (${shortUrl(url)}). ` +
					`Top-level keys: ${Object.keys(json || {}).join(", ") || "(none)"}. Raw JSON is in the page console.`
			);
			console.log(TAG, "Unparsed search response (inspect this to fix the parser):", json);
		}
	}

	// ---- fetch ----
	const origFetch = window.fetch;
	// The page gets LinkedIn's own promise back, untouched: a request that fails (offline, blocked
	// by an ad blocker…) fails for the page exactly as without the extension — it isn't reported as
	// an error of this extension. Search answers are read from a copy, on the side.
	window.fetch = function (input, init) {
		const p = origFetch.apply(this, arguments);
		let url = "";
		try {
			url = input instanceof Request ? input.url : String(input);
		} catch (e) {}
		// v5.2: api-helper.js parses its own count probes / slice pages (see __snParseSearch)
		if (url && SALES_API_RE.test(url) && !(init && init.__snNoParse)) {
			p.then(response =>
				response
					.clone()
					.text()
					.then(t => handleResponse(url, t, "fetch"))
			).catch(e => log("debug", "fetch clone read failed: " + (e && e.message)));
		}
		return p;
	};

	// ---- XHR ----
	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;

	XMLHttpRequest.prototype.open = function (method, url) {
		this.__snUrl = String(url);
		return origOpen.apply(this, arguments);
	};

	XMLHttpRequest.prototype.send = function () {
		if (this.__snUrl && SALES_API_RE.test(this.__snUrl)) {
			this.addEventListener("load", () => {
				try {
					const t = this.responseType;
					if (t === "" || t === "text") handleResponse(this.__snUrl, this.responseText, "xhr");
					else if (t === "json") handleResponse(this.__snUrl, this.response, "xhr");
					else if (t === "arraybuffer" && this.response)
						handleResponse(this.__snUrl, new TextDecoder().decode(this.response), "xhr");
					else if (t === "blob" && this.response)
						this.response.text().then(x => handleResponse(this.__snUrl, x, "xhr"));
					else log("debug", `xhr: unhandled responseType "${t}" for ${shortUrl(this.__snUrl)}`);
				} catch (e) {
					log("warn", "xhr read failed: " + e.message);
				}
			});
		}
		return origSend.apply(this, arguments);
	};

	// ---- Replay for late-attaching content script ----
	window.addEventListener("message", e => {
		if (e.source !== window || !e.data || e.data.type !== "SN_SCRAPER_READY") return;
		if (emitted.length) {
			log("info", `Replaying ${emitted.length} earlier API batch(es) to content script.`);
			emitted.forEach(batch => window.postMessage(batch, location.origin));
		}
	});

	// v5.2: api-helper.js (same page world) parses slice pages itself, so their leads
	// carry the slice's own search URL and don't disturb the page-by-page bookkeeping.
	window.__snParseSearch = json => ({ ...parseSalesNavJSON(json), paging: extractPaging(json) });

	// ---- Paging info ----
	function extractPaging(json) {
		const candidates = [json && json.paging, json && json.data && json.data.paging];
		for (const p of candidates) {
			if (p && typeof p.total === "number") {
				return { start: Number(p.start) || 0, count: Number(p.count) || 0, total: p.total };
			}
		}
		return null;
	}

	// ---- Parser ----
	function text(v) {
		if (v == null) return "";
		if (typeof v === "string") return v;
		if (typeof v === "object" && typeof v.text === "string") return v.text;
		return "";
	}

	function buildLead(obj, fullName, urn) {
		// urn:li:fs_salesProfile:(ACwAAA...,NAME_SEARCH,abcd) -> "ACwAAA...,NAME_SEARCH,abcd"
		const rawInner = (urn.match(/\(([^)]+)\)/) || [])[1] || urn.split(":").pop();
		// Drop "undefined"/"null"/empty URN parts (seen as ",undefined,undefined").
		const inner = rawInner
			.split(",")
			.filter(p => p && p !== "undefined" && p !== "null")
			.join(",");
		const memberId = String(obj.memberId || inner.split(",")[0] || "");
		const pos = (Array.isArray(obj.currentPositions) && obj.currentPositions[0]) || {};

		const co = pos.companyUrnResolutionResult || {};
		const past = (Array.isArray(obj.pastPositions) && obj.pastPositions[0]) || null;
		const companyId = String(pos.companyUrn || co.entityUrn || "").match(/(\d+)\)?$/);

		return {
			name: fullName,
			title: text(pos.title) || text(obj.title),
			company: text(pos.companyName) || text(co.name) || text(obj.companyName),
			location: text(obj.geoRegion) || text(obj.location),
			memberId,
			salesNavUrn: urn,
			publicProfileUrl: memberId.startsWith("AC") ? `https://www.linkedin.com/in/${memberId}` : "",
			salesNavProfileUrl: inner ? `https://www.linkedin.com/sales/lead/${inner}` : "",
			source: "api",
			// Search-card fields (used by the PhantomBuster-format export)
			firstName: text(obj.firstName),
			lastName: text(obj.lastName),
			summary: text(obj.summary),
			titleDescription: text(pos.description),
			companyId: companyId ? companyId[1] : "",
			companyIndustry: text(co.industry),
			companyLocation: text(co.location),
			tenureRole: pos.tenureAtPosition || null,
			tenureCompany: pos.tenureAtCompany || null,
			pastPosition: past
				? { title: text(past.title), companyName: text(past.companyName), companyUrn: past.companyUrn || "", startedOn: past.startedOn || null, endedOn: past.endedOn || null }
				: null,
			degree: typeof obj.degree === "number" ? obj.degree : null,
			premium: !!obj.premium,
			profileImageUrl: bestImage(obj.profilePictureDisplayImage),
			sharedConnections: sharedCount(obj.spotlightBadges),
			memberNumericId: (String(obj.objectUrn || "").match(/member:(\d+)/) || [])[1] || "",
			// Only present when the extended search projection is accepted (see api-helper.js)
			vanityUrl: text(obj.flagshipProfileUrl),
			...(obj.flagshipProfileUrl ? { pastStatus: "done" } : {}),
			query: searchQueryUrl(),
			scrapedAt: new Date().toISOString(),
		};
	}

	function bestImage(img) {
		if (!img || !img.rootUrl || !Array.isArray(img.artifacts) || !img.artifacts.length) return "";
		const a = img.artifacts.slice().sort((x, y) => (y.width || 0) - (x.width || 0))[0];
		return img.rootUrl + (a.fileIdentifyingUrlPathSegment || "");
	}

	function sharedCount(badges) {
		for (const b of Array.isArray(badges) ? badges : []) {
			const m = String(text(b.displayValue) || "").match(/(\d[\d,]*)\s+(mutual|shared)/i);
			if (m) return parseInt(m[1].replace(/,/g, ""), 10);
		}
		return null;
	}

	// The Sales Nav search URL with "page=N" first (PhantomBuster's layout). Edited
	// as a string so the browser's own encoding of the query is kept as-is.
	function searchQueryUrl(page) {
		const [base, qs = ""] = location.href.split("#")[0].split("?");
		const rest = qs.replace(/(^|&)page=\d+(?=&|$)/, "").replace(/^&/, "");
		if (!page) return rest ? `${base}?${rest}` : base;
		return `${base}?page=${page}${rest ? "&" + rest : ""}`;
	}

	function parseSalesNavJSON(json) {
		const leads = [];
		const seen = new Set();
		const visited = new WeakSet();
		let skippedAnonymous = 0;

		(function walk(obj, depth) {
			if (!obj || typeof obj !== "object" || depth > 40 || visited.has(obj)) return;
			visited.add(obj);

			if (!Array.isArray(obj)) {
				const urn = obj.entityUrn || obj.objectUrn || "";
				const full = text(obj.fullName) || `${text(obj.firstName)} ${text(obj.lastName)}`.trim();

				// Stricter than before: must be a *person* URN, so companies/geos
				// with a "name" field no longer get counted as leads.
				if (full && typeof urn === "string" && PERSON_URN_RE.test(urn)) {
					if (full === "LinkedIn Member") {
						skippedAnonymous++;
					} else {
						const lead = buildLead(obj, full, urn);
						const key = lead.memberId || `${lead.name}|${lead.company}`;
						if (!seen.has(key)) {
							seen.add(key);
							leads.push(lead);
						}
					}
				}
			}

			const children = Array.isArray(obj) ? obj : Object.values(obj);
			for (const v of children) if (v && typeof v === "object") walk(v, depth + 1);
		})(json, 0);

		return { leads, skippedAnonymous };
	}
})();
