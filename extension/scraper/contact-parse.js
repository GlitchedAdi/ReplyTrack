// Pure parsing helpers for the contact finder — no DOM, no network, no chrome.*.
// Loaded by the LinkedIn content script (contact-finder.js) and by the service
// worker, so both use the exact same rules.
//
// Accuracy over recall: a value is only returned when it is clearly an email /
// phone number. In free text, bare numbers need a phone-like shape or a
// "call/phone/WhatsApp" cue; money, dates, counts, IDs and placeholders are
// rejected (and reported back as "ignored", with the reason, for the debug log).
(function (root) {
	if (root.CFParse) return;

	// -------------------------------------------------------------------------
	// Text cleanup — NFKC turns styled text (𝟗𝟖𝟕…, 𝐣𝐨𝐡𝐧@…, fullwidth ＠) into ASCII.
	// -------------------------------------------------------------------------
	const clean = s =>
		String(s == null ? "" : s)
			.normalize("NFKC")
			// zero-width + bidi marks (LinkedIn wraps phone numbers in \u202A…\u202C)
			.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g, "")
			.replace(/\u00A0/g, " ");

	// -------------------------------------------------------------------------
	// Emails
	// -------------------------------------------------------------------------
	const EMAIL_RE = /(?<![a-z0-9._%+\-])[a-z0-9](?:[a-z0-9._%+\-]*[a-z0-9_])?@(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,24}(?![a-z0-9\-])/gi;
	const FILE_TLD = /\.(png|jpe?g|gif|svg|webp|bmp|ico|pdf|js|css|mp4|mov)$/i;
	const PLACEHOLDER_DOMAIN = /^(example\.(com|org|net)|domain\.com|yourdomain\.com|yourcompany\.com|company\.com|email\.com|test\.com|sentry\.io|xyz\.com|abc\.com)$/i;
	const NOREPLY_LOCAL = /^(no-?reply|do-?not-?reply|noreply\d*|mailer-daemon|postmaster|abuse|test|name|yourname|firstname\.lastname|email|user|username)$/i;

	function deobfuscateEmails(t) {
		return t
			.replace(/\s*[\[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, "@") // john [at] gmail.com
			.replace(/\s*[\[({<]\s*(?:dot|\.)\s*[\])}>]\s*/gi, ".") // gmail [dot] com
			.replace(/([a-z0-9._%+\-])\s+@\s*([a-z0-9])/gi, "$1@$2") // john @ gmail.com
			.replace(/([a-z0-9._%+\-])@\s+([a-z0-9])/gi, "$1@$2");
	}

	function validEmail(e) {
		e = String(e || "").trim().replace(/^mailto:/i, "").replace(/[.,;:]+$/, "").toLowerCase();
		const m = e.match(/^([^@\s]+)@([^@\s]+)$/);
		if (!m) return "";
		const [, local, domain] = m;
		if (FILE_TLD.test(domain) || PLACEHOLDER_DOMAIN.test(domain) || NOREPLY_LOCAL.test(local)) return "";
		if (/\.\./.test(e) || local.length > 64 || domain.length > 253) return "";
		if (!/^[a-z0-9](?:[a-z0-9._%+\-]*[a-z0-9_])?$/.test(local)) return "";
		if (!/^(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return "";
		return e;
	}

	// An email written straight before another word loses its end: "x@gmail.comPhone",
	// "contact@firm.comKIPX" (seen in an About section). Trimmed back to the real TLD
	// when the text shows the join (lower → upper case), or for the big mail providers.
	const KNOWN_TLD = new Set(
		("com net org edu gov mil int info biz pro name mobi asia xyz app dev tech online site store shop live life world today " +
			"cloud design agency email solutions services consulting digital media global group network systems studio academy " +
			"education institute health care clinic doctor law legal finance capital money bank insurance company community center " +
			"club coach codes careers jobs work works team tv fm cc ly gg to so is la ws ac ai io me co us uk ca au nz ie in de fr it " +
			"es nl be ch at se no dk fi pl cz sk hu ro gr pt tr il ir ae sa qa om kw bh sg hk jp cn kr tw my id ph th vn pk bd lk np " +
			"za ng ke gh eg ma br mx ar cl pe ru ua").split(" ")
	);
	const MAIL_HOST = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|rediffmail|protonmail|proton|aol|zoho)\.(com|co\.in|in)(?=[a-z])/i;
	function unglue(raw) {
		const at = raw.lastIndexOf("@");
		let dom = raw.slice(at + 1);
		const host = dom.match(MAIL_HOST);
		if (host) dom = host[0];
		else {
			const labels = dom.split(".");
			const last = labels[labels.length - 1];
			const m = last.match(/^([a-z]{2,})([A-Z][A-Za-z]*)$/); // "comPhone"
			if (m && KNOWN_TLD.has(m[1]) && !KNOWN_TLD.has(last.toLowerCase())) labels[labels.length - 1] = m[1];
			dom = labels.join(".");
		}
		return raw.slice(0, at + 1) + dom;
	}

	function findEmails(text) {
		const t = deobfuscateEmails(clean(text));
		const out = [];
		for (const m of t.matchAll(EMAIL_RE)) {
			const e = validEmail(unglue(m[0]));
			if (e && !out.includes(e)) out.push(e);
		}
		return out;
	}

	// "a@b.comkipx" next to "a@b.com" from another section: the longer one is the
	// same address with a word glued on — dropped. list: [{ value }] or strings.
	function dropGlued(list) {
		const vals = list.map(x => (typeof x === "string" ? x : x.value));
		return list.filter((x, i) => {
			const v = vals[i];
			return !vals.some((w, j) => j !== i && w.length < v.length && v.startsWith(w) && /@/.test(w) && /^[a-z]+$/i.test(v.slice(w.length)) && KNOWN_TLD.has(w.split(".").pop()));
		});
	}

	// -------------------------------------------------------------------------
	// Phone numbers (India-first: +91 mobiles, but any explicit +<country> works)
	// -------------------------------------------------------------------------
	const PHONE_CUE = /(?:\b(?:phone|mobile|mob|cell|cellphone|call|calls|calling|whats\s?app|wa|contact|reach|tel|telephone|ph|dial|text|sms|office|landline|off|work)\b[^\n\d]{0,22}|\b[mp]\s*[:\-]\s*|[☎\u{1F4DE}\u{1F4F1}✆☏\u{1F4F2}]️?\s*[:\-]?\s*)$/iu;
	const MONEY_BEFORE = /(?:[₹$€£¥]|\brs\.?|\binr|\busd)\s*$/i;
	const COUNT_AFTER = /^\s*(?:\+(?!\d)|%|k\b|m\b|mn\b|bn\b|cr\b|crores?\b|lakhs?\b|lacs?\b|million|billion|users|followers|views|downloads|customers|members|people|students|clients|employees|installs|subscribers|usd|inr|rs\b|rupees)/i;
	const FAKE = /^(\d)\1+$|^(?:9876543210|1234567890|0123456789|9999999999|9898989898)$/;
	// A string that is nothing but a phone number (used for labelled values).
	const PHONE_LINE = /^\+?[\d\s().\-–—]{7,24}(\s*\((mobile|home|work|other)\))?$/i;

	const fmtIndia = n => (/^[6-9]/.test(n) ? `+91 ${n.slice(0, 5)} ${n.slice(5)}` : `+91 ${n}`);

	// tok: raw text of the candidate; ctx: { cue, money, count, labeled }.
	// Returns the formatted number, or "" (ctx.why then says why it was rejected).
	function classifyPhone(tok, ctx = {}) {
		const hasPlus = /^[^\d]*\+/.test(tok);
		let d = tok.replace(/\D/g, "");
		let intl = hasPlus;
		if (!intl && d.startsWith("00") && d.length >= 12) {
			d = d.slice(2);
			intl = true;
		}
		const no = why => ((ctx.why = why), "");
		// Contact-info phone field: what the person typed — kept as written
		// (Indian mobiles normalised to +91 …).
		if (ctx.labeled) {
			if (d.length < 7 || d.length > 15) return no("not a phone number");
			if (intl && d.startsWith("91") && d.length === 12) return fmtIndia(d.slice(2));
			if (!intl && d.length === 10 && /^[6-9]/.test(d)) return fmtIndia(d);
			if (!intl && d.length === 12 && /^91[6-9]/.test(d)) return fmtIndia(d.slice(2));
			return tok.replace(/\s*\((mobile|home|work|other)\)\s*$/i, "").trim();
		}
		if (ctx.money) return no("money amount");
		if (ctx.count) return no("a count, not a phone");
		if (FAKE.test(d) || FAKE.test(d.slice(-10))) return no("placeholder / dummy number");
		if (intl) {
			if (d.startsWith("0")) return no("+0… is not a country code"); // "+09000217835963" (a publication id)
			if (d.startsWith("91")) {
				let n = d.slice(2);
				if (n.length === 11 && n[0] === "0") n = n.slice(1); // +91 (0)98765…
				return n.length === 10 && /^[1-9]/.test(n) ? fmtIndia(n) : no("+91 but not 10 digits");
			}
			return d.length >= 10 && d.length <= 15 ? "+" + d : no("wrong length for +country number");
		}
		const cue = ctx.cue;
		if (d.length === 12 && d.startsWith("91") && /[6-9]/.test(d[2]) && (cue || /^\s*\(?91\)?[\s\-.]/.test(tok))) return fmtIndia(d.slice(2));
		if (d.length === 11 && d[0] === "0" && /[6-9]/.test(d[1])) return fmtIndia(d.slice(1));
		if (d.length === 10 && /^[6-9]/.test(d)) return fmtIndia(d);
		if (cue && d.length >= 10 && d.length <= 12) return tok.trim();
		return no(d.length === 10 ? "not an Indian mobile (6-9…) and no phone cue before it" : "no country code / phone cue");
	}

	const TOKEN_RE = /(?<![\w@.\/])[+(]{0,2}\d[\d().\-–—]*\d\)?|(?<![\w@.\/])\+?\d(?![\w])/g;
	const GAP_OK = /^(?:[ \t]{1,2}|[ \t]*[\-–—.][ \t]*)$/;

	// URLs and emails contain digits that are not phone numbers.
	const stripNoise = t => t.replace(/https?:\/\/\S+|\bwww\.\S+|\b[\w.\-]+\.(?:com|in|io|ai|co|org|net|me)\/\S*/gi, " ").replace(EMAIL_RE, " ");

	// ignored (optional array) receives phone-looking numbers that were rejected, with the reason.
	function findPhones(text, ignored) {
		const raw = clean(text);
		const out = [];
		const add = v => v && !out.some(x => x.replace(/\D/g, "").slice(-10) === v.replace(/\D/g, "").slice(-10)) && out.push(v);

		// WhatsApp / tel: links always carry a real number.
		for (const m of raw.matchAll(/(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=|tel:)\s*(\+?\d[\d\-\s]{7,16}\d)/gi)) {
			const num = m[1].replace(/[\s\-]/g, "");
			add(classifyPhone(/^tel:/i.test(m[0]) ? num : "+" + num.replace(/^\+/, ""), { cue: true }));
		}

		const t = stripNoise(raw);
		const toks = [...t.matchAll(TOKEN_RE)].map(m => ({ s: m.index, e: m.index + m[0].length }));
		for (let i = 0; i < toks.length; i++) {
			// Group up to 5 neighbouring tokens ("+91", "98765", "43210") — longest valid wins.
			let j = i;
			while (j + 1 < toks.length && j - i < 4 && GAP_OK.test(t.slice(toks[j].e, toks[j + 1].s))) j++;
			const top = j;
			let firstWhy = "";
			for (; j >= i; j--) {
				const s = toks[i].s;
				const e = toks[j].e;
				const before = t.slice(Math.max(0, s - 32), s);
				const ctx = { cue: PHONE_CUE.test(before), money: MONEY_BEFORE.test(before), count: COUNT_AFTER.test(t.slice(e, e + 16)) };
				const v = classifyPhone(t.slice(s, e), ctx);
				if (v) {
					add(v);
					i = j;
					break;
				}
				if (!firstWhy && t.slice(s, e).replace(/\D/g, "").length >= 8) firstWhy = `${t.slice(s, e).trim()} → ${ctx.why}`;
			}
			if (j < i && ignored && firstWhy) {
				const d = t.slice(toks[i].s, toks[top].e).replace(/\D/g, "");
				if (d.length >= 8 && d.length <= 15 && !ignored.includes(firstWhy)) ignored.push(firstWhy);
			}
		}
		return out;
	}

	// -------------------------------------------------------------------------
	// Collector: first-seen order (= source priority), all sources per value,
	// plus what was scanned / ignored (for the log).
	// -------------------------------------------------------------------------
	function collector() {
		const emails = new Map();
		const phones = new Map();
		const scanned = {};
		const ignored = [];
		const put = (map, key, value, source) => {
			const cur = map.get(key);
			if (cur) {
				if (!cur.sources.includes(source)) cur.sources.push(source);
			} else map.set(key, { value, sources: [source] });
		};
		return {
			email(v, source) {
				const e = validEmail(v);
				if (e) put(emails, e, e, source);
			},
			phone(v, source) {
				if (v) put(phones, v.replace(/\D/g, "").slice(-10), v, source);
			},
			// Free text (about, headline…): strict rules.
			text(txt, source) {
				if (!txt) return;
				scanned[source] = (scanned[source] || 0) + String(txt).length;
				findEmails(txt).forEach(e => this.email(e, source));
				const ig = [];
				findPhones(txt, ig).forEach(p => this.phone(p, source));
				ig.forEach(x => ignored.length < 8 && ignored.push(`${x} (${source})`));
			},
			ignore(what) {
				if (ignored.length < 8) ignored.push(what);
			},
			out() {
				const f = m => [...m.values()].map(x => ({ value: x.value, source: x.sources.join(", ") }));
				return { emails: dropGlued(f(emails)), phones: f(phones), scanned: { ...scanned }, ignored: ignored.slice() };
			},
		};
	}

	// -------------------------------------------------------------------------
	// Contact-info payloads (whatever LinkedIn's Contact info request returns):
	// JSON (Voyager), React-Server-Component "flight" text, or HTML with the
	// flight data embedded. Parsed without any DOM.
	// -------------------------------------------------------------------------
	const CONTACT_LABEL = /^(emails?|e-mail|email address|phones?|phone number|mobile|websites?|address|birthday|im|twitter|x|wechat|connected|connected since|.+['’]s profile|your profile|profile)$/i;

	// Undo JSON / JS escaping so mailto:, tel: and "@" are plain text.
	const unescapeAll = t =>
		String(t)
			.replace(/\\\\/g, "\\")
			.replace(/\\u0040/gi, "@")
			.replace(/\\u002f/gi, "/")
			.replace(/\\u003a/gi, ":")
			.replace(/\\\//g, "/")
			.replace(/\\"/g, '"');

	// Display strings of a flight / JSON payload, in order. Property names and
	// React/markup noise (element tags, "$L1", class-name hashes, ids, URNs, URLs
	// other than mailto/tel) are dropped, so a label and its value sit close together.
	const TAGS = /^(div|span|p|a|h[1-6]|section|ul|ol|li|button|svg|path|img|dialog|header|footer|main|nav|figure|strong|em|b|i|small|label|input|form|time|use|g|circle|rect)$/i;
	const NOISE = s =>
		/^\$/.test(s) || // React refs "$", "$L1", "$undefined"
		TAGS.test(s) ||
		(/[a-z_]/i.test(s) && /^[_a-z0-9]{5,10}( [_a-z0-9]{5,10})+$/i.test(s)) || // "a676b3fa _1d6a4537" (never a bare number)
		(/[a-f_]/i.test(s) && /^[_a-f0-9]{6,40}$/i.test(s)) || // single hash / id
		/^(urn:|com\.linkedin\.|proto\.|https?:\/\/(?!.*(wa\.me|whatsapp)))/i.test(s) ||
		/^[\w-]+(\.[\w-]+){2,}$/.test(s) || // dotted identifiers
		/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || // uuids
		/^\d{13,}$/.test(s) || // timestamps / numeric ids (no separators, longer than any phone)
		/^(true|false|null|none|auto|polite|assertive|presentation|dialog|button|link|img|_blank|noopener.*|lazy|eager)$/i.test(s);
	function displayStrings(t) {
		const out = [];
		// Consume every string literal (so quotes never get out of step), keep the values.
		for (const m of t.matchAll(/"((?:[^"\\\n]|\\.)*)"(\s*:)?/g)) {
			if (m[2] || !m[1] || m[1].length > 400) continue; // property name / empty / huge
			let s = m[1];
			try {
				s = JSON.parse(`"${s}"`);
			} catch (e) {}
			s = clean(s).replace(/\s+/g, " ").trim();
			if (s && !NOISE(s)) out.push(s);
		}
		return out;
	}

	const TYPE_WORD = /^\(?(mobile|home|work|other|pager|fax)\)?$/i;
	const EMAIL_LINE = /^(mailto:)?[^\s@"]+@[^\s@"]+\.[a-z]{2,24}$/i;
	const isPhoneLine = l => PHONE_LINE.test(l) && l.replace(/\D/g, "").length >= 7;

	// Label → value pairs ("Phone", …, "98765 43210", "(Mobile)", "Email", …).
	// strict (flight data): a value counts only inside the section of its label
	// (until the next label, max 40 strings), or when a phone number is directly
	// followed by its type "(Mobile)". Non-strict (a rendered popup whose rows use
	// icons instead of labels) also accepts stand-alone email / phone lines.
	function parseLabelled(lines, col, src, strict) {
		let label = null;
		let left = 0;
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i];
			if (/^contact info$/i.test(l)) continue;
			if (CONTACT_LABEL.test(l)) {
				label = l;
				left = 40;
				continue;
			}
			if (TYPE_WORD.test(l)) continue;
			const isEmail = EMAIL_LINE.test(l);
			const isPhone = isPhoneLine(l);
			const inSection = label && left-- > 0;
			const typedPhone = isPhone && lines.slice(i + 1, i + 4).some(x => TYPE_WORD.test(x));
			if (inSection && /e-?mail/i.test(label) && isEmail) col.email(l, src);
			else if ((inSection && /phone|mobile/i.test(label) && isPhone) || typedPhone) col.phone(classifyPhone(l, { labeled: true }), src);
			else if (!strict && (!label || !/e-?mail|phone|mobile/i.test(label))) {
				if (isEmail) col.email(l, src);
				else if (isPhone) col.phone(classifyPhone(l, { labeled: true }), src);
			}
		}
	}

	// Contact fields as LinkedIn's JSON models name them.
	function readContactFields(obj, col, source) {
		if (!obj || typeof obj !== "object") return false;
		let seen = false;
		const ea = obj.emailAddress;
		if (ea !== undefined) seen = true;
		if (typeof ea === "string") col.email(ea, source);
		else if (ea && typeof ea === "object") col.email(ea.emailAddress || ea.email || "", source);
		for (const e of Array.isArray(obj.emailAddresses) ? obj.emailAddresses : []) col.email(typeof e === "string" ? e : e.emailAddress || e.email || "", source);
		const pn = obj.phoneNumbers;
		if (pn !== undefined) seen = true;
		for (const p of Array.isArray(pn) ? pn : []) {
			const num = typeof p === "string" ? p : p.number || (p.phoneNumber && (p.phoneNumber.number || p.phoneNumber)) || "";
			if (typeof num === "string" && num) col.phone(classifyPhone(num, { labeled: true }), source);
		}
		return seen;
	}

	// profileId (ACoAA…) of the person the payload should be about, when known:
	// JSON entities that belong to someone else are skipped.
	function parseContactPayload(text, { profileId = "", source = "Contact info" } = {}) {
		const col = collector();
		const info = { kind: "text", jsonEntities: 0, mailto: 0, tel: 0, labelled: 0 };
		const body = String(text || "");
		let j = null;
		if (/^\s*[\[{]/.test(body)) {
			try {
				j = JSON.parse(body);
			} catch (e) {}
		}
		if (j) {
			info.kind = "json";
			const seenObjs = new WeakSet();
			(function walk(o, depth) {
				if (!o || typeof o !== "object" || depth > 30 || seenObjs.has(o)) return;
				seenObjs.add(o);
				const urn = typeof o.entityUrn === "string" ? o.entityUrn : "";
				const other = profileId && /fsd_profile|fs_miniProfile|profile/i.test(urn) && !urn.includes(profileId);
				if (!other && readContactFields(o, col, source)) info.jsonEntities++;
				for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, depth + 1);
			})(j, 0);
		}
		const flat = unescapeAll(body);
		if (/<html|<!doctype/i.test(body.slice(0, 300))) info.kind = "html";
		else if (!j && /^\s*\w+:[\[{"IT]/m.test(body)) info.kind = "flight";
		for (const m of flat.matchAll(/mailto:([^"'\\\s<>)?&]+)/gi)) {
			info.mailto++;
			try {
				col.email(decodeURIComponent(m[1]), source);
			} catch (e) {
				col.email(m[1], source);
			}
		}
		for (const m of flat.matchAll(/tel:(\+?[\d\-\s().]{7,22}\d)/gi)) {
			info.tel++;
			col.phone(classifyPhone(m[1], { labeled: true }), source);
		}
		// Phone numbers passed as component data, e.g. "phoneNumber":"+91 98…".
		for (const m of flat.matchAll(/"(?:phoneNumber|phone|number|mobile|mobileNumber|formattedNumber)"\s*:\s*"([^"]{7,32})"/gi)) {
			const v = clean(m[1]).trim();
			if (isPhoneLine(v)) {
				info.props = (info.props || 0) + 1;
				col.phone(classifyPhone(v, { labeled: true }), source);
			}
		}
		// Label → value strings. In a whole HTML page only look after the "Contact info" title.
		let scope = flat;
		if (info.kind === "html") {
			const at = flat.search(/"Contact info"/);
			scope = at >= 0 ? flat.slice(at, at + 60000) : "";
		}
		const strings = displayStrings(scope);
		const before = col.out();
		parseLabelled(strings, col, source, true);
		const after = col.out();
		info.labelled = after.emails.length + after.phones.length - before.emails.length - before.phones.length;
		info.card = isContactCard(body);
		info.oops = /"isOops"\s*:\s*true/.test(body);
		const o = col.out();
		return { emails: o.emails, phones: o.phones, info, strings };
	}

	// Is this request/response LinkedIn's Contact info card? Deliberately strict:
	// a wrong match would teach the extension the wrong request. The new UI's card
	// is the SDUI screen "…profile.ProfileContactDetailsOverlay" (seen in real
	// traffic, Sep 2026); older ones name "contact-info" in the URL.
	const CARD_SCREEN = /ProfileContactDetailsOverlay|ContactDetailsOverlay/;
	const CONTACT_URL_HINT = /contact[-_ ]?info|contactinfo|ContactDetails/i;
	const isContactCard = text => CARD_SCREEN.test(String(text || "").slice(0, 20000));
	function looksLikeContactPayload(url, reqBody, text) {
		if (CARD_SCREEN.test(url || "") || CARD_SCREEN.test(reqBody || "")) return "request is LinkedIn's Contact info card";
		if (isContactCard(text)) return "answer is LinkedIn's Contact info card";
		if (/\/rsc-action\/|\/voyager\/api\//.test(url || "") && (CONTACT_URL_HINT.test(url || "") || CONTACT_URL_HINT.test(reqBody || ""))) return "request names contact info";
		const t = unescapeAll(String(text || "").slice(0, 3000000));
		if (/Contact info/.test(t) && /mailto:|tel:\+?\d|"emailAddress"\s*:|"phoneNumbers"\s*:/.test(t)) return "answer has the card title + contact data";
		return "";
	}

	root.CFParse = {
		clean,
		validEmail,
		findEmails,
		dropGlued,
		findPhones,
		classifyPhone,
		collector,
		parseLabelled,
		readContactFields,
		parseContactPayload,
		looksLikeContactPayload,
		displayStrings,
		isContactCard,
		unescapeAll,
		CONTACT_LABEL,
	};
})(globalThis);
