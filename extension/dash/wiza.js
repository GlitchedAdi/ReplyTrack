// Load the Wiza queue from the connected spreadsheet's SCRAP tab.
(() => {
	const BATCH_SIZE = 2000; // WizaTool's default upload limit
	const STORAGE_KEY = "wizaPort";
	const batch = $("wizaBatch");
	const download = $("wizaExport");
	const refreshButton = $("wizaRefresh");
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
	let sheetId;
	let loadError = "";
	let loading = false;
	let revision = 0;
	let dirty = true;

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
		download.disabled = loading || !!job.id || submitting;
		refreshButton.disabled = loading || submitting;
		status.textContent = loading ? "Reading profiles from SCRAP…" : loadError || job.status || (profiles.length ? plural(profiles.length, "unique profile", "unique profiles") + " available in SCRAP." : "Paste LinkedIn profile links under LinkedIn Profile in SCRAP, then run the lookup.");
	}

	async function refresh() {
		dirty = false;
		const current = ++revision;
		loading = true;
		loadError = "";
		renderBatches();
		const result = await send({ type: "WIZA_PROFILES" });
		if (current !== revision) return;
		loading = false;
		if (!result.ok) {
			loadError = result.error || "Could not read profiles from SCRAP.";
			profiles = [];
			counts = {};
			for (const id of ["wizaChecked", "wizaFound", "wizaEmails", "wizaPhones"]) $(id).textContent = "0";
			renderBatches();
			return;
		}
		sheetId = result.sheetId;
		profiles = result.profiles;
		counts = {
			wizaChecked: profiles.filter(profile => profile.contact).length,
			wizaFound: profiles.filter(profile => profile.contact?.email || profile.contact?.phone).length,
			wizaEmails: profiles.filter(profile => profile.contact?.email).length,
			wizaPhones: profiles.filter(profile => profile.contact?.phone).length
		};
		renderBatches();
		return true;
	}

	onRender(() => {
		if (tab === "wiza" && dirty) refresh();
		if (tab !== "wiza") dirty = true;
	});
	if (tab === "wiza") refresh();
	refreshButton.addEventListener("click", refresh);
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.rtWizaJob) {
			const finished = job.id && !changes.rtWizaJob.newValue?.id;
			job = changes.rtWizaJob.newValue || {};
			if (finished && tab === "wiza") refresh();
			else renderBatches();
		}
		if (area === "sync" && (changes.sheetUrl || changes.teamUrl)) {
			dirty = true;
			if (tab === "wiza") refresh();
		}
	});

	async function runLookup(signingIn = false) {
		submitting = true;
		connect.disabled = true;
		renderBatches();
		try {
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

	download.addEventListener("click", async () => {
		if (loading || job.id || submitting || !port.reportValidity()) return;
		const lookupPort = port.valueAsNumber;
		pending = null;
		credentials.hidden = true;
		job = {};
		loadError = "";
		submitting = true;
		renderBatches();
		try {
			const allowed = await chrome.permissions.request({ origins: ["http://127.0.0.1/*"] });
			if (!allowed) throw new Error("Allow local WizaTool access to run the lookup.");
			if (!(await refresh()) || job.id) return;
			const index = Number(batch.value);
			const rows = profiles.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE);
			if (!rows.length) return;
			pending = { port: lookupPort, profiles: rows.map(({ url }) => ({ url })), sheetId };
			await runLookup();
		} catch (error) {
			job = { ...job, status: error.message };
		} finally {
			submitting = false;
			renderBatches();
		}
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
