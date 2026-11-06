// Outreach: the rows from your sheet, Start / Stop / Continue and Dry run, progress, the
// note and its preview, the pace, the accepted check, the rows table and the log.
const STATUS = { pending: "Waiting", sent: "Sent", skipped: "Skipped", failed: "Failed" };
const DEG = { 1: "1st", 2: "2nd", 3: "3rd", 4: "Out of network" };
const orRowNo = it => it.rows[0]; // the spreadsheet row
const orItems = () => st.orItems || [];
const orOpen = () => orItems().filter(x => !x.done);
// Same order as the queue: rows to re-check first, then waiting rows, then failed ones.
const nextRow = () => {
	const items = orItems();
	const it = items.find(x => !x.done && retryable(x) && x.uncertainAt) || items.find(x => !x.done && x.status === "pending") || items.find(isTodo);
	return it ? orRowNo(it) : 0;
};
const rowOf = it => (st.orSheet && st.orSheet.rows[(it.noteRow || orRowNo(it)) - st.orSheet.first]) || [];
let orHistory = {}; // h:<key> → time a request was sent (only the keys of the loaded rows)
const sentEarlier = it => !!orHistory["h:" + it.key];

$("reload").innerHTML = `${ICON.refresh}Reload rows from sheet`;

// ---------------------------------------------------------------------------
// Header, numbers, progress (every render)
// ---------------------------------------------------------------------------
function sheetLine() {
	const sheet = st.orSheet;
	if (!sheet) return configured() ? "Rows are read from your sheet when you press Start or “Reload rows from sheet”." : "Connect your sheet in Settings first.";
	const s = sheet.stats || {};
	const by = Object.entries(s.statuses || {})
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${n.toLocaleString()} ${esc(k)}`)
		.join(", ");
	const extra = [];
	if (s.noUrl) extra.push(`${plural(s.noUrl, "open row")} without a LinkedIn Profile link`);
	if (s.noMessage) extra.push(`${plural(s.noMessage, "open row")} without a Personalized Message`);
	if (s.blocked) extra.push(`${plural(s.blocked, "person", "people")} with another row that has a status`);
	return `From “${esc(sheet.tab)}”, read ${esc(timeOf(sheet.loadedAt))}: ${plural(s.rows || 0, "row")}${by ? ` (${by})` : ""}.${extra.length ? ` Not sent: ${extra.join(" · ")}.` : ""}`;
}

onRender(() => {
	if (tab !== "outreach") return;
	const run = st.orRun || {};
	const items = orItems();
	const st0 = orSettings();
	const todo = items.filter(isTodo).length;
	const active = !!run.active;
	const paused = !!st.rtPaused;
	const box = !active && todo > 0 && run.job === "send" && run.stopKind && run.stopKind !== "stopped";
	const started = orOpen().some(x => x.status !== "pending");
	setHTML($("sheetLine"), sheetLine());

	// Main button: Start / Stop / Continue
	const b = $("orMain");
	if (active) {
		b.className = "btn stop";
		setHTML(b, `${ICON.stop}Stop`);
		b.disabled = false;
	} else {
		b.className = "btn primary";
		setHTML(b, box || started ? `${ICON.play}Continue from row ${nextRow()}` : `${ICON.plus}Start${todo ? ` · ${plural(todo, "row")}` : ""}`);
		b.disabled = paused || !configured();
	}
	$("dry").disabled = active || paused || !configured();
	$("reload").disabled = active;

	// Why the last run stopped
	$("continueBox").classList.toggle("hidden", !box);
	$("continueBox").classList.toggle("err", !!box && run.stopKind !== "cap");
	if (box) {
		const r = nextRow();
		$("continueText").textContent =
			run.stopKind === "cap"
				? `Auto-stopped at today's limit — ${plural(counts.today || 0, "request")} sent today. Continue sends up to ${st0.dailyCap.toLocaleString()} more today; or come back tomorrow.`
				: run.stopKind === "signedOut"
					? `LinkedIn signed you out. Sign in again in a normal LinkedIn tab, then press Continue — it picks up at row ${r}.`
					: run.stopKind === "verify"
						? run.stopReason
						: `${run.stopReason} Continue picks up at row ${r}.`;
	}

	// Numbers
	const t = {};
	for (const it of items) t[it.status] = (t[it.status] || 0) + 1;
	$("orToday").textContent = (counts.today || 0).toLocaleString();
	$("orTodayCap").textContent = counts.limit ? `of ${counts.limit.toLocaleString()} daily limit${counts.scraped ? ` (incl. ${counts.scraped.toLocaleString()} scraped)` : ""}` : "no daily limit";
	$("orLeft").textContent = todo.toLocaleString();
	$("orSkipped").textContent = (t.skipped || 0).toLocaleString();
	$("orFailed").textContent = (t.failed || 0).toLocaleString();

	// Progress
	const capLeft = counts.limit ? Math.max(0, counts.limit - (counts.used ?? counts.today ?? 0)) : Infinity;
	$("eta").textContent = S.estimate({ run, todo, st: st0, capLeft });
	$("bgTip").classList.toggle("hidden", !(active || todo));
	if (!run.target) {
		$("orStateTitle").textContent = active ? "Starting…" : "Idle";
		$("orCount").textContent = "";
		$("bar").style.width = "0";
		$("orState").textContent = st.orSheet ? `${plural(todo, "row")} waiting.` : "";
	} else {
		const doneN = run.processed || 0;
		$("bar").style.width = `${Math.round((doneN / run.target) * 100)}%`;
		const what = run.job === "check" ? "Dry run" : "Run";
		$("orStateTitle").textContent = active
			? run.waiting === "lock"
				? `Waiting for ${BUSY[run.lockBy] || "LinkedIn to be free"}…`
				: `${run.job === "check" ? "Dry run" : "Sending"} ${Math.min(doneN + 1, run.target)} of ${run.target}`
			: paused
				? "Paused"
				: run.finishedAt
					? `${what} finished`
					: `${what} stopped`;
		$("orCount").textContent = `${doneN} / ${run.target}`;
		let extra = "";
		if (active && run.waiting !== "lock" && run.nextAt > Date.now()) extra = ` · ${run.waiting === "reading" ? "sending in" : "next profile in"} ${fmtDur((run.nextAt - Date.now()) / 1000)}`;
		if (active && run.current) extra += ` · now: ${run.current}`;
		const sent = run.job === "check" ? "" : `${run.sent || 0} sent, ${run.skipped || 0} skipped · `;
		const checked = run.job === "check" || !run.checked ? "" : `${run.checked} checked on LinkedIn · `;
		const end = !active && run.stopReason && !box ? ` — ${run.stopReason}` : "";
		$("orState").textContent = `${sent}${checked}${run.failed || 0} failed${extra}${end}`;
	}

	// Accepted check (off without a Sent Date or a Response / Notes column)
	const ac = st.acStatus || {};
	const acOff = missingCols().filter(m => m.key === "sentDate" || m.key === "notes");
	$("acNow").disabled = !!ac.running || paused || !configured() || acOff.length > 0;
	setHTML(
		$("acState"),
		acOff.length
			? `<span class="muted">Off — your sheet has no ${acOff.map(m => `“${esc(m.name)}”`).join(" or ")} column.</span>`
			: ac.running
				? "Checking…"
				: [
						ac.lastRunAt ? `Last check ${esc(timeOf(ac.lastRunAt))}: ${esc(ac.summary || "")}` : '<span class="muted">Not checked yet.</span>',
						ac.error && (ac.lastTryAt || 0) > (ac.lastRunAt || 0) ? `<span class="err">Didn't finish: ${esc(ac.error)}</span>` : "",
					]
						.filter(Boolean)
						.join("<br>")
	);
});

// ---------------------------------------------------------------------------
// Start / Stop / Continue, Dry run, Reload, Check now
// ---------------------------------------------------------------------------
async function startRun(job) {
	const run = st.orRun || {};
	if (run.active) return send({ type: "OR_STOP" });
	const pastCap = job === "send" && run.stopKind === "cap";
	$("orMain").disabled = true;
	$("dry").disabled = true;
	showDetect("muted", "Reading your sheet…");
	try {
		let res = await send({ type: "OR_START", job, pastCap });
		if (res && res.needConfirm) {
			if (!confirm(`Send connection requests ${res.noteMode === "none" ? "without a note" : "with your note"} to up to ${plural(res.todo, "person", "people")}?\n\n${res.dailyCap ? `Auto-stops after ${res.dailyCap} requests today. ` : ""}Tip: a Dry run first shows what would happen for each row.`)) return;
			res = await send({ type: "OR_START", job, pastCap, confirmed: true });
		}
		if (res && res.capReached) {
			if (!confirm(`${res.error}\n\nSend up to ${res.dailyCap} more today?`)) return;
			res = await send({ type: "OR_START", job, pastCap: true, confirmed: true });
		}
		if (!res || !res.ok) alert((res && res.error) || "Couldn't start.");
	} finally {
		showDetect("", "");
		render();
	}
}
$("orMain").addEventListener("click", () => startRun("send"));
$("dry").addEventListener("click", () => startRun("check"));

function showDetect(cls, text) {
	$("detect").className = cls;
	$("detect").textContent = text || "";
}
$("reload").addEventListener("click", async () => {
	if ((st.orRun || {}).active) return alert("Stop the run first.");
	$("reload").disabled = true;
	showDetect("muted", "Reading your sheet…");
	const r = await send({ type: "OR_LOAD" });
	$("reload").disabled = false;
	if (!r || !r.ok) return showDetect("err", (r && r.error) || "Couldn't read your sheet.");
	showDetect("ok", `✓ Reloaded — ${plural(r.waiting, "person", "people")} waiting for a request.`);
});

$("acNow").addEventListener("click", async () => {
	$("acNow").disabled = true;
	const r = await send({ type: "AC_CHECK" });
	if (r && r.waiting) $("acState").textContent = "Waiting for LinkedIn to be free — runs right after.";
	else if (r && !r.ok) alert(r.error || "Couldn't check.");
});

// ---------------------------------------------------------------------------
// Message preview: what's sent, the first rows, problems across all waiting rows
// ---------------------------------------------------------------------------
function renderNote() {
	const sheet = st.orSheet;
	const header = sheet ? sheet.header : [];
	const s0 = orSettings();
	const pv = $("preview");
	const wr = $("warnings");
	const waiting = orOpen().filter(it => it.status === "pending");
	const err = sheet && S.noteSetup(s0, header).error;
	if (!sheet || !waiting.length || err) {
		setHTML(pv, sheet && !err && !waiting.length ? empty("check", "Nothing waiting", "Every row with an empty or “Not Started” status has been handled.") : !sheet ? empty("inbox", "No rows loaded yet", "Press “Reload rows from sheet” — or Start, which reads them too.") : "");
		setHTML(wr, err ? `<div class="err">${esc(err)}</div>` : "");
		return;
	}
	if (s0.noteMode === "none") {
		setHTML(pv, "");
		const before = waiting.filter(sentEarlier).length;
		setHTML(wr, before ? `<div class="muted">${plural(before, "person", "people")} already got a request from this extension — not sent again, marked “Sent”.</div>` : "");
		return;
	}
	const probs = new Map();
	let long = 0;
	let before = 0;
	const lens = [];
	const cards = [];
	waiting.forEach((it, n) => {
		const r = S.buildNote(s0, header, rowOf(it), null);
		if (sentEarlier(it)) before++;
		if (r.skip) probs.set(r.skip, (probs.get(r.skip) || 0) + 1);
		else {
			lens.push(S.chars(r.text));
			if (r.approxLong) long++;
		}
		if (n < 3)
			cards.push(
				`<div class="item"><div class="who">ROW ${orRowNo(it)} · ${esc(it.name || "linkedin.com/in/" + it.id)}</div>` +
					(r.skip ? `<div class="bad">Skipped: ${esc(r.skip)}</div>` : `<div><span class="txt">${esc(r.text)}</span><span class="n">${S.chars(r.text)} chars</span></div>`) +
					"</div>"
			);
	});
	setHTML(pv, cards.join(""));
	const lines = [];
	for (const [why, n] of probs) lines.push(`<div class="warn">${plural(n, "row")} will be skipped: ${esc(why.replace(/ for this row$/, ""))}</div>`);
	if (long) lines.push(`<div class="warn">${plural(long, "note")} may be over ${S.NOTE_LIMIT} characters once the names are filled in — those rows are skipped if so.</div>`);
	if (before) lines.push(`<div class="muted">${plural(before, "person", "people")} already got a request from this extension — not sent again, marked “Sent”.</div>`);
	if (lens.length) lines.push(`<div class="muted">Notes are ${Math.min(...lens)}–${Math.max(...lens)} characters (profile placeholders counted as «firstName» etc.).</div>`);
	if (!probs.size && !long) lines.unshift('<div class="ok">✓ Every waiting row has a note that fits.</div>');
	setHTML(wr, lines.join(""));
}

async function loadOrHistory() {
	const keys = orItems().map(it => "h:" + it.key);
	orHistory = keys.length ? await chrome.storage.local.get(keys) : {};
	renderNote();
}

// ---------------------------------------------------------------------------
// Rows table
// ---------------------------------------------------------------------------
const MAX_ROWS = 1000; // the table scrolls inside its card
function renderRows() {
	const f = $("filter").value;
	const items = orItems();
	const list = items.filter(it => !f || it.status === f);
	$("rowsWrap").classList.toggle("hidden", !list.length);
	setHTML(
		$("rowsEmpty"),
		list.length ? "" : items.length ? empty("inbox", "None with this status", "Pick another status above.") : empty("inbox", "No rows yet", "Press “Reload rows from sheet” to read the waiting rows of your sheet.")
	);
	$("rows").innerHTML = list
		.slice(0, MAX_ROWS)
		.map(it => {
			const url = it.url || `https://www.linkedin.com/in/${encodeURIComponent(it.publicId || it.id)}/`;
			const detail = it.detail || (it.would && it.status === "pending" ? `Dry run: would ${it.would}` : "");
			const when = it.sentAt || it.checkedAt;
			return (
				`<tr><td class="mono">${orRowNo(it)}</td><td><a href="${esc(url)}" target="_blank" rel="noopener">${esc(it.name || it.id)}</a>${it.degree ? ` <span class="mono">${DEG[it.degree] || ""}</span>` : ""}</td>` +
				`<td><span class="chip s-${esc(it.status)}">${esc(STATUS[it.status] || it.status)}</span></td><td>${esc(detail)}</td><td class="mono">${when ? esc(timeOf(when)) : ""}</td></tr>`
			);
		})
		.join("");
	$("rowsMore").textContent = list.length > MAX_ROWS ? `Showing the first ${MAX_ROWS} of ${list.length.toLocaleString()} — use the filter to narrow it down.` : "";
}
$("filter").addEventListener("change", renderRows);

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
function renderOrLog() {
	const el = $("log");
	const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
	const lines = st.orLog || [];
	el.innerHTML = lines.length ? lines.map(e => `<div class="${esc(e.level)}">${fmtTime(e.t)} ${esc(e.msg)}</div>`).join("") : '<div>Nothing logged yet.</div>';
	if (atBottom) el.scrollTop = el.scrollHeight;
}
$("copyLog").addEventListener("click", async () => {
	const txt = (st.orLog || []).map(e => `${new Date(e.t).toISOString()} [${e.level}] ${e.msg}`).join("\n");
	try {
		await navigator.clipboard.writeText(txt);
		$("copyLog").textContent = "Copied";
		setTimeout(() => ($("copyLog").textContent = "Copy"), 1200);
	} catch (e) {
		alert("Clipboard blocked.");
	}
});
$("clearLog").addEventListener("click", () => chrome.storage.local.set({ orLog: [] }));

// ---------------------------------------------------------------------------
// Only when their data changes (these can be heavy for big sheets)
// ---------------------------------------------------------------------------
let rowsTimer = null;
let noteTimer = null;
onChange(c => {
	if (!c || c.orLog) renderOrLog();
	let hist = false;
	if (c)
		for (const k of Object.keys(c))
			if (k.startsWith("h:")) {
				if (c[k].newValue) orHistory[k] = c[k].newValue;
				else delete orHistory[k];
				hist = true;
			}
	if (!c || c.orSheet || c.orSettings) loadOrHistory();
	else if (c.orItems || hist) {
		clearTimeout(noteTimer);
		noteTimer = setTimeout(renderNote, 600);
	}
	if (!c || c.orItems) {
		clearTimeout(rowsTimer);
		rowsTimer = setTimeout(renderRows, 200);
	}
});

// ---------------------------------------------------------------------------
// The note and the pace (storage.local "orSettings", saved on every change)
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
	if (tab !== "outreach") return;
	const s0 = orSettings();
	for (const id of NUMS) if (document.activeElement !== $(id)) $(id).value = s0[id];
	if (!document.activeElement || document.activeElement.name !== "noteMode") pick(["typed", "none"].includes(s0.noteMode) ? s0.noteMode : "column");
	if (document.activeElement !== $("noteText")) $("noteText").value = s0.noteText || "";
	const typed = String(s0.noteText || "").trim();
	$("typedStatus").textContent = typed ? `${S.chars(typed)} / ${S.NOTE_LIMIT} characters as typed (placeholders are filled per row).` : "";
	$("typedStatus").className = `hint ${S.chars(typed) > S.NOTE_LIMIT ? "err" : ""}`;
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
