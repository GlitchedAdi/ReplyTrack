// The member's Google Sheet, through Code.gs (apps-script/Code.gs) — one of two set-ups:
//   team — the team web app (built in through team-config.js). Each request carries the
//          member's Google login and their sheet's id; it runs as them, so it only reaches
//          sheets they can edit. No key.
//   own  — the member's sheet's own script: its web app URL, and the secret key in every request.
// The key and the sheet id travel in the body — never in the URL.
// Reads are answered straight away. Writes go through an outbox kept in storage: if the
// sheet can't be reached they're retried every minute, in order, until they go through.
// Only writes to the SHEET are ever retried — never anything on LinkedIn.
//
// storage.sync  { mode, tabName, sheetUrl, teamUrl, scriptUrl, secretKey, useGoogleLogin }  (S.connection)
// storage.local rtOutbox [ { id, action, data, label, at, tries } ]
//               rtSheetError { at, error, code, account } — the banner
//               rtAccount { email, at } — the Google account the team web app last ran as
//
// Problems with the Google account (team web app) come back with a `code`:
//   signin   — not signed in to Google in this Chrome (Google's sign-in page came back)
//   consent  — the account Google used hasn't approved the web app yet (permission page)
//   sheets   — it approved it, but left "Google Sheets" unticked on Google's screen
//   account  — Google wouldn't open the web app for the account it used
//   noaccess — the account Google used can't open the sheet (or the link is wrong)
//   noedit   — it can open the sheet but not edit it
//   deploy   — the team web app isn't deployed "Execute as: User accessing the web app"
//   nosheet  — no sheet link
const Sheet = (() => {
	const OUTBOX = "rtOutbox";
	const ERROR_KEY = "rtSheetError";
	const ACCOUNT_KEY = "rtAccount";
	const RETRY_ALARM = "rt-outbox";
	const POST_TIMEOUT_MS = 45000;
	// Answers about one row, not about the sheet: the write is dropped (and logged), not retried.
	const ROW_ERRORS = /^(profile not in tab|cell full|admin reply changed|several rows match|bad request|no "[^"]+" column|"[^"]+" (has a formula|is filled by a formula))/i;
	// Code.gs answers (team web app) → code
	const CODES = [
		[/^no sheets permission/i, "sheets"],
		[/^no access to sheet/i, "noaccess"],
		[/^no edit access/i, "noedit"],
		[/^not running as you/i, "deploy"],
		[/^no sheet link/i, "nosheet"],
	];
	const afterHooks = [];

	const raw = () => chrome.storage.sync.get(S.SETTINGS_DEFAULTS);
	const settings = async () => S.connection(await raw());
	const configured = s => S.isReady(s);

	// Google sent a web page instead of Code.gs's answer.
	function pageAnswer(res, text, s) {
		if (s.mode !== "team")
			return {
				ok: false,
				error: 'Apps Script returned a web page instead of an answer. Check the deployment has "Who has access: Anyone", the URL ends in /exec, and the script was saved without errors.',
			};
		// Not signed in: a GET is sent to Google's sign-in page, a POST gets 401.
		if (res.status === 401 || /^https:\/\/accounts\.google\.com\//i.test(String(res.url || ""))) return { ok: false, code: "signin", error: "You're not signed in to Google in this Chrome." };
		if (/unable to open the file/i.test(text)) return { ok: false, code: "account", error: "Google wouldn't open the team web app for the Google account it used." };
		if (/authori[sz]|permission/i.test(text)) return { ok: false, code: "consent", error: "Google needs your OK first — click “Connect Google account” in Settings." };
		return { ok: false, error: "The team web app sent a web page instead of an answer — check its URL in Settings → Advanced." };
	}

	// → the script's JSON answer, or { ok: false, error, code?, transient } (transient = network trouble).
	async function post(body, s) {
		const team = s.mode === "team";
		let lastError = "";
		for (let attempt = 1; attempt <= 2; attempt++) {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
			try {
				const res = await fetch(s.url, {
					method: "POST",
					// text/plain keeps this a "simple" request; Apps Script still gets the JSON.
					headers: { "Content-Type": "text/plain;charset=utf-8" },
					body: JSON.stringify(team ? { ...body, sheet: s.sheetId, tab: s.tabName } : { ...body, key: s.secretKey, tab: s.tabName }),
					redirect: "follow",
					// The team web app runs as you: Google needs your login (cookies) to know who you are.
					credentials: s.googleLogin ? "include" : "omit",
					signal: ctrl.signal,
				});
				const text = (await res.text()).trim();
				if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
				if (text.startsWith("<")) return pageAnswer(res, text, s);
				if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
				try {
					const j = JSON.parse(text);
					if (!j || typeof j !== "object") return { ok: false, error: `unexpected answer: ${text.slice(0, 120)}` };
					if (!j.ok) for (const [re, code] of CODES) if (re.test(String(j.error || ""))) j.code = code;
					return j;
				} catch (e) {
					// The old ReplyTrack script answers in plain text ("ok", "tab not found").
					return { ok: false, error: `unexpected answer "${text.slice(0, 80)}" — is the NEW Code.gs deployed?` };
				}
			} catch (e) {
				lastError = e.name === "AbortError" ? "timed out" : e.message || String(e);
				console.warn("[ReplySync] POST to Apps Script failed (attempt %d): %s", attempt, lastError);
				if (attempt < 2) await sleep(3000);
			} finally {
				clearTimeout(timer);
			}
		}
		return { ok: false, error: `could not reach Apps Script (${lastError})`, transient: true };
	}

	// The Google account the team web app ran as (Settings shows it).
	async function noteAccount(email) {
		if (!email) return;
		const was = await getLocal(ACCOUNT_KEY, null);
		if (!was || was.email !== email) await chrome.storage.local.set({ [ACCOUNT_KEY]: { email, at: Date.now() } });
	}

	// One request with the saved settings. Notes the banner state.
	async function call(action, data = {}) {
		const s = await settings();
		if (!configured(s)) return { ok: false, error: "not set up", setup: true };
		const r = await post({ ...data, action }, s);
		if (r.ok) await noteAccount(r.account);
		if (r.ok || ROW_ERRORS.test(r.error || "")) await chrome.storage.local.remove(ERROR_KEY);
		else await chrome.storage.local.set({ [ERROR_KEY]: { at: Date.now(), error: r.error || "no answer", code: r.code || "", account: r.account || "" } });
		return r;
	}

	const read = () => call("read");

	// Settings test (from the settings page, maybe not saved yet: override = the typed fields).
	async function ping(override = {}) {
		const s = S.connection({ ...(await raw()), ...override });
		if (!configured(s))
			return { ok: false, error: s.mode === "team" ? "Paste your sheet link and enter the tab name first." : "Enter the tab name, the web app URL and the secret key first." };
		const r = await post({ action: "ping" }, s);
		if (r.ok) await noteAccount(r.account);
		return r;
	}

	// ---------------------------------------------------------------------------
	// Outbox
	// ---------------------------------------------------------------------------
	let chain = Promise.resolve();
	const serial = fn => (chain = chain.then(fn, fn));

	// Saved first, then sent. Returns once it's saved (not when it's written).
	async function enqueue(action, data, label = "") {
		await serial(async () => {
			const box = await getLocal(OUTBOX, []);
			box.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, action, data, label, at: Date.now(), tries: 0 });
			await chrome.storage.local.set({ [OUTBOX]: box });
		});
		flush().catch(e => console.warn("[ReplySync] outbox:", e));
	}

	let flushing = null;
	const flush = () => flushing || (flushing = doFlush().finally(() => (flushing = null)));

	async function doFlush() {
		for (;;) {
			const box = await getLocal(OUTBOX, []);
			if (!box.length) {
				await chrome.alarms.clear(RETRY_ALARM);
				return;
			}
			const job = box[0];
			const r = await call(job.action, job.data);
			if (!r.ok && !ROW_ERRORS.test(r.error || "")) {
				// The sheet can't be reached, or the settings are wrong: keep it (in order) and try again.
				await serial(async () => {
					const b = await getLocal(OUTBOX, []);
					const it = b.find(x => x.id === job.id);
					if (it) it.tries = (it.tries || 0) + 1;
					await chrome.storage.local.set({ [OUTBOX]: b });
				});
				if (!job.tries) logFor(job.action)("warn", `Couldn't write to your sheet (${job.label || job.action}): ${r.error} — retrying every minute.`);
				chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 1 });
				return;
			}
			report(job, r);
			await serial(async () => {
				const b = await getLocal(OUTBOX, []);
				await chrome.storage.local.set({ [OUTBOX]: b.filter(x => x.id !== job.id) });
			});
			for (const fn of afterHooks) Promise.resolve().then(() => fn(job, r)).catch(e => console.warn("[ReplySync] after write:", e));
		}
	}

	const logFor = action => (action === "markSent" || action === "markAccepted" ? orLog : rsLog);
	const WHAT = { markSent: "Outreach Status “Sent”", markAccepted: "“Accepted but not replied”", addReplies: "replies", clearAdmin: "Admin Reply and Response / Notes cleared" };

	function report(job, r) {
		const log = logFor(job.action);
		const what = WHAT[job.action] || job.action;
		const label = job.label ? `${job.label}: ` : "";
		if (!r.ok) return log("warn", `${label}not written to the sheet — ${r.error}.`);
		const skipped = (r.skipped || []).map(s => `row ${s.row}: ${s.why}`).join("; ");
		if (job.action === "clearAdmin") return log("info", `${label}row ${r.row} — ${what}${r.notes && r.notes !== "cleared" ? ` (Response / Notes ${r.notes})` : ""}.`);
		if ((r.written || []).length) log("info", `${label}${what} written in row ${r.written.join(", ")}${skipped ? ` · skipped ${skipped}` : ""}.`);
		else if (skipped) log("warn", `${label}nothing written — ${skipped}.`);
	}

	return { settings, configured, call, read, ping, enqueue, flush, RETRY_ALARM, afterWrite: fn => afterHooks.push(fn) };
})();
