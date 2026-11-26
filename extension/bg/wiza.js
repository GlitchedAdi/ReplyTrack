const Wiza = (() => {
	const origins = ["http://127.0.0.1/*"];
	const stateKey = "rtWizaJob";
	let busy = false;

	// WizaTool's launcher takes port 3000, or the next free one up to 3029 when something
	// else (a dev server, say) already has 3000. ReplyTrack finds it there by itself.
	const PORTS = Array.from({ length: 30 }, (_, i) => 3000 + i);
	const PORT_KEY = "wizaPort"; // the port it was last found on (tried first)
	const NOT_RUNNING = "WizaTool isn't running. Start it with its launcher (Start (Windows).bat), wait until its page opens, then click Run Wiza lookup again.";

	async function getJson(url, credentials) {
		try {
			const response = await fetch(url, { credentials, redirect: "error", signal: AbortSignal.timeout(2000) });
			if (!/application\/json/i.test(response.headers.get("content-type") || "")) return null;
			return { status: response.status, data: await response.json() };
		} catch {
			return null;
		}
	}

	// Is WizaTool on this port? Its /api/health says { ok, version }, and /api/auth/me answers
	// with the account (or "signin_required") — other apps on these ports don't.
	async function isWizaTool(port) {
		const base = "http://127.0.0.1:" + port;
		const health = await getJson(base + "/api/health", "omit");
		if (!health || health.data?.ok !== true || typeof health.data.version !== "string") return false;
		const me = await getJson(base + "/api/auth/me", "include");
		return !!me && me.data && typeof me.data === "object" && ("user" in me.data || /^(signin_required|password_change_required)$/.test(me.data.code || ""));
	}

	// → WizaTool's port, or throws NOT_RUNNING.
	async function findPort() {
		if (!(await chrome.permissions.contains({ origins }))) throw new Error("Allow ReplyTrack to connect to WizaTool on this computer first.");
		const { [PORT_KEY]: last } = await chrome.storage.local.get(PORT_KEY);
		if (Number.isInteger(last) && (await isWizaTool(last))) return last;
		const found = await Promise.all(PORTS.map(async port => ((await isWizaTool(port)) ? port : 0)));
		const port = found.find(Boolean);
		if (!port) throw new Error(NOT_RUNNING);
		await chrome.storage.local.set({ [PORT_KEY]: port });
		return port;
	}

	async function call(port, path, body) {
		if (!(await chrome.permissions.contains({ origins }))) throw new Error("Allow ReplyTrack to connect to WizaTool on this computer first.");
		let response;
		try {
			response = await fetch("http://127.0.0.1:" + port + path, {
				method: body === undefined ? "GET" : "POST",
				headers: { "X-Requested-With": "wiza-platform", "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				credentials: "include",
				redirect: "error",
				signal: AbortSignal.timeout(15000)
			});
		} catch {
			const error = new Error(NOT_RUNNING);
			error.lost = true;
			throw error;
		}
		// WizaTool always answers its API in JSON: anything else means it isn't on this port (any more).
		const isJson = /application\/json/i.test(response.headers.get("content-type") || "");
		const data = isJson ? await response.json().catch(() => null) : null;
		if (!data) {
			const error = new Error(NOT_RUNNING);
			error.lost = true;
			throw error;
		}
		if (!response.ok) {
			const error = new Error(data?.error || "WizaTool request failed (" + response.status + ").");
			error.status = response.status;
			throw error;
		}
		return data;
	}

	async function connect({ email, password }) {
		try {
			const port = await findPort();
			if (email && password) await call(port, "/api/auth/login", { email, password });
			const { user } = await call(port, "/api/auth/me");
			if (!user) throw new Error("The local service did not return a WizaTool account.");
			return { ok: true, email: user.email };
		} catch (error) {
			return { ok: false, needsLogin: error.status === 401, error: error.message };
		}
	}

	const sheetResultKey = (sheet, url) => "wiza-sheet:" + sheet.sheetId + ":" + url;

	async function listProfiles() {
		const sheet = await Sheet.settings();
		if (!Sheet.configured(sheet)) return { ok: false, error: "Connect your Google Sheet in ReplyTrack Settings first." };
		const result = await Sheet.call("readWizaProfiles", {}, sheet);
		if (!result.ok) return { ok: false, error: result.error === "bad request" ? "Deploy the updated Apps Script to load profiles from SCRAP." : result.error };
		const keys = result.urls.map(url => sheetResultKey(sheet, url));
		const saved = keys.length ? await chrome.storage.local.get(keys) : {};
		return { ok: true, sheetId: sheet.sheetId, profiles: result.urls.map((url, i) => ({ url, contact: saved[keys[i]] || null })) };
	}

	async function start({ profiles, sheetId }) {
		if (busy) throw new Error("A Wiza request is already in progress.");
		busy = true;
		try {
			if (!(await chrome.permissions.contains({ origins }))) throw new Error("Allow access to the local WizaTool app first.");
			const sheet = await Sheet.settings();
			if (!Sheet.configured(sheet)) throw new Error("Connect your sheet in ReplyTrack Settings first.");
			if (sheet.sheetId !== sheetId) throw new Error("The connected spreadsheet changed. Refresh the Wiza profile list.");
			if (!profiles?.length || profiles.length > 2000) throw new Error("Invalid Wiza lookup batch.");
			const port = await findPort();
			const state = await getLocal(stateKey, {});
			if (state.id) throw new Error("A Wiza lookup is already queued.");
			const urls = profiles.map(p => p.url);
			if (urls.some(url => typeof url !== "string" || !/^https:\/\/www\.linkedin\.com\/in\/[\w.%\-]+\/$/.test(url))) throw new Error("Invalid LinkedIn profile URL.");
			const current = await Sheet.call("readWizaProfiles", {}, sheet);
			if (!current.ok) throw new Error(current.error);
			const available = new Set(current.urls);
			if (new Set(urls).size !== urls.length || urls.some(url => !available.has(url))) throw new Error("The SCRAP profile list changed. Refresh it before running the lookup.");
			const preview = await call(port, "/api/uploads", { text: urls.join("\n") });
			if (!preview.uploadId || preview.validRows !== urls.length) throw new Error("WizaTool could not validate the entire batch.");
			const { jobId } = await call(port, "/api/uploads/" + encodeURIComponent(preview.uploadId) + "/confirm", { column: preview.column, name: "ReplyTrack contact lookup" });
			if (!Number.isInteger(jobId)) throw new Error("Check WizaTool Jobs before retrying. The job ID could not be confirmed.");
			await chrome.storage.local.set({ [stateKey]: { id: jobId, port, profiles, sheet, status: "Wiza lookup queued." } });
			await ensureAlarm();
			return { ok: true };
		} finally {
			busy = false;
		}
	}

	async function poll() {
		if (busy) return;
		busy = true;
		try {
			const state = await getLocal(stateKey, {});
			if (!state.id) return;
			try {
				let response;
				try {
					response = await call(state.port, "/api/jobs/" + state.id);
				} catch (error) {
					// WizaTool restarted on another port: find it again (the job is kept in its database).
					if (!error.lost) throw error;
					state.port = await findPort();
					await chrome.storage.local.set({ [stateKey]: state });
					response = await call(state.port, "/api/jobs/" + state.id);
				}
				const { job, rows } = response;
				if (!["done", "cancelled"].includes(job.status)) {
					const completed = rows.filter(row => !["pending", "in_progress"].includes(row.status)).length;
					const status = "Wiza lookup " + job.status + " · " + completed + " of " + rows.length + " checked.";
					if (status !== state.status) await chrome.storage.local.set({ [stateKey]: { ...state, status } });
					return;
				}
				const keysByUrl = new Map(state.profiles.map(p => [p.url, p.keys]));
				const seen = new Set();
				const duplicates = new Set();
				for (const row of rows) {
					if (seen.has(row.url)) duplicates.add(row.url);
					seen.add(row.url);
				}
				const updates = {};
				let held = 0;
				for (const row of rows) {
					if (!keysByUrl.has(row.url)) continue;
					if (duplicates.has(row.url) || (row.status !== "no_data" && (row.status !== "found" || row.note !== "ReplyTrack profile verified"))) {
						held++;
						continue;
					}
					const email = [...new Set([...row.work, ...row.personal])].join("; ");
					const phone = [...new Set(row.phones)].join("; ");
					const workEmail = [...new Set(row.work)].join("; ");
					const personalEmail = [...new Set(row.personal)].join("; ");
					const contact = { url: row.url, email, phone, workEmail, personalEmail };
					if (state.sheet) updates[sheetResultKey(state.sheet, row.url)] = contact;
					else for (const key of keysByUrl.get(row.url)) updates["wiza:" + key] = contact;
				}
				const previous = await chrome.storage.local.get(Object.keys(updates));
				for (const [key, contact] of Object.entries(updates)) {
					for (const field of ["email", "phone", "workEmail", "personalEmail"]) {
						const verifiedPrevious = previous[key]?.url === contact.url ? previous[key][field] : "";
						contact[field] = [...new Set([verifiedPrevious, contact[field]].flatMap(value => String(value || "").split("; ")).filter(Boolean))].join("; ");
					}
				}
				const contacts = Object.values(updates).filter(contact => contact.email || contact.phone);
				let summary = "Contacts for " + contacts.length + " leads queued for SCRAP sync.";
				if (state.sheet) {
					let { written = 0, unmatched = 0 } = state;
					for (let offset = state.syncOffset || 0; offset < contacts.length; offset += 50) {
						const result = await Sheet.call("writeWizaContacts", { contacts: contacts.slice(offset, offset + 50) }, state.sheet);
						if (!result.ok) throw new Error("Wiza contacts are ready. SCRAP sync will retry: " + result.error);
						written += result.written;
						unmatched += result.held;
						Object.assign(state, { written, unmatched, syncOffset: offset + 50, status: "Syncing verified contacts to SCRAP · " + (written + unmatched) + " of " + contacts.length + " processed." });
						await chrome.storage.local.set({ [stateKey]: state });
					}
					summary = "Contacts synced to " + written + " SCRAP rows." + (unmatched ? " " + unmatched + " profiles no longer match a unique row." : "");
				}
				await chrome.storage.local.set(updates);
				if (!state.sheet) await ScrapeSync.flush();
				await chrome.storage.local.set({ [stateKey]: { status: "Wiza lookup " + job.status + ". " + summary + (held ? " " + held + " results held for review in WizaTool." : "") } });
			} catch (error) {
				const status = error.message;
				if (status !== state.status) await chrome.storage.local.set({ [stateKey]: { ...state, status } });
			}
		} finally {
			busy = false;
		}
	}

	const ALARM = "rt-wiza";
	async function ensureAlarm() {
		if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
	}
	chrome.alarms.onAlarm.addListener(alarm => {
		if (alarm.name === ALARM) poll().catch(error => console.warn("[Wiza]", error.message));
	});
	ensureAlarm().catch(error => console.warn("[Wiza]", error.message));
	return { start, connect, listProfiles };
})();
