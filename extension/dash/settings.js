// Settings: Connection (storage.sync) and Data (reset sync history).
// The note and the pace are on the Outreach page (dash/outreach.js).
//
// Connection (S.connection): the team web app (built in: team-config.js; changeable under
// Advanced) + your sheet link. "Connect Google account" opens the web app once for Google's
// permission screen.

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
		tabName: $("tabName").value.trim(),
		sheetUrl: $("sheetUrl").value.trim(),
		teamUrl: teamUrlToStore($("teamUrl").value),
	};
}

// What's saved, in the same shape.
function savedConnection() {
	return {
		tabName: String(cfg.tabName || "").trim() || S.DEFAULT_TAB,
		sheetUrl: String(cfg.sheetUrl || "").trim(),
		teamUrl: teamUrlToStore(cfg.teamUrl),
	};
}

function validate(s) {
	if (!s.tabName) return "Enter your tab name.";
	if (!s.sheetUrl) return "Paste your sheet link.";
	if (!S.sheetIdOf(s.sheetUrl)) return "That doesn't look like a Google Sheets link. Open your sheet and copy the address — it starts with https://docs.google.com/spreadsheets/d/";
	const url = s.teamUrl || builtInUrl();
	if (!url) return "The team web app URL isn't set. Enter it under Advanced — your team lead has it.";
	if (/\/dev$/.test(url)) return "The team web app URL (Advanced) is a test (/dev) URL. Use the one that ends in /exec.";
	if (!S.WEB_APP_RE.test(url)) return "The team web app URL (Advanced) doesn't look right. It should start with https://script.google.com/ and end with /exec.";
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
const CONNECTION_FIELDS = ["tabName", "sheetUrl", "teamUrl"];
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
	// Advanced opens by itself when no team web app URL is built in.
	if (!builtInUrl()) $("advanced").open = true;
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
// Data
// ---------------------------------------------------------------------------
$("reset").addEventListener("click", async () => {
	if (!confirm("Reset sync history? The next sync will re-check your 50 most recent conversations.")) return;
	await send({ type: "resetHistory" });
	alert("Sync history cleared.");
});
