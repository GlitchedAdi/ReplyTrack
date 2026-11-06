// Export column layouts, shared by the popup (Export CSV) and the bulk page
// (Deep Run from a CSV → your file + these columns). Pure functions.
(function (root) {
	// Set to true to append each role's / item's description text in the full-profile CSV.
	const CSV_INCLUDE_DESCRIPTIONS = false;

	const J = (parts, sep = " | ") => parts.filter(p => p && String(p).trim()).join(sep);
	const withDesc = (s, d) => (CSV_INCLUDE_DESCRIPTIONS && d ? `${s} — ${d.replace(/\s*\n\s*/g, " ")}` : s);
	const list = (arr, f) => (Array.isArray(arr) ? arr.map(f).filter(Boolean).join("\n") : "");
	const count = (l, k) => (l.enrichStatus === "done" ? (l[k] || []).length : "");

	const FMT = {
		experience: e =>
			withDesc(
				J([
					J([e.title, e.company && `@ ${e.company}`, e.employmentType && `(${e.employmentType})`], " "),
					J([e.dates, e.duration && `(${e.duration})`], " "),
					J([e.location, e.workplaceType], " · "),
				]),
				e.description
			),
		education: e => withDesc(J([e.school, e.degree, e.dates, e.grade && `Grade: ${e.grade}`]), e.description),
		publications: p => withDesc(J([p.title, p.publisher, p.date]), p.description),
		certifications: c =>
			J([c.name, c.issuer, c.issued && `Issued ${c.issued}`, c.expires && `Expires ${c.expires}`, c.credentialId && `ID ${c.credentialId}`]),
		honors: h => withDesc(J([h.title, h.issuer, h.date, h.associatedWith && `Associated with ${h.associatedWith}`]), h.description),
		testScores: t => withDesc(J([t.name, t.score && `Score: ${t.score}`, t.date]), t.description),
		organizations: o => withDesc(J([o.name, o.position, o.dates]), o.description),
		volunteering: v =>
			withDesc(J([J([v.role, v.organization && `@ ${v.organization}`], " "), J([v.dates, v.duration && `(${v.duration})`], " "), v.cause]), v.description),
	};

	// --- PhantomBuster "Sales Navigator Search Export" layout ---
	const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
	// PhantomBuster writes "<years> <months>", leaving an empty part in place:
	// " 2 months in role" (observed). Years-only would give "5 years  in role".
	function tenure(t) {
		if (!t) return "";
		const y = t.numYears || 0;
		const m = t.numMonths || 0;
		if (!y && !m) return "";
		return `${y ? plural(y, "year") : ""} ${m ? plural(m, "month") : ""}`;
	}
	const ymd = d => (d && d.year ? (d.month ? `${MON[d.month - 1]} ${d.year}` : String(d.year)) : "");
	function spanDuration(s, e) {
		if (!s || !s.year) return "";
		const end = e && e.year ? e : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
		const months = (end.year - s.year) * 12 + ((end.month || 12) - (s.month || 1)) + 1;
		return months > 0 ? tenure({ numYears: Math.floor(months / 12), numMonths: months % 12 }) : "";
	}
	const idFromUrn = u => (String(u || "").match(/(\d+)\)?$/) || [])[1] || "";
	const DEGREE = { 1: "1st", 2: "2nd", 3: "3rd" };
	const split = n => {
		const p = String(n || "").trim().split(/\s+/);
		return [p[0] || "", p.slice(1).join(" ")];
	};
	// linkedInProfileUrl: the id form, with trailing slash (as PhantomBuster writes it)
	const inUrl = l => (l.memberId && !l.idIsVanity ? `https://www.linkedin.com/in/${l.memberId}/` : "");
	// defaultProfileUrl: the public /in/<vanity> URL, no "www", no trailing slash.
	function vanityUrl(l) {
		const slug = [l.vanityUrl, l.publicProfileUrl]
			.map(u => (String(u || "").match(/linkedin\.com\/in\/([^/?#]+)/) || [])[1])
			.find(s => s && !/^AC[wo]/.test(s));
		return slug ? `https://linkedin.com/in/${slug}` : l.memberId ? `https://linkedin.com/in/${l.memberId}` : "";
	}

	const PB_COLUMNS = [
		["error", l => (l.pastStatus === "failed" ? l.pastError || "" : "")],
		["query", l => l.query || ""],
		["timestamp", l => l.scrapedAt || ""],
		["searchAccountProfileId", (l, a) => a.id || ""],
		["profileUrl", l => l.salesNavProfileUrl],
		["fullName", l => l.name],
		["firstName", l => l.firstName || split(l.name)[0]],
		["lastName", l => l.lastName || split(l.name)[1]],
		["companyName", l => l.company],
		["title", l => l.title],
		["companyId", l => l.companyId || ""],
		["companyUrl", l => (l.companyId ? `https://www.linkedin.com/sales/company/${l.companyId}` : "")],
		["regularCompanyUrl", l => (l.companyId ? `https://www.linkedin.com/company/${l.companyId}` : "")],
		["summary", l => l.summary || ""],
		["titleDescription", l => l.titleDescription || ""],
		["industry", l => l.companyIndustry || ""],
		["companyLocation", l => l.companyLocation || ""],
		["location", l => l.location],
		["durationInRole", l => (tenure(l.tenureRole) ? `${tenure(l.tenureRole)} in role` : "")],
		["durationInCompany", l => (tenure(l.tenureCompany) ? `${tenure(l.tenureCompany)} in company` : "")],
		["pastExperienceCompanyName", l => (l.pastPosition && l.pastPosition.companyName) || ""],
		["pastExperienceCompanyUrl", l => (l.pastPosition && idFromUrn(l.pastPosition.companyUrn) ? `https://www.linkedin.com/company/${idFromUrn(l.pastPosition.companyUrn)}` : "")],
		["pastExperienceCompanyTitle", l => (l.pastPosition && l.pastPosition.title) || ""],
		["pastExperienceDate", l => (l.pastPosition ? J([ymd(l.pastPosition.startedOn), ymd(l.pastPosition.endedOn)], " - ") : "")],
		["pastExperienceDuration", l => (l.pastPosition ? spanDuration(l.pastPosition.startedOn, l.pastPosition.endedOn) : "")],
		["connectionDegree", l => (l.degree == null ? "" : DEGREE[l.degree] || "Out of network")],
		["profileImageUrl", l => l.profileImageUrl || ""],
		["sharedConnectionsCount", l => l.sharedConnections || 0],
		["name", l => l.name],
		["vmid", l => (l.idIsVanity ? "" : l.memberId)],
		["linkedInProfileUrl", l => inUrl(l)],
		["isPremium", l => (l.premium == null ? "" : String(!!l.premium))],
		["defaultProfileUrl", l => vanityUrl(l)],
		["searchAccountProfileName", (l, a) => a.name || ""],
	];

	// --- Quick Run and Deep Run (v5.11: camelCase names, as in Standard Run) ---
	// Where a column holds the same value as a Standard Run column, it has the same name.
	const pb = name => PB_COLUMNS.find(c => c[0] === name)[1];
	const idUrl = l => inUrl(l) || (l.idIsVanity ? l.publicProfileUrl : ""); // CSV leads known only by their vanity URL
	const BASIC_COLUMNS = [
		["fullName", l => l.name],
		["title", l => l.title],
		["companyName", l => l.company],
		["location", l => l.location],
		["linkedInProfileUrl", idUrl],
		["profileUrl", l => l.salesNavProfileUrl],
		["vmid", l => (l.idIsVanity ? "" : l.memberId)],
		["source", l => l.source],
	];

	// Deep Run = Quick Run's columns, the Standard Run columns Deep Run didn't have
	// (search-card data from step 1, or derived from the profile it already fetches —
	// no extra request), then the full-profile columns.
	const csvLead = l => l.source === "csv"; // no search card: counts LinkedIn only shows there stay empty
	const FULL_COLUMNS = [
		...BASIC_COLUMNS,
		["defaultProfileUrl", pb("defaultProfileUrl")],
		["firstName", pb("firstName")],
		["lastName", pb("lastName")],
		["companyId", pb("companyId")],
		["companyUrl", pb("companyUrl")],
		["regularCompanyUrl", pb("regularCompanyUrl")],
		["industry", pb("industry")],
		["companyLocation", pb("companyLocation")],
		["titleDescription", pb("titleDescription")],
		["durationInRole", pb("durationInRole")],
		["durationInCompany", pb("durationInCompany")],
		["pastExperienceCompanyName", pb("pastExperienceCompanyName")],
		["pastExperienceCompanyUrl", pb("pastExperienceCompanyUrl")],
		["pastExperienceCompanyTitle", pb("pastExperienceCompanyTitle")],
		["pastExperienceDate", pb("pastExperienceDate")],
		["pastExperienceDuration", pb("pastExperienceDuration")],
		["connectionDegree", pb("connectionDegree")],
		["profileImageUrl", pb("profileImageUrl")],
		["sharedConnectionsCount", l => (csvLead(l) && l.sharedConnections == null ? "" : l.sharedConnections || 0)],
		["isPremium", pb("isPremium")],
		["about", l => l.about],
		["email", l => l.email],
		["phone", l => l.phone],
		["contactSource", l => l.contactSources || ""],
		["websites", l => l.websites],
		["otherContactInfo", l => l.otherContact],
		["experienceCount", l => count(l, "experience")],
		["experience", l => list(l.experience, FMT.experience)],
		["education", l => list(l.education, FMT.education)],
		["publicationsCount", l => count(l, "publications")],
		["publications", l => list(l.publications, FMT.publications)],
		["certifications", l => list(l.certifications, FMT.certifications)],
		["honorsAndAwards", l => list(l.honors, FMT.honors)],
		["testScores", l => list(l.testScores, FMT.testScores)],
		["organizations", l => list(l.organizations, FMT.organizations)],
		["volunteerExperience", l => list(l.volunteering, FMT.volunteering)],
		["query", pb("query")],
		["timestamp", pb("timestamp")],
		["profileScrapeStatus", l => l.enrichStatus || ""],
		["profileNotes", l => l.profileNotes || l.enrichError || ""],
	];

	// PhantomBuster-style cell: quoted only when needed, value untouched.
	function pbCell(v) {
		const s = String(v == null ? "" : v);
		return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	}

	function csvCell(v) {
		let s = String(v == null ? "" : v).slice(0, 32000); // Excel's per-cell limit is 32,767
		if (/^[=+\-@]/.test(s)) s = " " + s; // stop Excel treating "- Led team…" as a formula
		return `"${s.replace(/"/g, '""')}"`;
	}

	root.SNExport = { BASIC_COLUMNS, FULL_COLUMNS, PB_COLUMNS, FMT, pbCell, csvCell };
})(globalThis);
