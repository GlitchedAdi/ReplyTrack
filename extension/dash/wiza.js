// Prepare WizaTool uploads from the scraper's saved leads and profile details.
(() => {
	const BATCH_SIZE = 2000; // WizaTool's default upload limit
	const STORAGE_KEY = "wizaPort";
	const MEMBER_ID = /^A(?:Co|Cw|EM)[A-Za-z0-9_-]{20,}$/;
	const batch = $("wizaBatch");
	const download = $("wizaExport");
	const status = $("wizaStatus");
	const port = $("wizaPort");
	const connect = $("wizaConnect");
	const credentials = $("wizaOpenForm");
	const email = $("wizaEmail");
	const password = $("wizaPassword");
	let profiles = [];
	let job = {};
	let submitting = false;
	let pending;
	let counts = {};
	let refreshTimer;
	let revision = 0;
	let dirty = true;

	function profileSlug(value) {
		try {
			const url = new URL(value);
			if (!/^https?:$/.test(url.protocol) || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return "";
			const match = /^\/in\/([^/]+)\/?$/i.exec(url.pathname);
			return match ? decodeURIComponent(match[1]) : "";
		} catch {
			return "";
		}
	}

	function profileUrl(lead) {
		const slugs = [lead.vanityUrl, lead.publicProfileUrl, lead.defaultProfileUrl].map(profileSlug);
		slugs.push(lead.memberId || "");
		const valid = slugs.filter(value => /^[\p{L}\p{N}_.-]+$/u.test(value) && value !== "." && value !== "..");
		const slug = valid.find(value => !MEMBER_ID.test(value)) || valid[0];
		if (!slug) return "";
		// LinkedIn's opaque member IDs are case-sensitive. Public profile slugs aren't.
		const normalized = MEMBER_ID.test(slug) ? slug : slug.toLowerCase();
		return `https://www.linkedin.com/in/${encodeURIComponent(normalized)}/`;
	}

	function renderBatches() {
		for (const [id, count] of Object.entries({ wizaEligible: profiles.length, ...counts })) $(id).textContent = count.toLocaleString();
		const selected = Number(batch.value);
		const count = Math.ceil(profiles.length / BATCH_SIZE);
		batch.replaceChildren();
		for (let i = 0; i < count; ++i) {
			const option = document.createElement("option");
			option.value = i;
			const first = i * BATCH_SIZE + 1;
			const last = Math.min((i + 1) * BATCH_SIZE, profiles.length);
			option.textContent = `${first.toLocaleString()}–${last.toLocaleString()}`;
			batch.append(option);
		}
		if (count) batch.value = Math.min(selected, count - 1);
		batch.hidden = $("wizaBatchLabel").hidden = count < 2;
		download.disabled = !profiles.length || !!job.id || submitting;
		status.textContent = job.status || (profiles.length ? `${plural(profiles.length, "unique profile", "unique profiles")} available.` : "No LinkedIn profile URLs are available from captured leads yet.");
	}

	async function refresh() {
		dirty = false;
		const current = ++revision;
		try {
			const { scrapedLeads = [] } = await chrome.storage.local.get("scrapedLeads");
			const keys = scrapedLeads.map(lead => "p:" + (lead.memberId || `${lead.name}|${lead.company}`).toLowerCase());
			const resultKeys = keys.map(key => "wiza:" + key.slice(2));
			const details = keys.length ? await chrome.storage.local.get([...new Set([...keys, ...resultKeys])]) : {};
			if (current !== revision) return;
			const byUrl = new Map();
			scrapedLeads.forEach((lead, i) => {
				const url = profileUrl({ ...lead, ...details[keys[i]] });
				if (!url) return;
				if (!byUrl.has(url)) byUrl.set(url, []);
				byUrl.get(url).push(keys[i].slice(2));
			});
			profiles = Array.from(byUrl, ([url, keys]) => ({ url, keys }));
			counts = { wizaChecked: 0, wizaFound: 0, wizaEmails: 0, wizaPhones: 0 };
			for (const profile of profiles) {
				const results = profile.keys.map(key => details["wiza:" + key]).filter(Boolean);
				const hasEmail = results.some(result => result.email);
				const hasPhone = results.some(result => result.phone);
				counts.wizaChecked += Number(results.length > 0);
				counts.wizaFound += Number(hasEmail || hasPhone);
				counts.wizaEmails += Number(hasEmail);
				counts.wizaPhones += Number(hasPhone);
			}
			renderBatches();
		} catch {
			if (current !== revision) return;
			download.disabled = true;
			status.textContent = "Could not read captured leads. Reopen the dashboard to try again.";
		}
	}

	onRender(() => {
		if (tab === "wiza" && dirty) refresh();
	});
	if (tab === "wiza") refresh();
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.rtWizaJob) {
			job = changes.rtWizaJob.newValue || {};
			renderBatches();
		}
		if (area !== "local" || !(changes.scrapedLeads || Object.keys(changes).some(key => key.startsWith("p:") || key.startsWith("wiza:")))) return;
		++revision;
		dirty = true;
		download.disabled = true;
		clearTimeout(refreshTimer);
		if (tab === "wiza") refreshTimer = setTimeout(() => { if (dirty) refresh(); }, 150);
	});

	async function runLookup(signingIn = false) {
		submitting = true;
		connect.disabled = true;
		renderBatches();
		try {
			const allowed = await chrome.permissions.request({ origins: ["http://127.0.0.1/*"] });
			if (!allowed) throw new Error("Allow local WizaTool access to run the lookup.");
			const connection = await send({
				type: "WIZA_CONNECT", port: pending.port,
				...(signingIn ? { email: email.value, password: password.value } : {})
			});
			credentials.hidden = !connection.needsLogin;
			if (!connection.ok) {
				if (connection.needsLogin) (signingIn ? password : email).focus();
				throw new Error(connection.needsLogin && !signingIn ? "Sign in to WizaTool to run the selected lookup." : connection.error);
			}
			const result = await send({ type: "WIZA_START", ...pending });
			if (!result.ok) throw new Error(result.error);
			pending = null;
		} catch (error) {
			job = { ...job, status: error.message };
		} finally {
			password.value = "";
			connect.disabled = false;
			submitting = false;
			renderBatches();
		}
	}

	download.addEventListener("click", () => {
		const index = Number(batch.value);
		const rows = profiles.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE);
		if (!rows.length || job.id || submitting || !port.validity.valid) return;
		if (!confirm("Run Wiza contact lookups for " + plural(rows.length, "profile", "profiles") + " and save the results to SCRAP?")) return;
		pending = { port: port.valueAsNumber, profiles: rows };
		runLookup();
	});

	chrome.storage.local.get([STORAGE_KEY, "rtWizaJob"]).then(saved => {
		job = saved.rtWizaJob || {};
		renderBatches();
		if (saved[STORAGE_KEY] && port.value === port.defaultValue) port.value = saved[STORAGE_KEY];
	}).catch(() => {});
	credentials.addEventListener("submit", event => {
		event.preventDefault();
		if (pending && !submitting && !job.id) runLookup(true);
	});
})();
