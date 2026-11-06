// Turns one element of LinkedIn's Voyager
//   identity/dash/profiles?…&decorationId=…FullProfileWithEntities-NN
// response into this extension's field layout. Pure function, no DOM.
// Field names verified against real captured payloads (Aug 2026); fields not
// seen in captures are read defensively from several likely names.
(function (root) {
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

	const isStr = v => typeof v === "string" && v.trim() !== "";
	// First non-empty string among o[k] / o.multiLocaleK (first locale value).
	function str(o, ...keys) {
		if (!o) return "";
		for (const k of keys) {
			const v = o[k];
			if (isStr(v)) return v.trim();
			if (v && typeof v === "object" && isStr(v.text)) return v.text.trim();
			if (v && typeof v === "object" && isStr(v.name)) return v.name.trim();
			const ml = o["multiLocale" + k[0].toUpperCase() + k.slice(1)];
			if (ml && typeof ml === "object") {
				const first = Object.values(ml).find(isStr);
				if (first) return first.trim();
			}
		}
		return "";
	}

	function fmtDate(d) {
		if (!d || typeof d !== "object" || !d.year) return "";
		const m = d.month ? MONTHS[d.month - 1] + " " : "";
		return d.day && d.month ? `${MONTHS[d.month - 1]} ${d.day}, ${d.year}` : `${m}${d.year}`;
	}

	function range(o) {
		const r = (o && (o.dateRange || o.timePeriod)) || null;
		if (!r) return { start: null, end: null };
		return { start: r.start || r.startDate || null, end: r.end || r.endDate || null };
	}

	function fmtRange(o, openEnded = "Present") {
		const { start, end } = range(o);
		if (!start && !end) return "";
		const s = fmtDate(start);
		const e = end ? fmtDate(end) : openEnded;
		return s && e ? `${s} - ${e}` : s || e;
	}

	// LinkedIn-style duration: counts both the start and end month.
	function duration(o) {
		const { start, end } = range(o);
		if (!start || !start.year) return "";
		const now = new Date();
		const ey = end && end.year ? end.year : now.getFullYear();
		const em = end && end.year ? end.month || 12 : now.getMonth() + 1;
		let months = (ey - start.year) * 12 + (em - (start.month || 1)) + 1;
		if (months < 1) return "";
		const y = Math.floor(months / 12);
		const m = months % 12;
		const parts = [];
		if (y) parts.push(`${y} yr${y > 1 ? "s" : ""}`);
		if (m) parts.push(`${m} mo${m > 1 ? "s" : ""}`);
		return parts.join(" ");
	}

	const coll = (p, key) => (p && p[key] && Array.isArray(p[key].elements) ? p[key].elements : []);
	const total = (p, key) => (p && p[key] && p[key].paging && typeof p[key].paging.total === "number" ? p[key].paging.total : null);
	const pretty = v => (isStr(v) ? v.replace(/^.*[:.]/, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, c => c.toUpperCase()) : "");

	function mapPosition(p, g) {
		const empType = p.employmentType && typeof p.employmentType === "object" ? str(p.employmentType, "name") : pretty(p.employmentTypeUrn || p.employmentType);
		const workplace = p.workplaceType && typeof p.workplaceType === "object" ? str(p.workplaceType, "name", "localizedName") : pretty(p.workplaceTypeUrn || p.workplaceType);
		return {
			title: str(p, "title"),
			company: str(p, "companyName") || str(p.company, "name") || str(g, "companyName") || str(g && g.company, "name"),
			employmentType: empType,
			dates: fmtRange(p),
			duration: duration(p),
			location: str(p, "locationName", "geoLocationName"),
			workplaceType: workplace,
			description: str(p, "description"),
		};
	}

	function mapProfile(p) {
		const out = {};
		const truncated = [];
		const truncatedInfo = []; // e.g. "publications: 20 of 34 returned by LinkedIn"
		const check = (key, field, n) => {
			const t = total(p, key);
			if (t != null && t > n) {
				if (!truncated.includes(field)) truncated.push(field);
				truncatedInfo.push(`${field}: ${n} of ${t}`);
			}
		};

		out.about = str(p, "summary");

		// Experience: groups (one per company) → roles
		out.experience = [];
		for (const g of coll(p, "profilePositionGroups")) {
			const roles = coll(g, "profilePositionInPositionGroup");
			const groupDur = roles.length > 1 ? duration(g) : "";
			if (!roles.length) {
				out.experience.push(mapPosition(g, g));
				continue;
			}
			for (const r of roles) {
				const x = mapPosition(r, g);
				if (groupDur) x.companyTotalDuration = groupDur;
				out.experience.push(x);
			}
			const t = total(g, "profilePositionInPositionGroup");
			if (t != null && t > roles.length) {
				if (!truncated.includes("experience")) truncated.push("experience");
				truncatedInfo.push(`roles at ${str(g, "companyName")}: ${roles.length} of ${t}`);
			}
		}
		check("profilePositionGroups", "experience (companies)", coll(p, "profilePositionGroups").length);

		out.education = coll(p, "profileEducations").map(e => ({
			school: str(e, "schoolName") || str(e.school, "name"),
			degree: [str(e, "degreeName"), str(e, "fieldOfStudy")].filter(Boolean).join(", "),
			dates: fmtRange(e, ""),
			grade: str(e, "grade"),
			activities: str(e, "activities"),
			description: str(e, "description"),
		}));
		check("profileEducations", "education", out.education.length);

		out.certifications = coll(p, "profileCertifications").map(c => {
			const { start, end } = range(c);
			return {
				name: str(c, "name"),
				issuer: str(c, "authority") || str(c.company, "name"),
				issued: fmtDate(start),
				expires: fmtDate(end),
				credentialId: str(c, "licenseNumber", "credentialId"),
			};
		});
		check("profileCertifications", "certifications", out.certifications.length);

		out.publications = coll(p, "profilePublications").map(x => ({
			title: str(x, "name", "title"),
			publisher: str(x, "publisher"),
			date: fmtDate(x.publishedOn || x.date),
			description: str(x, "description"),
		}));
		check("profilePublications", "publications", out.publications.length);

		out.honors = coll(p, "profileHonors").map(h => ({
			title: str(h, "title", "name"),
			issuer: str(h, "issuer"),
			date: fmtDate(h.issuedOn || h.issueDate || h.date),
			associatedWith: str(h, "occupation", "associatedWith"),
			description: str(h, "description"),
		}));
		check("profileHonors", "honors", out.honors.length);

		out.testScores = coll(p, "profileTestScores").map(t => ({
			name: str(t, "name", "title"),
			score: str(t, "score"),
			date: fmtDate(t.dateOn || t.date || t.testDate),
			description: str(t, "description"),
		}));
		check("profileTestScores", "testScores", out.testScores.length);

		out.organizations = coll(p, "profileOrganizations").map(o => ({
			name: str(o, "name", "organizationName"),
			position: str(o, "position", "positionName"),
			dates: fmtRange(o),
			associatedWith: str(o, "occupation", "associatedWith"),
			description: str(o, "description"),
		}));
		check("profileOrganizations", "organizations", out.organizations.length);

		out.volunteering = coll(p, "profileVolunteerExperiences").map(v => ({
			role: str(v, "role", "title"),
			organization: str(v, "companyName") || str(v.company, "name"),
			dates: fmtRange(v),
			duration: duration(v),
			cause: pretty(v.cause) || str(v, "causeName"),
			description: str(v, "description"),
		}));
		check("profileVolunteerExperiences", "volunteering", out.volunteering.length);

		// Drop entries with no text at all
		for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = out[k].filter(x => Object.values(x).some(isStr));

		return {
			data: out,
			truncated,
			truncatedInfo,
			publicIdentifier: str(p, "publicIdentifier"),
			// used by Deep Run's contact finder (v5.1): names for the Contact info request,
			// the headline for the text scan
			headline: str(p, "headline"),
			firstName: str(p, "firstName"),
			lastName: str(p, "lastName"),
			searchFields: searchFields(p),
		};
	}

	// v5.11 — the Standard Run (search card) fields, derived from the same profile
	// response (no extra request). Deep Run only uses them where the search didn't
	// already give a value (e.g. leads imported from a CSV). Same shapes as injected.js
	// buildLead(): tenure {numYears, numMonths}, pastPosition {title, companyName,
	// companyUrn, startedOn, endedOn}.
	const ym = d => (d && d.year ? d.year * 12 + (d.month || 1) - 1 : null);
	function tenureOf(start) {
		const s = ym(start);
		if (s == null) return null;
		const now = new Date();
		const m = now.getFullYear() * 12 + now.getMonth() - s + 1; // LinkedIn counts both months
		return m > 0 ? { numYears: Math.floor(m / 12), numMonths: m % 12 } : null;
	}
	const companyUrnOf = (r, g) => [r.companyUrn, r.company && r.company.entityUrn, g && g.companyUrn, g && g.company && g.company.entityUrn].find(isStr) || "";
	function searchFields(p) {
		const roles = [];
		for (const g of coll(p, "profilePositionGroups")) {
			const rs = coll(g, "profilePositionInPositionGroup");
			if (!rs.length) roles.push({ r: g, g });
			else for (const r of rs) roles.push({ r, g });
		}
		const current = roles.filter(x => range(x.r).start && !range(x.r).end);
		const cur = current.sort((a, b) => ym(range(b.r).start) - ym(range(a.r).start))[0] || null;
		const ended = roles.filter(x => range(x.r).end).sort((a, b) => ym(range(b.r).end) - ym(range(a.r).end));
		const past = ended[0] || null;
		const out = {};
		if (cur) {
			const urn = companyUrnOf(cur.r, cur.g);
			const cid = (urn.match(/(\d+)\)?$/) || [])[1] || "";
			// Time at the company: the group's own range, else its earliest role.
			const sameCo = roles.filter(x => x.g === cur.g).map(x => range(x.r).start).filter(Boolean);
			const coStart = range(cur.g).start || sameCo.sort((a, b) => ym(a) - ym(b))[0];
			Object.assign(out, {
				title: str(cur.r, "title"),
				company: str(cur.r, "companyName") || str(cur.g, "companyName") || str(cur.g.company, "name"),
				companyId: cid,
				titleDescription: str(cur.r, "description"),
				tenureRole: tenureOf(range(cur.r).start),
				tenureCompany: tenureOf(coStart),
			});
		}
		if (past) {
			const { start, end } = range(past.r);
			out.pastPosition = {
				title: str(past.r, "title"),
				companyName: str(past.r, "companyName") || str(past.g, "companyName") || str(past.g.company, "name"),
				companyUrn: companyUrnOf(past.r, past.g),
				startedOn: start || null,
				endedOn: end || null,
			};
		}
		out.firstName = str(p, "firstName");
		out.lastName = str(p, "lastName");
		out.location = str(p, "locationName", "geoLocationName") || str(p.geoLocation && p.geoLocation.geo, "defaultLocalizedName") || str(p.location, "defaultLocalizedName");
		out.profileImageUrl = imageUrl(p, /^profilePicture/i);
		if (typeof p.premium === "boolean") out.premium = p.premium;
		for (const k of Object.keys(out)) if (out[k] == null || out[k] === "") delete out[k];
		return out;
	}

	// Largest rendition of the profile photo.
	function imageUrl(p, keyRe) {
		let best = null;
		(function walk(o, depth, inside) {
			if (!o || typeof o !== "object" || depth > 10) return;
			if (inside && typeof o.rootUrl === "string" && Array.isArray(o.artifacts) && o.artifacts.length) {
				const a = o.artifacts.slice().sort((x, y) => (y.width || 0) - (x.width || 0))[0];
				if (!best || (a.width || 0) > best.w) best = { url: o.rootUrl + (a.fileIdentifyingUrlPathSegment || ""), w: a.width || 0 };
			}
			for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") walk(v, depth + 1, inside || keyRe.test(k));
		})(p, 0, false);
		return best ? best.url : "";
	}

	root.SNVoyagerMap = { mapProfile, fmtDate, duration };
})(typeof window !== "undefined" ? window : globalThis);
