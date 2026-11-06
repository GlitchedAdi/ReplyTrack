// v5.0.4 — contact finder, LinkedIn content script (isolated world, all linkedin.com
// pages except Sales Navigator; also injected on demand into tabs opened before
// the extension was loaded). Needs contact-parse.js (CFParse) loaded first.
//
// Contact info = ONE request, the same one LinkedIn's page sends when you open
// "Contact info" (seen in real traffic, Sep 2026):
//   POST /flagship-web/rsc-action/actions/navigation
//        ?screenId=com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay
//   body {clientArguments:{payload:{vanityName, givenName, familyName, …}, screenId, …}}
// The answer is React-Server-Component "flight" text; contact-parse.js reads the
// email / phone out of it. No clicking, no popups, no navigation — ever.
//
// net-tap.js (page world) keeps this current: it hands over LinkedIn's own
// request headers, and if LinkedIn changes the request, the next time the card
// is opened on a page the new request is learned (storage "cfTemplate") and
// used before the built-in one.
// Profile text (headline, about, experience…) comes from the Voyager profile API.
(function () {
	const extAlive = () => {
		try {
			return !!chrome.runtime.id;
		} catch (e) {
			return false;
		}
	};
	// After the extension is reloaded, the copy already in this tab is orphaned
	// (its chrome.* calls fail) — let the new copy take over instead of skipping.
	if (globalThis.__cfFinder && globalThis.__cfFinder.alive()) return;
	globalThis.__cfFinder = { alive: extAlive };

	const P = globalThis.CFParse;
	const dbg = (...a) => globalThis.CFDebug?.log(...a); // no-op without debug.js
	const dbgTime = (s, w) => (globalThis.CFDebug ? globalThis.CFDebug.time(s, w) : () => {});
	const vanityOf = path => {
		const m = String(path || "").match(/^\/in\/([^/?#]+)/i);
		if (!m) return "";
		try {
			return decodeURIComponent(m[1]);
		} catch (e) {
			return m[1];
		}
	};
	// -------------------------------------------------------------------------
	// Network tap receiver
	// -------------------------------------------------------------------------
	const H_KEY = "cfRscHeaders";
	let rscHeaders = {}; // LinkedIn's own headers for SDUI (rsc-action) requests, latest seen
	let voyHeaders = {}; // …and for Voyager API requests
	const captured = new Map(); // vanity(lower) → { at, emails, phones } — cards LinkedIn loaded on the page
	if (extAlive()) chrome.storage.local.get(H_KEY).then(r => (rscHeaders = { ...(r[H_KEY] || {}), ...rscHeaders })).catch(() => {});

	window.addEventListener("message", e => {
		if (e.source !== window || !e.data || typeof e.data.type !== "string" || !e.data.type.startsWith("CF_TAP")) return;
		if (e.data.type === "CF_TAP_READY") {
			if (globalThis.CFDebug) window.postMessage({ type: "CF_TAP_DEBUG", on: true }, location.origin);
		} else if (e.data.type === "CF_TAP_HEADERS") {
			if (e.data.kind === "rsc") {
				rscHeaders = { ...rscHeaders, ...e.data.headers };
				if (extAlive()) chrome.storage.local.set({ [H_KEY]: rscHeaders }).catch(() => {});
			} else voyHeaders = { ...voyHeaders, ...e.data.headers };
		} else if (e.data.type === "CF_TAP") onTap(e.data.rec, e.data.body);
	});
	if (globalThis.CFDebug) window.postMessage({ type: "CF_TAP_DEBUG", on: true }, location.origin);

	// LinkedIn's page loaded the Contact info card (the user opened it): parse it,
	// and learn the request in case it differs from the built-in one.
	function onTap(rec, body) {
		if (!rec) return;
		if (!rec.contactReq && !rec.contactBody) {
			if (/^\/in\//.test(rec.page)) dbg("tap", `${rec.method} ${rec.status} ${rec.url.slice(0, 160)} (${rec.ct.split(";")[0]}, ${rec.bytes} B, ${rec.ms} ms)`);
			return;
		}
		const why = P.looksLikeContactPayload(rec.url, rec.reqBody, body);
		dbg("tap", `contact-related ${rec.method} ${rec.status} ${rec.url.slice(0, 200)} on ${rec.page} — ${why || "not the card (ignored)"}`, { reqBody: (rec.reqBody || "").slice(0, 800), bytes: rec.bytes });
		if (!why || rec.status !== 200 || typeof body !== "string") return;
		const vanity = vanityFromBody(rec.reqBody) || vanityOf(rec.page);
		if (!vanity) return;
		const parsed = P.parseContactPayload(body);
		captured.set(vanity.toLowerCase(), { at: Date.now(), emails: parsed.emails, phones: parsed.phones });
		logCard(vanity, "page", parsed);
		if (extAlive()) chrome.runtime.sendMessage({ type: "CF_CAPTURED", vanity, emails: parsed.emails, phones: parsed.phones }).catch(() => {});
		learnTemplate(rec, vanity);
	}
	const vanityFromBody = b => ((String(b || "").match(/"vanityName"\s*:\s*"([^"]+)"/) || [])[1] || "");

	function logCard(vanity, via, parsed) {
		dbg("card", `contact card for /in/${vanity} (${via}): ${parsed.emails.length} email(s), ${parsed.phones.length} phone(s)`, {
			info: parsed.info,
			emails: parsed.emails,
			phones: parsed.phones,
			// What the parser saw, in order — tells exactly why a value was or wasn't picked.
			strings: parsed.strings.slice(0, 160).join(" ¦ "),
		});
	}

	// -------------------------------------------------------------------------
	// The Contact info request
	// -------------------------------------------------------------------------
	const SCREEN = "com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay";
	const BUILT_IN = {
		v: 2,
		builtIn: true,
		method: "POST",
		url: `/flagship-web/rsc-action/actions/navigation?screenId=${SCREEN}&sduiid=${SCREEN}`,
		body: JSON.stringify({
			clientArguments: {
				$type: "proto.sdui.actions.requests.RequestedArguments",
				requestedStateKeys: [],
				payload: { vanityName: "{{VANITY}}", givenName: "{{GIVEN}}", familyName: "{{FAMILY}}", isVanityNameResolved: true },
				requestMetadata: { $type: "proto.sdui.common.RequestMetadata" },
				states: [],
				screenId: SCREEN,
				knownTemplateIds: [],
			},
			isModal: true,
		}),
		headers: { "content-type": "application/json", "x-li-rsc-stream": "true", "x-li-anchor-page-key": "d_flagship3_profile_view_base" },
	};
	const TPL_KEY = "cfTemplate";
	const PER_REQUEST = /^(csrf-token|x-li-traceparent|x-li-tracestate|x-li-pageforestid|x-li-page-instance-tracking-id)$/i;

	const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	function learnTemplate(rec, vanity) {
		let body = String(rec.reqBody || "");
		const j = (() => {
			try {
				return JSON.parse(body);
			} catch (e) {
				return null;
			}
		})();
		const p = j && j.clientArguments && j.clientArguments.payload;
		if (p && p.vanityName) {
			p.vanityName = "{{VANITY}}";
			if ("givenName" in p) p.givenName = "{{GIVEN}}";
			if ("familyName" in p) p.familyName = "{{FAMILY}}";
			body = JSON.stringify(j);
		} else body = body.replace(new RegExp(esc(vanity), "g"), "{{VANITY}}");
		const url = String(rec.url).replace(new RegExp(esc(vanity), "g"), "{{VANITY}}");
		if (!/\{\{VANITY\}\}/.test(url + body)) return dbg("template", "captured request doesn't carry the vanity name — not saved", { url, body });
		if (url === BUILT_IN.url && body === BUILT_IN.body) return; // same as built-in
		const headers = {};
		for (const [k, v] of Object.entries(rec.reqHeaders || {})) if (!PER_REQUEST.test(k)) headers[k] = v;
		const tpl = { v: 2, method: rec.method, url, body, headers, learnedAt: Date.now(), fail: 0 };
		if (extAlive()) chrome.storage.local.set({ [TPL_KEY]: tpl }).catch(() => {});
		dbg("template", "LinkedIn's page used a different Contact info request than the built-in one — saved and used first from now on", tpl);
	}

	const fill = (s, v, first, last) =>
		String(s || "")
			.replace(/\{\{VANITY\}\}/g, v)
			.replace(/\{\{GIVEN\}\}/g, (first || "").replace(/["\\]/g, ""))
			.replace(/\{\{FAMILY\}\}/g, (last || "").replace(/["\\]/g, ""));

	// → { ok, emails, phones } | { ok:false, error }
	async function contactRequest(tpl, vanity, first, last) {
		const headers = {};
		for (const [k, v] of Object.entries(tpl.headers || {})) if (!PER_REQUEST.test(k)) headers[k] = v;
		for (const [k, v] of Object.entries(rscHeaders)) if (!PER_REQUEST.test(k) && !(k in BUILT_IN.headers)) headers[k] = v;
		const url = fill(tpl.url, encodeURIComponent(vanity), first, last);
		const done = dbgTime("lookup", `contact request (${tpl.builtIn ? "built-in" : "learned"}) for /in/${vanity}`);
		const r = await request(url, { method: tpl.method, headers, body: fill(tpl.body, vanity, first, last), accept: "*/*", restli: false });
		const card = r.status === 200 && P.isContactCard(r.text);
		const oops = card && /"isOops"\s*:\s*true/.test(r.text);
		done({ status: r.status || r.error, bytes: r.text.length, card, oops, sentHeaders: Object.keys(headers) });
		if (!card || oops) return { ok: false, error: r.status !== 200 ? `HTTP ${r.status || r.error}` : oops ? "LinkedIn answered with an error card" : "answer wasn't the Contact info card", ms: r.ms };
		const parsed = P.parseContactPayload(r.text);
		logCard(vanity, tpl.builtIn ? "built-in request" : "learned request", parsed);
		return { ok: true, emails: parsed.emails, phones: parsed.phones, ms: r.ms };
	}

	// v5.0.3 saved the request with the first person's names baked in → placeholders.
	function upgradeTemplate(t) {
		if (!t || t.v === 2) return t;
		try {
			const j = JSON.parse(t.body);
			const p = j.clientArguments.payload;
			if ("givenName" in p) p.givenName = "{{GIVEN}}";
			if ("familyName" in p) p.familyName = "{{FAMILY}}";
			return { v: 2, method: t.method, url: t.url, body: JSON.stringify(j), headers: t.headers || {}, learnedAt: t.learnedAt, fail: 0 };
		} catch (e) {
			return null;
		}
	}

	async function contactInfo(vanity, first, last, log) {
		const { [TPL_KEY]: saved } = await chrome.storage.local.get(TPL_KEY);
		const learned = upgradeTemplate(saved);
		if (learned !== saved) chrome.storage.local.set({ [TPL_KEY]: learned }).catch(() => {});
		const order = learned && learned.fail < 3 ? [learned, BUILT_IN] : [BUILT_IN];
		for (const tpl of order) {
			const r = await contactRequest(tpl, vanity, first, last);
			if (!tpl.builtIn) {
				learned.fail = r.ok ? 0 : learned.fail + 1;
				chrome.storage.local.set({ [TPL_KEY]: learned }).catch(() => {});
			}
			if (r.ok) {
				log.push(`contact info: ok (${r.ms} ms)`);
				return r;
			}
			log.push(`contact info (${tpl.builtIn ? "built-in" : "learned"} request): ${r.error}`);
		}
		const cap = captured.get(vanity.toLowerCase());
		if (cap) {
			log.push("contact info: using the card LinkedIn loaded on this page");
			return { ok: true, emails: cap.emails, phones: cap.phones };
		}
		return { ok: false };
	}

	// -------------------------------------------------------------------------
	// Network helpers
	// -------------------------------------------------------------------------
	class SignedOut extends Error {}
	class RateLimited extends Error {}
	const csrf = () => {
		const m = document.cookie.match(/(?:^|;\s*)JSESSIONID=("?)([^";]+)\1/);
		return m ? m[2] : "";
	};
	const BLOCK_RE = /\/(authwall|checkpoint|login|uas\/login|signup)/;

	async function request(url, { method = "GET", headers = {}, body, accept = "application/json", timeout = 20000, restli = true } = {}) {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), timeout);
		const t0 = performance.now();
		try {
			const h = { accept, "csrf-token": csrf(), ...(restli ? { "x-restli-protocol-version": "2.0.0", ...voyHeaders } : {}), ...headers };
			const r = await fetch(url, { method, headers: h, body: method === "GET" ? undefined : body, credentials: "include", signal: ctl.signal });
			const text = await r.text();
			const ms = Math.round(performance.now() - t0);
			if (r.status === 401 || (r.redirected && BLOCK_RE.test(new URL(r.url).pathname))) throw new SignedOut();
			if (r.status === 429 || r.status === 999) throw new RateLimited();
			return { status: r.status, text, ms, ct: r.headers.get("content-type") || "" };
		} catch (e) {
			if (e instanceof SignedOut || e instanceof RateLimited) throw e;
			return { status: 0, text: "", ms: Math.round(performance.now() - t0), error: e.name === "AbortError" ? "timed out" : e.message };
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

	// -------------------------------------------------------------------------
	// Profile (Voyager): free text the person wrote + profile id
	// -------------------------------------------------------------------------
	const DECORATIONS = [
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93",
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-96",
		"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-128",
	];
	const SECTION = {
		headline: "Headline",
		multiLocaleHeadline: "Headline",
		summary: "About",
		multiLocaleSummary: "About",
		profilePositionGroups: "Experience",
		profilePositions: "Experience",
		profileEducations: "Education",
		profileCertifications: "Certifications",
		profilePublications: "Publications",
		profileHonors: "Honors",
		profileTestScores: "Test scores",
		profileOrganizations: "Organizations",
		profileVolunteerExperiences: "Volunteering",
		profileProjects: "Projects",
		profileCourses: "Courses",
		profilePatents: "Patents",
	};
	const TYPE_SECTION = [
		[/PositionGroup|\.Position$/, "Experience"],
		[/Education/, "Education"],
		[/Certification/, "Certifications"],
		[/Publication/, "Publications"],
		[/Honor/, "Honors"],
		[/TestScore/, "Test scores"],
		[/Organization$/, "Organizations"],
		[/Volunteer/, "Volunteering"],
		[/Project/, "Projects"],
		[/Course/, "Courses"],
		[/Patent/, "Patents"],
		[/identity\.profile\.Profile$/, "Profile"],
	];
	const TEXT_KEY = /^(headline|summary|description|title|activities|text|role|position)$/;
	// Linked entities (employer, school…) describe someone else — skipped.
	const SKIP_KEY = /^(company|school|companyUrn|schoolUrn|.*ResolutionResult|.*Urn|.*urn|trackingId|\$.*|\*.*|logo|.*Image|.*Picture|profilePicture|backgroundPicture|geo|location|industry|profileSkills|profileLanguages|.*Url|.*URL|publicIdentifier)$/;
	const FOREIGN_TYPE = /organization\.(Company|School)|\.Company$|\.School$|Geo|Industry|Image|Skill|Language|Insight|MemberRelationship|Follow/;

	function walkProfile(obj, col, section, depth = 0) {
		if (!obj || typeof obj !== "object" || depth > 12) return;
		for (const [k, v] of Object.entries(obj)) {
			if (SKIP_KEY.test(k)) continue;
			const sec = SECTION[k] || section;
			if (typeof v === "string") {
				if (TEXT_KEY.test(k)) col.text(v, k === "headline" ? "Headline" : k === "summary" ? "About" : sec);
			} else if (v && typeof v === "object") {
				if (/^multiLocale/.test(k) && !Array.isArray(v)) Object.values(v).forEach(s => typeof s === "string" && col.text(s, sec));
				else walkProfile(v, col, sec, depth + 1);
			}
		}
	}

	const nameOf = (o, k) => {
		const v = o[k];
		if (typeof v === "string") return v;
		const ml = o["multiLocale" + k[0].toUpperCase() + k.slice(1)];
		return (ml && Object.values(ml).find(x => typeof x === "string")) || "";
	};

	async function voyagerProfile(vanity, col, log) {
		for (const deco of DECORATIONS) {
			const short = deco.split("-").pop();
			const done = dbgTime("lookup", `profile API -${short}`);
			const r = await request(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=${encodeURIComponent(deco)}`);
			done({ status: r.status || r.error, bytes: r.text.length });
			if (r.status !== 200) {
				log.push(`profile API -${short}: ${r.status || r.error}`);
				if (r.status === 403 || r.status === 0) return null;
				continue;
			}
			const j = json(r.text);
			const els = (j && (j.elements || (j.data && (j.data.elements || j.data["*elements"])))) || [];
			const el = els[0];
			if (el && typeof el === "object") {
				P.readContactFields(el, col, "Contact info");
				walkProfile(el, col, "Profile");
				const pid = (String(el.entityUrn || "").match(/fsd_profile:([\w-]+)/) || [])[1] || "";
				log.push(`profile API -${short}: ok`);
				return { pid, first: nameOf(el, "firstName"), last: nameOf(el, "lastName"), publicId: typeof el.publicIdentifier === "string" ? el.publicIdentifier : "" };
			}
			const inc = (j && Array.isArray(j.included) && j.included) || [];
			if (inc.length) {
				let pid = "";
				let first = "";
				let last = "";
				let publicId = "";
				for (const x of inc) {
					const t = String(x.$type || "");
					if (FOREIGN_TYPE.test(t)) continue;
					const sec = (TYPE_SECTION.find(([re]) => re.test(t)) || [])[1];
					if (!sec) continue;
					if (sec === "Profile") {
						P.readContactFields(x, col, "Contact info");
						if (!pid || String(x.publicIdentifier || "").toLowerCase() === vanity.toLowerCase()) pid = (String(x.entityUrn || "").match(/fsd_profile:([\w-]+)/) || [])[1] || pid;
						first = first || nameOf(x, "firstName");
						last = last || nameOf(x, "lastName");
						publicId = publicId || (typeof x.publicIdentifier === "string" ? x.publicIdentifier : "");
					}
					walkProfile(x, col, sec);
				}
				log.push(`profile API -${short}: ok (normalized, ${inc.length} entities)`);
				return { pid, first, last, publicId };
			}
			log.push(`profile API -${short}: 200 without profile`);
		}
		return null;
	}

	// -------------------------------------------------------------------------
	// About section as rendered (backup for the API; works without <h2> titles)
	// -------------------------------------------------------------------------
	function domAbout() {
		const main = document.querySelector("main");
		if (!main) return "";
		const titles = [...main.querySelectorAll("h2, h3, p, span, div, [role=heading]")].filter(
			e => e.childElementCount <= 1 && /^about$/i.test((e.textContent || "").trim()) && !e.closest("a, button, footer, nav, aside")
		);
		for (const t of titles) {
			const sec = t.closest("section") || t.parentElement?.parentElement?.parentElement;
			if (!sec) continue;
			const txt = (sec.innerText || "").replace(/^\s*about\s*/i, "");
			if (txt.trim().length > 3 && txt.length < 8000) return txt;
		}
		return "";
	}

	// -------------------------------------------------------------------------
	// One lookup: profile API + Contact info request, in parallel.
	// -------------------------------------------------------------------------
	function namesFromTitle(vanity) {
		// "(3) Shubham Chamedia | LinkedIn" — only valid on that person's own page
		if (vanityOf(location.pathname).toLowerCase() !== vanity.toLowerCase()) return null;
		const n = document.title.replace(/^\(\d+\)\s*/, "").split("|")[0].trim();
		if (!n || /linkedin/i.test(n)) return null;
		const [first, ...rest] = n.split(/\s+/);
		return { first, last: rest.join(" ") };
	}

	async function lookup(vanity, opts = {}) {
		const t0 = performance.now();
		const log = [];
		const timings = {};
		const col = P.collector();
		const onThisProfile = vanityOf(location.pathname).toLowerCase() === vanity.toLowerCase();
		dbg("lookup", `start /in/${vanity}`, { page: location.pathname, opts });
		try {
			// Deep Run (v5.1) already has the profile: only the Contact info card is asked for.
			if (opts.contactOnly) {
				const s = performance.now();
				const c = await contactInfo(vanity, opts.first || "", opts.last || "", log);
				timings.contact = Math.round(performance.now() - s);
				return { ok: true, contactChecked: !!c.ok, textChecked: false, contactEmails: c.ok ? c.emails : [], contactPhones: c.ok ? c.phones : [], emails: [], phones: [], log, timings };
			}
			// The Contact info request needs the public vanity name. Sales Nav exports give
			// /in/ACwAA… member-id URLs: for those LinkedIn answers with an EMPTY card (a
			// false "not found"), so the real vanity comes from the profile API first.
			// Names only fill the card's title; on the person's own page they come from the
			// page title so both requests start at once.
			const memberIdUrl = /^AC[wo]AA[\w-]{10,}$/.test(vanity);
			const names = memberIdUrl ? null : namesFromTitle(vanity);
			const s = performance.now();
			const profP = voyagerProfile(vanity, col, log).then(p => ((timings.profile = Math.round(performance.now() - s)), p));
			const contactP = (names ? Promise.resolve({ ...names, v: vanity }) : profP.then(p => ({ first: (p && p.first) || "", last: (p && p.last) || "", v: memberIdUrl ? (p && p.publicId) || "" : vanity })))
				.then(n => {
					if (!n.v) {
						log.push("contact info: couldn't turn the member-id URL into the public profile URL");
						return { ok: false };
					}
					return contactInfo(n.v, n.first, n.last, log);
				})
				.then(c => ((timings.contact = Math.round(performance.now() - s)), c));
			const prof = await profP;
			if (onThisProfile) {
				const about = domAbout();
				if (about) col.text(about, "About");
			}
			const contact = await contactP;
			const o = col.out();
			const res = {
				ok: true,
				contactChecked: !!contact.ok,
				textChecked: !!prof,
				contactEmails: contact.ok ? contact.emails : [],
				contactPhones: contact.ok ? contact.phones : [],
				...o, // text-derived emails/phones + scanned + ignored
				publicId: (prof && prof.publicId) || "",
				log,
				timings: { ...timings, total: Math.round(performance.now() - t0) },
			};
			dbg("lookup", `done /in/${vanity}`, res);
			return res;
		} catch (e) {
			const error =
				e instanceof SignedOut
					? "You're signed out of LinkedIn. Sign in and try again."
					: e instanceof RateLimited
						? "LinkedIn is limiting requests from this account right now. Try again later."
						: `Unexpected error: ${e.message}`;
			dbg("lookup", `failed /in/${vanity}: ${error}`, { stack: e.stack });
			return { ok: false, fatal: e instanceof SignedOut || e instanceof RateLimited, rateLimited: e instanceof RateLimited, error, log, timings };
		}
	}

	// -------------------------------------------------------------------------
	// Deep Run for leads from a CSV (v5.12): the full profile from LinkedIn's profile
	// API, from this tab — no Sales Navigator needed. Same answer shape as content.js
	// fetchProfileForBackground (Sales Nav tab), minus Sales Nav's own extras.
	// -------------------------------------------------------------------------
	async function deepProfile(lead) {
		const log = [];
		const t0 = performance.now();
		const vanity = (String(lead.publicProfileUrl || "").match(/\/in\/([^/?#]+)/) || [])[1] || "";
		const identity = vanity && !/^AC[wo]AA/.test(vanity) ? decodeURIComponent(vanity) : lead.memberId || vanity; // Voyager takes either
		try {
			for (const deco of DECORATIONS) {
				const short = deco.split("-").pop();
				const r = await request(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(identity)}&decorationId=${encodeURIComponent(deco)}`);
				if (r.status === 403 && /VoyagerUserVisibleException|can.t be accessed/i.test(r.text)) return { ok: false, inaccessible: true, log, timings: { profile: Math.round(performance.now() - t0) } };
				if (r.status !== 200) {
					log.push(`profile API -${short}: ${r.status || r.error}`);
					if (r.status === 403 || r.status === 0) break;
					continue;
				}
				const j = json(r.text);
				const el = j && (j.elements || (j.data && j.data.elements) || [])[0];
				if (!el || typeof el !== "object") {
					log.push(`profile API -${short}: 200 without profile`);
					continue;
				}
				const m = globalThis.SNVoyagerMap.mapProfile(el);
				const pid = m.publicIdentifier || "";
				return {
					ok: true,
					data: m.data,
					truncated: m.truncatedInfo || [],
					experienceFrom: "",
					salesOk: false,
					timings: { profile: Math.round(performance.now() - t0) },
					contact: { email: [], phone: [], websites: [], other: [] },
					publicProfileUrl: pid ? `https://www.linkedin.com/in/${pid}/` : "",
					publicIdentifier: pid,
					headline: m.headline || "",
					firstName: m.firstName || "",
					lastName: m.lastName || "",
					searchFields: m.searchFields || {},
					decoration: short,
					vanityHow: "profile API",
					log,
				};
			}
			return { ok: false, error: log.join("; ") || "profile API failed", log };
		} catch (e) {
			const fatal = e instanceof SignedOut || e instanceof RateLimited;
			return { ok: false, fatal, rateLimited: e instanceof RateLimited, error: e instanceof SignedOut ? "You're signed out of LinkedIn — sign in, then Continue." : e instanceof RateLimited ? "HTTP 429 — LinkedIn is rate-limiting this account." : e.message, log };
		}
	}

	chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
		if (msg.type === "CF_DEEP_PROFILE") {
			deepProfile(msg.lead || {}).then(sendResponse, e => sendResponse({ ok: false, error: e.message, log: [] }));
			return true;
		}
		if (msg.type === "CF_PING") {
			sendResponse({ ok: true, path: location.pathname });
			return;
		}
		if (msg.type === "CF_LOOKUP") {
			lookup(msg.vanity, msg.opts || {}).then(sendResponse, e => sendResponse({ ok: false, error: e.message, log: [] }));
			return true;
		}
	});

	globalThis.__cfLookup = lookup; // for tests
	dbg("init", `contact finder ready on ${location.pathname}`);
})();
