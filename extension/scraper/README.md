# Sales Nav Scraper (inside ReplyTrack)

Scrapes Sales Navigator searches and LinkedIn profiles, finds email and phone numbers, and saves every lead to the **SCRAP** tab of your sheet.

## Use

- **A Sales Navigator search:** open the search, click the ReplyTrack icon, pick **Quick**, **Standard** or **Deep**, set the pages, press **Start Auto-Scraping**.
- **One person's email & phone:** open their LinkedIn profile, click the ReplyTrack icon, press **Find contact info**.
- **More** (bottom of the popup): Clear leads, speed settings and the log.

| Mode     | Speed   | What you get                                                                 |
| -------- | ------- | ---------------------------------------------------------------------------- |
| Quick    | fastest | name, title, company, location, profile links                                |
| Standard | fast    | 34 columns (company, industry, tenure, summary, connection degree…); optionally past experience + public profile link |
| Deep     | slow    | everything, plus each lead's full profile, email and phone |

Leads go to SCRAP a few seconds after they're found (`bg/scrapesync.js` → Code.gs `saveScraped`). Deep Run fills in each row as profiles are read.

## Pace & limits (defaults)

- Search: 2–4 s per page, a 15–30 s break every ~10 pages.
- Profiles: 2 at a time, 3–6 s each, a 45–90 s break every 40, at most 1,500 a day.
- Stops by itself on sign-out or rate limiting — sign back in and press **Continue**; finished leads are kept.

## Files

| File | Role |
| --- | --- |
| `background.js` | the profile queue, contact finder, worker window (loaded by ReplyTrack's `background.js`) |
| `popup.html/css/js` | the popup |
| `injected.js`, `api-helper.js`, `content.js` | the Sales Navigator tab: reads search results through Sales Nav's own API |
| `net-tap.js`, `contact-finder.js`, `contact-parse.js`, `voyager-map.js` | LinkedIn tabs: Contact info request, profile data, email / phone rules |
| `export-cols.js` | the SCRAP tab's column layouts |
