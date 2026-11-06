// MAIN world, linkedin.com/sales/* pages. The profile step's API client.
//
// Every request is a same-origin fetch from the logged-in Sales Navigator page,
// so it carries the browser's full cookie jar, the CSRF token and the tracking
// headers LinkedIn's own client sends (learned by wrapping fetch/XHR below).
//
// Per lead (no page loads):
//   1. /sales-api/salesApiProfiles/(profileId:…,authType:…,authToken:…)
//        → contact info + the lead's public /in/<vanity> URL
//   2. /voyager/api/identity/dash/profiles?q=memberIdentity&…FullProfileWithEntities-NN
//        → about, experience, education, certifications, publications, honors,
//          test scores, organizations, volunteering
(function () {
	if (window.__snApiHelper) return;
	window.__snApiHelper = true;

	const TAG = "[SN-Scraper:api-helper]";
	const COPY_HEADERS = /^(x-li-track|x-li-page-instance|x-li-lang|x-li-pem-metadata)$/i;
	const API_RE = /\/(voyager\/api|sales-api)\//;
	const learned = {};

	// ---- learn LinkedIn's own request headers (fetch + XHR wrappers) ----
	// Sales Nav's own lead-page profile request: if its projection includes
	// positions, remember it (content.js stores it) and use it for past experience.
	function learnProfileDeco(url) {
		try {
			if (!/\/sales-api\/salesApiProfiles\//.test(url)) return;
			const m = String(url).match(/[?&]decoration=([^&]+)/);
			if (!m || !/positions/i.test(decodeURIComponent(m[1]))) return;
			window.postMessage({ type: "SN_NATIVE_PROFILE_DECO", deco: m[1] }, location.origin);
		} catch (e) {}
	}

	// The page's own lead-search request, replayed with other start= offsets.
	const SEARCH_RE = /\/sales-api\/(salesApiLeadSearch|salesApiPeopleSearch)/i;
	let searchReq = null; // { url, accept }

	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		try {
			const url = input instanceof Request ? input.url : String(input);
			if (API_RE.test(url)) {
				const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
				h.forEach((v, k) => COPY_HEADERS.test(k) && (learned[k.toLowerCase()] = v));
				if (SEARCH_RE.test(url) && !(init && init.__snReplay)) searchReq = { url, accept: h.get("accept") || "application/json" };
				learnProfileDeco(url);
			}
		} catch (e) {}
		// A LinkedIn request that fails (offline, blocked by an ad blocker…) while nothing on the page
		// waits for its answer would show up in chrome://extensions as an error of THIS extension,
		// because this wrapper is in its stack. The page still gets the very same promise; this only
		// marks a failure nobody listens to as handled.
		const p = origFetch.apply(this, arguments);
		p.catch(() => {});
		return p;
	};
	const XHR = XMLHttpRequest.prototype;
	const origOpen = XHR.open;
	const origSetHeader = XHR.setRequestHeader;
	XHR.open = function (m, url) {
		this.__snHelperUrl = String(url);
		learnProfileDeco(this.__snHelperUrl);
		if (SEARCH_RE.test(this.__snHelperUrl)) {
			try {
				searchReq = { url: new URL(this.__snHelperUrl, location.origin).toString(), accept: "application/json" };
			} catch (e) {}
		}
		return origOpen.apply(this, arguments);
	};
	XHR.setRequestHeader = function (k, v) {
		try {
			if (this.__snHelperUrl && API_RE.test(this.__snHelperUrl) && COPY_HEADERS.test(k)) learned[k.toLowerCase()] = v;
			if (this.__snHelperUrl && SEARCH_RE.test(this.__snHelperUrl) && /^accept$/i.test(k) && searchReq) searchReq.accept = v;
		} catch (e) {}
		return origSetHeader.apply(this, arguments);
	};

	// ---- plumbing ----
	const csrf = () => {
		const m = document.cookie.match(/(?:^|;\s*)JSESSIONID=("?)([^";]+)\1/);
		return m ? m[2] : "";
	};
	// Rest.li encoding for the decoration VALUE: ( ) , escaped; * ~ : left raw
	// (encodeURIComponent → HTTP 400). The profile key in the path stays raw:
	// /salesApiProfiles/(profileId:…,authType:…,authToken:…) — escaping it → HTTP 400.
	const li = s => s.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/,/g, "%2C");
	// Abort conditions: LinkedIn bounced an API call to a login/verification page,
	// the contract chooser, the feed or Sales Nav home instead of answering.
	const BLOCK_RE = /\/(authwall|checkpoint|login|uas\/login|sales\/contract-chooser|sales\/login|feed\/?(\?|$)|sales\/home)/;

	class Fatal extends Error {}

	async function req(url, { accept = "application/json", method = "GET", timeout = 20000, replay = false, noParse = false } = {}) {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), timeout);
		try {
			const r = await origFetch.call(window, url, {
				method,
				credentials: "include",
				signal: ctl.signal,
				headers: { accept, "csrf-token": csrf(), "x-restli-protocol-version": "2.0.0", ...learned },
				__snReplay: replay,
				__snNoParse: noParse, // injected.js leaves this answer to us (v5.2 slices / probes)
			});
			const text = method === "HEAD" ? "" : await r.text();
			if (r.redirected && BLOCK_RE.test(new URL(r.url).pathname + new URL(r.url).search)) {
				throw new Fatal(`LinkedIn redirected an API call to ${new URL(r.url).pathname} — check the Sales Nav tab (login, verification or contract chooser).`);
			}
			if (r.status === 401) throw new Fatal("HTTP 401 — you're logged out of LinkedIn.");
			if (r.status === 429 || r.status === 999) {
				const e = new Fatal(`HTTP ${r.status} — LinkedIn is rate-limiting this account.`);
				e.rateLimited = true;
				throw e;
			}
			return { status: r.status, text, finalUrl: r.url };
		} catch (e) {
			if (e instanceof Fatal) throw e;
			// "Failed to fetch" on a same-origin API call is usually a redirect loop.
			return { status: 0, text: "", error: e.name === "AbortError" ? `timed out after ${timeout / 1000}s` : `network error (${e.message})` };
		} finally {
			clearTimeout(t);
		}
	}

	const json = t => {
		try {
			return JSON.parse(t);
		} catch (e) {
			return null;
		}
	};

	// ---- 1. Sales Navigator profile: contact info + public URL ----
	const SALES_DECORATIONS = [
		"(entityUrn,objectUrn,flagshipProfileUrl,contactInfo,summary)",
		"(entityUrn,objectUrn,contactInfo)",
	];

	function salesKey(lead) {
		const urn = lead.salesNavUrn || "";
		const inner = (urn.match(/\(([^)]+)\)/) || [])[1] || (lead.salesNavProfileUrl || "").split("/sales/lead/")[1] || "";
		const [profileId, authType, authToken] = inner.split(",");
		if (!profileId || !authType || !authToken) return null;
		return `(profileId:${profileId},authType:${authType},authToken:${authToken})`;
	}

	// Index of the first decoration variant LinkedIn accepted; variants it rejects
	// with 400 are skipped for every later lead instead of being retried each time.
	const decoStart = { sales: 0, positions: 0 };

	async function salesProfile(lead, log) {
		const key = salesKey(lead);
		if (!key) {
			log.push("sales: no Sales Nav auth token on this lead");
			return null;
		}
		for (let i = decoStart.sales; i < SALES_DECORATIONS.length; i++) {
			const deco = SALES_DECORATIONS[i];
			const r = await req(`/sales-api/salesApiProfiles/${key}?decoration=${li(deco)}`, { accept: "*/*" });
			if (r.status === 200) {
				const j = json(r.text);
				if (j) return j;
			}
			log.push(`sales ${deco.length > 40 ? "full" : "min"}: ${r.status || r.error}`);
			if (r.status === 400 && i === decoStart.sales && i < SALES_DECORATIONS.length - 1) decoStart.sales = i + 1;
			if (r.status === 403 || r.status === 404) break;
		}
		return null;
	}

	// ---- public identifier ----
	async function resolveVanity(lead, sales, log) {
		const fromUrl = u => {
			const m = String(u || "").match(/linkedin\.com\/in\/([^/?#]+)/);
			return m ? decodeURIComponent(m[1]) : "";
		};
		let v = fromUrl(sales && sales.flagshipProfileUrl);
		if (v) return { vanity: v, how: "sales" };
		v = fromUrl(lead.publicProfileUrl);
		if (v && !/^AC[wo]/.test(v)) return { vanity: v, how: "stored" };
		// /in/ACwAAA… redirects to /in/<vanity>/ — follow it without rendering anything.
		const r = await req(`/in/${encodeURIComponent(lead.memberId)}/`, { method: "HEAD", accept: "text/html" });
		v = fromUrl(r.finalUrl);
		if (v && !/^ACw/.test(v)) return { vanity: v, how: "redirect" };
		log.push(`vanity: redirect gave ${r.status || r.error}`);
		return { vanity: "", how: "" };
	}

	// ---- 2. Full profile ----
	const DECORATIONS = [
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93",
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-128",
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-96",
	];

	async function fullProfile(identity, preferred, log) {
		const order = preferred ? [preferred, ...DECORATIONS.filter(d => d !== preferred)] : DECORATIONS;
		for (const deco of order) {
			const short = deco.split(".").pop();
			const url =
				`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(identity)}` +
				`&decorationId=${encodeURIComponent(deco)}`;
			const r = await req(url);
			if (r.status === 200) {
				const j = json(r.text);
				const el = j && (j.elements || (j.data && j.data.elements) || [])[0];
				if (el) return { profile: el, decoration: deco };
				log.push(`${short}: 200 without profile`);
				continue;
			}
			log.push(`${short}: ${r.status || r.error}`);
			if (r.status === 403 && /VoyagerUserVisibleException|can.t be accessed/i.test(r.text)) return { inaccessible: true };
			if (r.status === 403) return { error: "HTTP 403 (session/CSRF)" };
			if (r.status === 0) return { error: r.error }; // network/timeout — don't burn the other variants
			// 400/404/410 → that decoration was retired, try the next
		}
		return { error: "all profile API variants failed" };
	}

	// Voyager caps experience at 10 companies (and roles per company); Sales
	// Navigator's profile returns the whole list. Only asked for when needed.
	// Every variant starts with entityUrn (the record key) like all projections
	// known to work on this endpoint; the last one is the exact list a
	// maintained open-source client uses live (sales-nav-mcp, Sep 2026).
	const POSITION_DECORATIONS = [
		"(entityUrn,objectUrn,flagshipProfileUrl,positions*(title,companyName,companyUrn,description,current,startedOn,endedOn))",
		"(entityUrn,objectUrn,positions*(title,companyName,description,current,startedOn,endedOn))",
		"(entityUrn,objectUrn,fullName,firstName,lastName,headline,summary,location,defaultPosition," +
			"positions*(title,companyName,description,current,startedOn,endedOn),educations*(schoolName,degree,fieldsOfStudy*)," +
			"skills*,languages*,volunteeringExperiences*(role,companyName,cause),numOfConnections,numOfSharedConnections,memberBadges,inmailRestriction)",
	];

	// LinkedIn's error text, e.g. {"message":"…","exceptionClass":"…"} → short string for the log.
	function errText(r) {
		const j = json(r.text || "");
		const m = j && (j.message || j.exceptionClass || (j.data && j.data.message));
		return `${r.status || r.error}${m ? ` "${String(m).slice(0, 120)}"` : r.text ? ` ${String(r.text).replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
	}

	function experienceCut(p) {
		const g = p && p.profilePositionGroups;
		if (!g) return false;
		const els = g.elements || [];
		if (g.paging && g.paging.total > els.length) return true;
		return els.some(x => {
			const c = x.profilePositionInPositionGroup;
			return c && c.paging && c.paging.total > (c.elements || []).length;
		});
	}

	async function salesPositions(lead, log, nativeDeco) {
		const key = salesKey(lead);
		if (!key) return null;
		// Sales Nav's own lead-page request (learned when you open any lead), if it includes positions.
		const variants = (nativeDeco ? [{ raw: nativeDeco, name: "sales-nav-own" }] : []).concat(
			POSITION_DECORATIONS.slice(decoStart.positions).map((d, k) => ({ deco: d, name: `v${decoStart.positions + k + 1}`, idx: decoStart.positions + k }))
		);
		for (const v of variants) {
			const q = v.raw ? v.raw : li(v.deco);
			const r = await req(`/sales-api/salesApiProfiles/${key}?decoration=${q}`, { accept: "*/*" });
			const j = r.status === 200 ? json(r.text) : null;
			const positions = j && (j.positions || j.positionsV2 || (j.data && j.data.positions));
			if (Array.isArray(positions)) {
				positions.flagshipProfileUrl = j.flagshipProfileUrl || "";
				return positions;
			}
			log.push(`positions ${v.name}: ${r.status === 200 ? "200 but no positions" : errText(r)}`);
			// A variant LinkedIn rejects (400/500) is skipped for all later leads.
			if (v.idx != null && (r.status === 400 || r.status === 500) && v.idx === decoStart.positions && v.idx < POSITION_DECORATIONS.length - 1) {
				decoStart.positions = v.idx + 1;
			}
			if (r.status === 403 || r.status === 404) break;
		}
		return null;
	}

	async function fetchLead(lead, preferred) {
		const log = [];
		const timings = {};
		let t = Date.now();
		const lap = k => {
			timings[k] = Date.now() - t;
			t = Date.now();
		};
		const sales = await salesProfile(lead, log);
		lap("sales");
		const { vanity, how } = await resolveVanity(lead, sales, log);
		if (how === "redirect") lap("redirect");
		const identity = vanity || lead.memberId;
		const fp = await fullProfile(identity, preferred, log);
		lap("profile");
		let positions = null;
		if (fp.profile && experienceCut(fp.profile)) {
			positions = await salesPositions(lead, log);
			lap("positions");
		}
		return {
			salesPositions: positions,
			salesOk: !!sales,
			timings,
			ok: !!fp.profile,
			inaccessible: !!fp.inaccessible,
			error: fp.error || "",
			profile: fp.profile || null,
			decoration: fp.decoration || "",
			sales: sales ? { contactInfo: sales.contactInfo || null, summary: sales.summary || "", flagshipProfileUrl: sales.flagshipProfileUrl || "" } : null,
			vanity,
			vanityHow: how,
			log,
			learnedHeaders: Object.keys(learned),
		};
	}

	// ---- search page replay ----
	function withStart(url, start) {
		// Edit the raw string: re-serialising with URLSearchParams would re-encode
		// the Rest.li (…) syntax and LinkedIn answers 400.
		if (/[?&]start=\d+/.test(url)) return url.replace(/([?&]start=)\d+/, `$1${start}`);
		return url + (url.includes("?") ? "&" : "?") + `start=${start}`;
	}

	// Sales Nav's web client asks for a fixed projection (decorationId=…LeadSearchResult-NN)
	// that has no past positions and no public profile URL. The endpoint may also
	// accept a free-form projection; if it does, past experience and the /in/<vanity>
	// URL come with every page at no extra cost. Tried once per page load; any
	// failure or missing field reverts to the page's own projection for good.
	const EXTENDED_DECORATION =
		"(entityUrn,objectUrn,firstName,lastName,fullName,geoRegion,summary,degree,premium,memorialized," +
		"flagshipProfileUrl,profilePictureDisplayImage,spotlightBadges*," +
		"currentPositions*(title,companyName,companyUrn~fs_salesCompany(entityUrn,name,industry,location),description,current,startedOn,tenureAtPosition,tenureAtCompany)," +
		"pastPositions*(title,companyName,companyUrn,current,startedOn,endedOn))";
	let extended = "untested"; // → "on" | "off"

	function extendedUrl(url) {
		if (!/[?&]decorationId=[^&]+/.test(url)) return null;
		return url.replace(/([?&])decorationId=[^&]+/, `$1decoration=${li(EXTENDED_DECORATION)}`);
	}

	function judgeExtended(els) {
		if (!els.length) return "no results to judge";
		const lostCompany =
			els.some(e => (e.currentPositions || []).some(p => p.companyUrn)) &&
			!els.some(e => (e.currentPositions || []).some(p => p.companyUrnResolutionResult));
		if (lostCompany) return "company details (industry/location) missing";
		if (!els.some(e => e.firstName)) return "names missing";
		if (!els.some(e => e.flagshipProfileUrl || Array.isArray(e.pastPositions))) return "no past positions or profile URLs returned";
		return "";
	}

	async function searchPage(start, preferExtended = true) {
		if (!searchReq) return { ok: false, noRequest: true, error: "Haven't seen Sales Nav's own search request yet" };
		const t0 = Date.now();
		let note = "";
		if (preferExtended && extended !== "off") {
			const url = extendedUrl(withStart(searchReq.url, start));
			if (url) {
				// Goes through window.fetch → injected.js parses the leads like any page response.
				const r = await req(url, { accept: searchReq.accept, replay: true, timeout: 30000 });
				const j = r.status === 200 ? json(r.text) : null;
				const els = j ? j.elements || (j.data && j.data.elements) || [] : [];
				const why = r.status !== 200 ? `HTTP ${r.status || r.error}` : !j ? "not JSON" : judgeExtended(els);
				if (!why) {
					if (extended === "untested") note = "extended fields accepted";
					extended = "on";
					return { ok: true, n: els.length, total: j.paging && j.paging.total, ms: Date.now() - t0, extended: true, note };
				}
				if (extended === "untested") note = `extended fields not accepted (${why}) — using the standard ones`;
				extended = "off";
			} else extended = "off";
		}
		const r = await req(withStart(searchReq.url, start), { accept: searchReq.accept, replay: true, timeout: 30000 });
		const ms = Date.now() - t0;
		if (r.status === 200) {
			const j = json(r.text);
			if (!j) return { ok: false, error: "search answer wasn't JSON", ms, note };
			const els = j.elements || (j.data && j.data.elements) || [];
			return { ok: true, n: els.length, total: j.paging && j.paging.total, ms, extended: false, note };
		}
		return { ok: false, status: r.status, error: r.error || `HTTP ${r.status}`, ms, note };
	}

	// =========================================================================
	// v5.2 — searches with more than 2,500 results.
	// Sales Navigator lists at most 2,500 results (100 pages) per search. Two ways past it:
	//  1. If LinkedIn's API answers beyond result 2,500 (checked with one request),
	//     the search is simply paged to the end.
	//  2. Otherwise the search is split into "slices": the same search plus one more
	//     filter (years of experience, company headcount, seniority…), one slice per
	//     filter value, plus a last slice that EXCLUDES all those values. Everyone in
	//     the search is in at least one slice — whatever LinkedIn does with a filter
	//     value — and with a filter where each person has one value (years of
	//     experience) nobody is in two. Slice sizes are measured first (1 result per
	//     request), slices over 2,500 are split again with another filter, and the
	//     filter with the least overlap is chosen. Then only the slices are paged.
	// =========================================================================
	const CAP = 2500;
	const sleepMs = ms => new Promise(r => setTimeout(r, ms));
	const gentle = () => sleepMs(400 + Math.random() * 500); // between size probes

	// Filters to split by. Values are Sales Navigator's own filter ids; a wrong or
	// retired id only makes that value's slice empty (its people land in the
	// "none of these" slice), so correctness doesn't depend on them.
	const YRS = [
		["1", "Less than 1 year"],
		["2", "1 to 2 years"],
		["3", "3 to 5 years"],
		["4", "6 to 10 years"],
		["5", "More than 10 years"],
	];
	const DIMS = [
		{ type: "YEARS_OF_EXPERIENCE", label: "Years of experience", values: YRS },
		{
			type: "COMPANY_HEADCOUNT",
			label: "Company headcount",
			values: [
				["A", "Self-employed"],
				["B", "1-10"],
				["C", "11-50"],
				["D", "51-200"],
				["E", "201-500"],
				["F", "501-1,000"],
				["G", "1,001-5,000"],
				["H", "5,001-10,000"],
				["I", "10,001+"],
			],
		},
		{
			type: "SENIORITY_LEVEL",
			label: "Seniority level",
			values: [
				["100", "In Training"],
				["110", "Entry Level"],
				["120", "Senior"],
				["130", "Strategic"],
				["200", "Entry Level Manager"],
				["210", "Experienced Manager"],
				["220", "Director"],
				["300", "Vice President"],
				["310", "CXO"],
				["320", "Owner / Partner"],
			],
		},
		{ type: "YEARS_IN_CURRENT_POSITION", label: "Years in current position", values: YRS },
		{ type: "YEARS_AT_CURRENT_COMPANY", label: "Years at current company", values: YRS },
		{
			type: "FUNCTION",
			label: "Function",
			values: [
				"Accounting", "Administrative", "Arts and Design", "Business Development", "Community and Social Services", "Consulting", "Education",
				"Engineering", "Entrepreneurship", "Finance", "Healthcare Services", "Human Resources", "Information Technology", "Legal", "Marketing",
				"Media and Communication", "Military and Protective Services", "Operations", "Product Management", "Program and Project Management",
				"Purchasing", "Quality Assurance", "Real Estate", "Research", "Sales", "Customer Success and Support",
			].map((t, i) => [String(i + 1), t]),
		},
		{
			type: "RELATIONSHIP",
			label: "Connection",
			values: [
				["F", "1st degree connections"],
				["S", "2nd degree connections"],
				["O", "3rd degree connections and everyone else"],
			],
		},
	];

	// ---- Rest.li editing of the search's query=(…) parameter, without re-encoding
	// anything that's already there. The API request carries it as raw Rest.li
	// ("filters:List((type:…"), the page URL fully percent-encoded ("filters%3AList").
	function queryParam(url) {
		const m = String(url).match(/([?&]query=)([^&#]*)/);
		if (!m) return null;
		const raw = m[2];
		const encoded = !raw.includes(":") && /%3A/i.test(raw);
		let rest = raw;
		if (encoded) {
			try {
				rest = decodeURIComponent(raw);
			} catch (e) {
				return null;
			}
		}
		if (!/^\(/.test(rest)) return null;
		return { head: url.slice(0, m.index + m[1].length), tail: url.slice(m.index + m[0].length), rest, encoded };
	}
	const joinQuery = (q, rest) => q.head + (q.encoded ? encodeURIComponent(rest) : rest) + q.tail;
	function matchParen(s, i) {
		let d = 0;
		for (let j = i; j < s.length; j++) {
			if (s[j] === "(") d++;
			else if (s[j] === ")" && --d === 0) return j;
		}
		return -1;
	}
	const liText = t => encodeURIComponent(t).replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/'/g, "%27");
	const filterElem = f => `(type:${f.type},values:List(${f.values.map(([id, text]) => `(id:${id},text:${liText(text)},selectionType:${f.sel})`).join(",")}))`;
	function addFilters(rest, filters) {
		if (!filters.length) return rest;
		const elems = filters.map(filterElem).join(",");
		const k = rest.indexOf("filters:List(");
		if (k >= 0) {
			const open = k + "filters:List".length;
			const close = matchParen(rest, open);
			if (close < 0) return null;
			const empty = !rest.slice(open + 1, close).trim();
			return rest.slice(0, close) + (empty ? "" : ",") + elems + rest.slice(close);
		}
		const close = matchParen(rest, 0);
		if (close < 0) return null;
		const empty = !rest.slice(1, close).trim();
		return rest.slice(0, close) + (empty ? "" : ",") + `filters:List(${elems})` + rest.slice(close);
	}
	// The search + extra filters; null when the search has no editable query (e.g. a saved-search link).
	function withFilters(url, filters) {
		const q = queryParam(url);
		if (!q) return null;
		const rest = addFilters(q.rest.replace(/doLogHistory:true/g, "doLogHistory:false"), filters); // don't flood "recent searches"
		return rest == null ? null : joinQuery(q, rest);
	}
	const filterTypes = url => {
		const q = queryParam(url);
		return q ? [...q.rest.matchAll(/\(type:([A-Z_]+),/g)].map(m => m[1]) : [];
	};
	function withCount(url, n) {
		if (/[?&]count=\d+/.test(url)) return url.replace(/([?&]count=)\d+/, `$1${n}`);
		return url + (url.includes("?") ? "&" : "?") + `count=${n}`;
	}
	const inc = (dim, values) => ({ type: dim.type, values, sel: "INCLUDED" });
	const exc = (dim, values) => ({ type: dim.type, values, sel: "EXCLUDED" });

	// ---- 1. Does the API answer beyond 2,500? (one request) ----
	async function beyondCap() {
		if (!searchReq) return { ok: false, error: "Haven't seen Sales Nav's own search request yet" };
		const url = withCount(withStart(searchReq.url, CAP), 25);
		const r = await req(url, { accept: searchReq.accept, replay: true, noParse: true, timeout: 30000 });
		const j = r.status === 200 ? json(r.text) : null;
		const els = j ? j.elements || (j.data && j.data.elements) || [] : [];
		return { ok: true, uncapped: els.length > 0, status: r.status || r.error, n: els.length };
	}

	// ---- 2. Slice sizes ----
	let probeCount = 1; // results asked for per size probe (25 if LinkedIn refuses 1)
	async function sizeOf(filters) {
		const base = withFilters(searchReq.url, filters);
		if (!base) return { err: "this search's URL has no filters to extend" };
		for (;;) {
			const r = await req(withCount(withStart(base, 0), probeCount), { accept: searchReq.accept, replay: true, noParse: true, timeout: 30000 });
			if (r.status === 400 && probeCount === 1) {
				probeCount = 25;
				continue;
			}
			const j = r.status === 200 ? json(r.text) : null;
			const p = j && (j.paging || (j.data && j.data.paging));
			if (!p || typeof p.total !== "number") return { err: `HTTP ${r.status || r.error}` };
			return { n: p.total };
		}
	}

	// One filter as a way to split `node` (the search + filters so far, total T).
	async function tryDim(dim, node, budget, log) {
		const vals = [];
		for (const v of dim.values) {
			if (budget.left-- <= 0) return { bad: "probe budget used up" };
			const t = await sizeOf([...node.filters, inc(dim, [v])]);
			await gentle();
			if (t.err) return { bad: `${dim.label}: ${t.err}` };
			vals.push({ v, n: t.n });
		}
		budget.left--;
		const all = await sizeOf([...node.filters, inc(dim, dim.values)]);
		await gentle();
		if (all.err) return { bad: `${dim.label}: ${all.err}` };
		let rest = 0;
		let missing = 0;
		const slack = Math.max(3, Math.round(node.n * 0.01));
		if (node.n - all.n > slack) {
			// Some people have none of these values → a "none of these" slice (EXCLUDE all values).
			budget.left--;
			const ex = await sizeOf([...node.filters, exc(dim, dim.values)]);
			await gentle();
			if (!ex.err && ex.n < node.n && Math.abs(ex.n + all.n - node.n) <= slack) rest = ex.n;
			else missing = node.n - all.n; // LinkedIn ignores exclusion for this filter → those people would be lost
		}
		const sum = vals.reduce((a, x) => a + x.n, 0);
		const r = { dim, vals, all: all.n, rest, missing, overlap: Math.max(0, sum - all.n) };
		log.push(`${node.label || "whole search"} (${node.n}) by ${dim.label}: ${vals.map(x => `${x.v[1]} ${x.n}`).join(", ")}${rest ? `, none of these ${rest}` : ""}${missing ? ` — ${missing} not reachable` : ""}${r.overlap ? ` — ${r.overlap} in 2+ values` : ""}`);
		return r;
	}

	// Recursively split until every slice is ≤ 2,500.
	async function split(node, used, depth, budget, log, out) {
		if (node.n <= CAP) return out.push(node);
		const cands = DIMS.filter(d => !used.has(d.type));
		let best = null;
		let tried = 0;
		for (const d of cands) {
			if (tried >= 3 || budget.left <= d.values.length + 2) break;
			tried++;
			const r = await tryDim(d, node, budget, log);
			if (r.bad) {
				log.push(`${node.label || "whole search"}: can't split by ${r.bad}`);
				continue;
			}
			const score = r.missing * 10 + r.overlap; // losing people is far worse than reading someone twice
			if (!best || score < best.score) best = { ...r, score };
			if (!r.missing && r.overlap <= node.n * 0.02) break; // clean split — good enough
		}
		if (!best || (best.missing && best.missing >= node.n - CAP)) {
			out.push({ ...node, capped: true }); // can't do better than its first 2,500
			return;
		}
		const nextUsed = new Set(used).add(best.dim.type);
		const kids = best.vals
			.filter(x => x.n > 0)
			.map(x => ({ filters: [...node.filters, inc(best.dim, [x.v])], n: x.n, label: [node.label, `${best.dim.label}: ${x.v[1]}`].filter(Boolean).join(" › "), missing: 0 }));
		if (best.rest) kids.push({ filters: [...node.filters, exc(best.dim, best.dim.values)], n: best.rest, label: [node.label, `${best.dim.label}: none of the above`].filter(Boolean).join(" › ") });
		if (best.missing) out.lost = (out.lost || 0) + best.missing;
		for (const k of kids) {
			if (depth >= 3 && k.n > CAP) out.push({ ...k, capped: true });
			else await split(k, nextUsed, depth + 1, budget, log, out);
		}
	}

	async function planSlices(total) {
		if (!searchReq) return { ok: false, error: "Haven't seen Sales Nav's own search request yet" };
		if (!queryParam(searchReq.url)) return { ok: false, error: "this search can't be split (its request has no filter list — e.g. a saved-search link). Open the search from the filters panel and start again" };
		const t0 = Date.now();
		const log = [];
		const budget = { left: 160 }; // size probes at most (~1–2 min)
		const whole = await sizeOf([]);
		if (whole.err) return { ok: false, error: `couldn't measure the search (${whole.err})` };
		const out = [];
		const present = new Set(filterTypes(searchReq.url)); // filters the search already uses aren't split on
		await split({ filters: [], n: whole.n || total, label: "" }, present, 0, budget, log, out);
		const slices = out.map(s => ({ filters: s.filters, n: s.n, label: s.label || "whole search", capped: !!s.capped }));
		const sum = slices.reduce((a, s) => a + Math.min(s.n, CAP), 0);
		return {
			ok: true,
			total: whole.n || total,
			slices,
			pages: slices.reduce((a, s) => a + Math.ceil(Math.min(s.n, CAP) / 25), 0),
			reads: sum, // results that will be read, duplicates included
			lost: (out.lost || 0) + slices.reduce((a, s) => a + Math.max(0, s.n - CAP), 0),
			probes: 160 - budget.left + 1,
			ms: Date.now() - t0,
			log,
		};
	}

	// ---- 3. One page of one slice: the leads, parsed here (not by the page-wide interceptor) ----
	function slicePageUrl(filters, page) {
		// For the "query" column: the Sales Nav page URL of this slice (opens the same view).
		const u = withFilters(location.href.split("#")[0], filters) || location.href.split("#")[0];
		const [base, qs = ""] = u.split("?");
		const rest = qs.replace(/(^|&)page=\d+(?=&|$)/, "").replace(/^&/, "");
		return `${base}?page=${page}${rest ? "&" + rest : ""}`;
	}
	async function slicePage(filters, start) {
		if (!searchReq) return { ok: false, error: "Haven't seen Sales Nav's own search request yet" };
		const t0 = Date.now();
		const sliced = withFilters(searchReq.url, filters);
		if (!sliced) return { ok: false, fatal: true, error: "this search's request has no filter list to extend" };
		const base = withStart(sliced, start);
		let r = null;
		let note = "";
		if (extended !== "off") {
			const url = extendedUrl(base);
			if (url) {
				r = await req(url, { accept: searchReq.accept, replay: true, noParse: true, timeout: 30000 });
				const j = r.status === 200 ? json(r.text) : null;
				const why = r.status !== 200 ? `HTTP ${r.status || r.error}` : !j ? "not JSON" : judgeExtended(j.elements || (j.data && j.data.elements) || []);
				if (why) {
					if (extended === "untested") note = `extended fields not accepted (${why}) — using the standard ones`;
					extended = "off";
					r = null;
				} else {
					if (extended === "untested") note = "extended fields accepted";
					extended = "on";
				}
			} else extended = "off";
		}
		if (!r) r = await req(base, { accept: searchReq.accept, replay: true, noParse: true, timeout: 30000 });
		if (r.status !== 200) return { ok: false, status: r.status, error: r.error || `HTTP ${r.status}`, ms: Date.now() - t0 };
		const j = json(r.text);
		if (!j || !window.__snParseSearch) return { ok: false, error: "search answer wasn't JSON", ms: Date.now() - t0 };
		const { leads, skippedAnonymous, paging } = window.__snParseSearch(j);
		const page = Math.floor(start / 25) + 1;
		for (const l of leads) l.query = slicePageUrl(filters, page);
		const els = j.elements || (j.data && j.data.elements) || [];
		return { ok: true, leads, n: els.length, skipped: skippedAnonymous, total: paging && paging.total, ms: Date.now() - t0, note };
	}

	async function me() {
		const r = await req("/voyager/api/me");
		const j = r.status === 200 ? json(r.text) : null;
		if (!j) return null;
		const mp = j.miniProfile || (j.included || []).find(x => x && x.firstName) || {};
		const id = String(j.plainId || (mp.entityUrn || mp.objectUrn || "").split(":").pop() || "");
		return { id, name: [mp.firstName, mp.lastName].filter(Boolean).join(" "), publicIdentifier: mp.publicIdentifier || "" };
	}

	window.addEventListener("message", async e => {
		if (e.source !== window || !e.data) return;
		const { type, id } = e.data;
		if (type === "SN_SEARCH_PAGE" || type === "SN_ME" || type === "SN_PAST_POSITIONS" || type === "SN_BEYOND_CAP" || type === "SN_SLICE_PLAN" || type === "SN_SLICE_PAGE") {
			let result;
			try {
				if (type === "SN_SEARCH_PAGE") result = await searchPage(e.data.start, e.data.extended !== false);
				else if (type === "SN_BEYOND_CAP") result = await beyondCap();
				else if (type === "SN_SLICE_PLAN") result = await planSlices(e.data.total);
				else if (type === "SN_SLICE_PAGE") result = await slicePage(e.data.filters || [], e.data.start || 0);
				else if (type === "SN_ME") result = await me();
				else {
					const log = [];
					const t0 = Date.now();
					const positions = await salesPositions(e.data.lead, log, e.data.nativeDeco);
					result = {
						ok: !!positions,
						positions,
						flagshipProfileUrl: (positions && positions.flagshipProfileUrl) || "",
						log,
						error: positions ? "" : log.join("; ") || "no positions",
						timings: { positions: Date.now() - t0 },
					};
				}
			} catch (err) {
				result = { ok: false, fatal: err instanceof Fatal, rateLimited: !!err.rateLimited, error: err.message };
			}
			window.postMessage({ type: type + "_RESPONSE", id, result }, location.origin);
			return;
		}
		if (type !== "SN_API_REQUEST") return;
		const { lead, preferred } = e.data;
		let result;
		try {
			result = await fetchLead(lead, preferred);
		} catch (err) {
			result = { ok: false, fatal: err instanceof Fatal, rateLimited: !!err.rateLimited, error: err.message, log: [] };
		}
		window.postMessage({ type: "SN_API_RESPONSE", id, result }, location.origin);
	});

	console.log(TAG, "ready");
})();
