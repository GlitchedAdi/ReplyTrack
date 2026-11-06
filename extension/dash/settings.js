// Settings: Connection (storage.sync), Outreach — the note and the pace (storage.local
// "orSettings", saved as you type) — and Data (reset sync history, import sent history).
//
// Connection, two set-ups (S.connection):
//   team — the team web app (built in: team-config.js; changeable under Advanced) + your
//          sheet link. "Connect Google account" opens the web app once for Google's
//          permission screen.
//   own  — Advanced → "Use my sheet's own script": its web app URL + secret key.

function show(el, text, kind) {
	$(el).textContent = text;
	$(el).className = `msg ${kind || ""}`;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
const TEAM = S.teamConfig();
const cleanUrl = u =>
	String(u || "")
		.trim()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
const builtInUrl = () => cleanUrl(TEAM.webAppUrl);
// The Team web app URL to store: "" = the built-in one (so a new built-in URL reaches you).
const teamUrlToStore = u => (cleanUrl(u) === builtInUrl() ? "" : cleanUrl(u));

function readConnection() {
	return {
		mode: $("ownMode").checked ? "own" : "team",
		tabName: $("tabName").value.trim(),
		sheetUrl: $("sheetUrl").value.trim(),
		teamUrl: teamUrlToStore($("teamUrl").value),
		scriptUrl: cleanUrl($("scriptUrl").value),
		secretKey: $("secretKey").value.trim(),
		useGoogleLogin: $("useGoogleLogin").checked,
	};
}

// What's saved, in the same shape (a saved set-up from before 2.2 counts as "own").
function savedConnection() {
	return {
		mode: S.modeOf(cfg),
		tabName: String(cfg.tabName || "").trim() || S.DEFAULT_TAB,
		sheetUrl: String(cfg.sheetUrl || "").trim(),
		teamUrl: teamUrlToStore(cfg.teamUrl),
		scriptUrl: cleanUrl(cfg.scriptUrl),
		secretKey: String(cfg.secretKey || "").trim(),
		useGoogleLogin: !!cfg.useGoogleLogin,
	};
}

function validate(s) {
	if (!s.tabName) return "Enter your tab name.";
	if (s.mode === "team") {
		if (!s.sheetUrl) return "Paste your sheet link.";
		if (!S.sheetIdOf(s.sheetUrl)) return "That doesn't look like a Google Sheets link. Open your sheet and copy the address — it starts with https://docs.google.com/spreadsheets/d/";
		const url = s.teamUrl || builtInUrl();
		if (!url) return "The team web app URL isn't set. Enter it under Advanced — your team lead has it.";
		if (/\/dev$/.test(url)) return "The team web app URL (Advanced) is a test (/dev) URL. Use the one that ends in /exec.";
		if (!S.WEB_APP_RE.test(url)) return "The team web app URL (Advanced) doesn't look right. It should start with https://script.google.com/ and end with /exec.";
		return "";
	}
	if (!s.scriptUrl) return "Enter your script's web app URL (Advanced).";
	if (/\/dev$/.test(s.scriptUrl)) return "That's a test (/dev) URL. Use the deployment URL that ends in /exec.";
	if (!S.WEB_APP_RE.test(s.scriptUrl)) return "That doesn't look like an Apps Script web app URL. It should start with https://script.google.com/ and end with /exec.";
	if (!s.secretKey) return "Enter the secret key (the same as SECRET_KEY in your Code.gs).";
	return "";
}

// Several Google accounts in one Chrome: Google runs the web app as the first one.
function manyAccounts(account) {
	return [
		`Chrome is probably signed in to more than one Google account, and Google uses the first one you signed in with${account ? ` (${account})` : ""}. To fix it, do one of these:`,
		"  • Sign out of all Google accounts (your picture at the top right of google.com → Sign out of all accounts). Sign in first with the account that has your sheet, then add the others back.",
		"  • Use a Chrome profile with only that Google account — with LinkedIn and ReplyTrack in it too.",
		account ? `  • Share your sheet with ${account} as an Editor, if that's your account too.` : "",
		"Then click “Connect Google account” and Test connection again.",
	]
		.filter(Boolean)
		.join("\n");
}

// A failed test (or the last failed request, for the banner) in plain words.
function problemText(r, settings) {
	const e = String(r.error || "");
	const a = r.account || "";
	switch (r.code) {
		case "signin":
			return "You're not signed in to Google in this Chrome. Sign in with the account that has your sheet (for example at sheets.google.com), then click “Connect Google account”.";
		case "consent":
			return st.rtConnectAt
				? `Google says the account it used hasn't approved ReplyTrack — but you already clicked “Connect Google account”. So Google is using a different account from the one you approved.\n\n${manyAccounts("")}`
				: "Google needs your OK first. Click “Connect Google account”, approve ReplyTrack with the account that has your sheet, then Test connection again.";
		case "sheets":
			return `ReplyTrack is approved for ${a || "your Google account"}, but not for your Google Sheets: on Google's screen, the box next to “See, edit, create, and delete all your Google Sheets spreadsheets” wasn't ticked.\n\nClick “Connect Google account” — the page that opens has a “Give permission” button. Tick that box, click Continue, then Test connection again.`;
		case "account":
			return `Google wouldn't open the team web app for the account it used.\n\n${manyAccounts(a)}`;
		case "noaccess":
			return `Google used the account ${a || "(unknown)"}, and it can't open this sheet. Check your sheet link first. If the link is right, ${a || "that"} isn't the account that has your sheet.\n\n${manyAccounts(a)}`;
		case "noedit":
			return `${a || "The Google account ReplyTrack uses"} can open your sheet but not edit it. Share the sheet with ${a || "it"} as an Editor — or, if your sheet is in another account:\n\n${manyAccounts(a)}`;
		case "deploy":
			return "The team web app isn't deployed the right way — it has to run as you (“Execute as: User accessing the web app”). Please tell your team lead.";
		case "nosheet":
			return "Paste your sheet link first.";
	}
	if (e === "tab not found") return `Your sheet has no tab called “${settings.tabName}”. Check the spelling (spaces count).`;
	if (e === "wrong key") return "The secret key doesn't match SECRET_KEY in your Code.gs.";
	if (/SECRET_KEY/.test(e)) return `Your Code.gs isn't ready: ${e}. Set it, save, and deploy a new version.`;
	if (/^missing column: /.test(e)) return `Row 1 of “${settings.tabName}” has no “${e.slice(16)}” column. It's needed — add it exactly as written.`;
	return `Problem: ${e}`;
}

async function testConnection(settings) {
	show("msg", "Testing…");
	const r = (await send({ type: "testConnection", settings })) || { ok: false, error: "no answer" };
	if (!r.ok) {
		show("msg", problemText(r, settings), "bad");
		return false;
	}
	const values = r.statusValues || [];
	const fresh = Array.isArray(r.missing); // Code.gs from 2.2 on (older ones need every column)
	const lines = [`Connected${r.account ? ` as ${r.account}` : ""}. Found the tab “${r.tab}” — ${fresh ? `${plural(r.rows, "row")} with a LinkedIn Profile` : `${plural(r.rows, "row")}, all the columns`}.`];
	lines.push(values.length ? `Outreach Status choices: ${values.join(" | ")}` : "⚠ No Outreach Status dropdown found — the status can't be updated.");
	for (const v of ["Sent", "Replied"]) if (values.length && !values.some(x => S.norm(x) === S.norm(v))) lines.push(`⚠ “${v}” isn't in the dropdown, so it's never written.`);
	for (const p of r.problems || []) lines.push(`⚠ ${p}`);
	for (const name of r.missing || []) {
		const o = S.OPTIONAL.find(x => S.norm(S.COLUMNS[x.key]) === S.norm(name));
		lines.push(`ℹ ${o ? S.missingText({ ...o, name }) : `No ${name} column.`}`);
	}
	lines.push(`Dates and reply times use the time zone ${r.timeZone}.`);
	show("msg", lines.join("\n"), lines.some(l => l.startsWith("⚠")) ? "bad" : "ok");
	return true;
}

$("showKey").addEventListener("click", () => {
	const hidden = $("secretKey").type === "password";
	$("secretKey").type = hidden ? "text" : "password";
	$("showKey").textContent = hidden ? "Hide" : "Show";
});

// Only the fields of the chosen set-up show.
function applyMode() {
	const own = $("ownMode").checked;
	$("connCard").classList.toggle("own", own);
	$("connIntro").textContent = own ? "Your sheet's own script — Code.gs inside your sheet, deployed by you." : "Your Google Sheet — your copy of the team template.";
}

// The template link (team-config.js) — only a docs.google.com link is shown.
if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(String(TEAM.templateCopyUrl || ""))) {
	$("templateLink").href = TEAM.templateCopyUrl;
	$("templateHint").classList.remove("hidden");
}

// "Connect Google account": the team web app in a new tab — Google's permission screen the
// first time, then "You're connected".
$("connect").addEventListener("click", async () => {
	const url = cleanUrl($("teamUrl").value) || builtInUrl();
	if (!S.WEB_APP_RE.test(url)) return show("msg", "The team web app URL is missing or wrong — check it under Advanced, or ask your team lead.", "bad");
	await chrome.storage.local.set({ rtConnectAt: Date.now() });
	chrome.tabs.create({ url });
	show(
		"msg",
		"A Google tab opened. If Google asks, choose the account that has your sheet and approve ReplyTrack (“Google hasn't verified this app” is expected: Advanced → Go to … (unsafe) → Allow). Then come back here and click Save.",
		""
	);
});

$("teamUrlReset").addEventListener("click", () => {
	$("teamUrl").value = builtInUrl();
	barProblem = "";
	renderSaveBar();
});

// Save (in the card, or in the "unsaved changes" bar): check, store, test, tell the service worker.
let saving = false;
async function saveConnection() {
	if (saving) return;
	const s = readConnection();
	const problem = validate(s);
	if (problem) {
		barProblem = problem;
		renderSaveBar();
		return show("msg", problem, "bad");
	}
	saving = true;
	$("save").disabled = $("saveBarSave").disabled = true;
	try {
		await chrome.storage.sync.set(s);
		cfg = { ...cfg, ...s }; // the bar goes now; storage.onChanged follows
		$("scriptUrl").value = s.scriptUrl;
		renderSaveBar();
		const ok = await testConnection(s);
		await send({ type: "settingsSaved" });
		if (ok) $("msg").textContent += "\n\nSaved. A pinned LinkedIn messaging tab now syncs replies every 20 minutes.";
	} catch (e) {
		show("msg", `Could not save: ${e.message || e}`, "bad");
	} finally {
		saving = false;
		$("save").disabled = $("saveBarSave").disabled = false;
	}
}
$("save").addEventListener("click", saveConnection);

// "You have unsaved changes": the Connection fields differ from what's saved. (The Outreach
// settings save as you type, so they're never unsaved.)
let barProblem = "";
const CONNECTION_FIELDS = ["tabName", "sheetUrl", "teamUrl", "scriptUrl", "secretKey"];
function connectionDirty() {
	const now = readConnection();
	const saved = savedConnection();
	return Object.keys(saved).some(k => now[k] !== saved[k]);
}
function renderSaveBar() {
	const dirty = connectionDirty();
	if (!dirty) barProblem = "";
	$("saveBar").classList.toggle("hidden", !dirty);
	$("saveBar").classList.toggle("bad", !!barProblem);
	$("saveBarText").textContent = barProblem || "You have unsaved changes";
}
for (const id of CONNECTION_FIELDS)
	$(id).addEventListener("input", () => {
		barProblem = "";
		renderSaveBar();
	});
for (const id of ["useGoogleLogin", "ownMode"])
	$(id).addEventListener("change", () => {
		barProblem = "";
		applyMode();
		renderSaveBar();
	});
$("saveBarSave").addEventListener("click", () => {
	if (tab !== "settings") showTab("settings"); // the test result shows in the Connection card
	$("connCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
	saveConnection();
});

// The saved values into the fields (only fields you're not typing in).
function fillConnection(all) {
	const s = savedConnection();
	const put = (id, v) => {
		if (all || document.activeElement !== $(id)) $(id).value = v;
	};
	put("tabName", s.tabName);
	put("sheetUrl", s.sheetUrl);
	put("teamUrl", s.teamUrl || builtInUrl());
	put("scriptUrl", s.scriptUrl);
	put("secretKey", s.secretKey);
	$("useGoogleLogin").checked = s.useGoogleLogin;
	$("ownMode").checked = s.mode === "own";
	// Advanced opens by itself when it holds something you need: your own script, or a team
	// web app URL that isn't built in.
	if (s.mode === "own" || !builtInUrl()) $("advanced").open = true;
	applyMode();
}
$("discard").addEventListener("click", () => {
	fillConnection(true);
	barProblem = "";
	show("msg", "", "");
	renderSaveBar();
});

$("test").addEventListener("click", async () => {
	const s = readConnection();
	const problem = validate(s);
	if (problem) return show("msg", problem, "bad");
	$("test").disabled = true;
	try {
		await testConnection(s);
	} catch (e) {
		show("msg", `Test failed: ${e.message || e}`, "bad");
	} finally {
		$("test").disabled = false;
	}
});

// The fields are filled once (and again if the settings change elsewhere) — never while you type.
let connectionShown = "";
onRender(() => {
	const key = JSON.stringify(cfg);
	if (key !== connectionShown) {
		connectionShown = key;
		fillConnection(false);
	}
	const acc = st.rtAccount && st.rtAccount.email;
	setHTML(
		$("accountLine"),
		acc
			? `ReplyTrack last used <span class="account">${esc(acc)}</span>. Click Connect again only if you change accounts.`
			: "Once: Google asks you to approve ReplyTrack. Use the account that has your sheet."
	);
	renderSaveBar();
});

// ---------------------------------------------------------------------------
// Outreach: note + pace (saved on every change)
// ---------------------------------------------------------------------------
const NUMS = ["readMin", "readMax", "pauseMin", "pauseMax", "breakEvery", "dailyCap"];

async function saveOutreach(patch) {
	const next = { ...orSettings(), ...patch };
	if (next.readMax < next.readMin) next.readMax = next.readMin;
	if (next.pauseMax < next.pauseMin) next.pauseMax = next.pauseMin;
	await chrome.storage.local.set({ orSettings: next });
}
function readOutreach() {
	const p = {};
	for (const id of NUMS) {
		const v = Number($(id).value);
		p[id] = Number.isFinite(v) && v >= 0 ? v : S.DEFAULTS[id];
	}
	for (const id of ["readMin", "readMax", "pauseMin", "pauseMax"]) p[id] = Math.max(1, p[id]);
	p.breakEvery = Math.round(p.breakEvery);
	p.dailyCap = Math.round(p.dailyCap);
	p.noteMode = (document.querySelector('input[name="noteMode"]:checked') || {}).value || "column";
	p.noteText = $("noteText").value;
	return p;
}
const pick = mode => (document.querySelector(`input[name="noteMode"][value="${mode}"]`).checked = true);
onRender(() => {
	if (tab !== "settings") return;
	const s0 = orSettings();
	for (const id of NUMS) if (document.activeElement !== $(id)) $(id).value = s0[id];
	if (!document.activeElement || document.activeElement.name !== "noteMode") pick(["typed", "none"].includes(s0.noteMode) ? s0.noteMode : "column");
	if (document.activeElement !== $("noteText")) $("noteText").value = s0.noteText || "";
	const typed = String(s0.noteText || "").trim();
	$("typedStatus").textContent = typed ? `${S.chars(typed)} / ${S.NOTE_LIMIT} characters as typed (placeholders are filled per row).` : "";
	$("typedStatus").className = `hint ${S.chars(typed) > S.NOTE_LIMIT ? "err" : ""}`;
	$("setRate").textContent = `≈ ${Math.round(3600 / S.secondsPerRequest(s0))} requests / hour`;
});
NUMS.forEach(id => $(id).addEventListener("change", () => saveOutreach(readOutreach())));
document.querySelectorAll('input[name="noteMode"]').forEach(r => r.addEventListener("change", () => saveOutreach(readOutreach())));
let textTimer = null;
$("noteText").addEventListener("focus", () => {
	if (!document.querySelector('input[name="noteMode"][value="typed"]').checked) {
		pick("typed");
		saveOutreach(readOutreach());
	}
});
$("noteText").addEventListener("input", () => {
	pick("typed");
	clearTimeout(textTimer);
	textTimer = setTimeout(() => saveOutreach(readOutreach()), 350);
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
$("reset").addEventListener("click", async () => {
	if (!confirm("Reset sync history? The next sync will re-check your 50 most recent conversations.")) return;
	await send({ type: "resetHistory" });
	alert("Sync history cleared.");
});

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async e => {
	const f = e.target.files[0];
	e.target.value = "";
	if (!f) return;
	try {
		const text = await f.text();
		const entries = {};
		if (/^\s*\{/.test(text)) {
			// { "h:<key>": time } from the old extension's storage
			const j = JSON.parse(text);
			for (const [k, v] of Object.entries(j)) if (/^h:/.test(k)) entries[k] = Number(v) || 0;
		} else {
			// The old extension's Export CSV: rows whose requestStatus is "Sent"
			const rows = S.parseCSV(text);
			const head = rows[0] || [];
			const sc = S.findCol(head, "requestStatus");
			const at = S.findCol(head, "sentAt");
			if (sc < 0) throw new Error("That CSV has no requestStatus column — is it the old extension's Export CSV?");
			for (const r of rows.slice(1)) {
				if (S.norm(r[sc]) !== "sent") continue;
				const id = r.map(S.idFromCell).find(Boolean);
				if (id) entries["h:" + id.toLowerCase()] = Date.parse(r[at]) || 0; // 0 = sent, date unknown
			}
		}
		const res = await send({ type: "OR_IMPORT", entries });
		if (!res || !res.ok) throw new Error((res && res.error) || "no answer");
		show("importMsg", `Imported ${res.n} people (${res.added} new). They never get another request from ReplyTrack; a waiting row for one of them is marked “Sent” with the original date at the next run.`, "ok");
	} catch (err) {
		show("importMsg", `Couldn't import: ${err.message || err}`, "bad");
	}
});
