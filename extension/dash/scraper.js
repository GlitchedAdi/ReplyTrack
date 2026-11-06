// Scraper tab: what the SalesNav Scraper (scraper/) is doing — read from its own storage keys.
// The scraper itself is driven from its popup (ReplyTrack icon on a Sales Navigator page or a
// LinkedIn profile). Its leads go to the SCRAP tab of your sheet (bg/scrapesync.js).
const SC_KEYS = ["scrapedLeads", "scrapingConfig", "enrichState", "scLast"];
let sc = {};

async function loadScraper() {
	sc = await chrome.storage.local.get(SC_KEYS);
	renderScraper();
}

function renderScraper() {
	if (tab !== "scraper") return;
	$("scLeads").textContent = ((sc.scrapedLeads || []).length || 0).toLocaleString();
	$("scLeadsCap").textContent = !configured()
		? "connect your sheet in Settings to save them to SCRAP"
		: sc.scLast
			? `saved to your sheet’s SCRAP tab · last sent ${ago(sc.scLast.at)}`
			: "saved to your sheet’s SCRAP tab";
	const cfg = sc.scrapingConfig || {};
	$("scSearch").textContent = cfg.active ? "Running" : "Idle";
	$("scSearchCap").textContent = cfg.active ? `page ${cfg.currentPage || 1} of ${cfg.maxPages || "?"}` : "";
	const en = sc.enrichState || {};
	$("scProfiles").textContent = en.active ? "Running" : "Idle";
	$("scProfilesCap").textContent = en.active ? `${(en.processed || 0).toLocaleString()} of ${(en.target || 0).toLocaleString()} profiles` : en.processed ? `last run: ${en.processed.toLocaleString()} profiles` : "";
}

chrome.storage.onChanged.addListener((c, area) => {
	if (area === "local" && SC_KEYS.some(k => c[k])) loadScraper();
});
onRender(renderScraper);
loadScraper();
