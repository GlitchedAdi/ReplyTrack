# Setup prompt: ReplyTrack + WizaTool on a new Windows PC

Paste everything below the line into Claude Code (desktop app or terminal) on the new PC.
Claude does the downloads and builds; the person at the PC does every sign-in and click in
Chrome and Google.

---

Set up ReplyTrack (a Chrome extension) and WizaTool (a local app that looks up LinkedIn
contacts with the Wiza Chrome extension) on this Windows PC. Do the downloads, builds and
checks yourself. Leave every sign-in, password, Google permission screen and Chrome click to
me: tell me exactly what to click, one step at a time, and wait for me to say "done" before
you go on. Don't type any password or account details anywhere.

Facts you need:
- ReplyTrack: https://github.com/GlitchedAdi/ReplyTrack (branch `main`). The extension is the
  `extension` folder inside it.
- WizaTool: https://github.com/piyushkunder11/extracter (private; my GitHub account needs
  access — if `gh` can't see it, stop and tell me to ask for access).
- Install folder: `C:\Tools` (create it). Never inside OneDrive, Dropbox or Google Drive.
- My team's sheet "Make a copy" link: <PASTE THE TEMPLATE COPY LINK HERE>

Step 1 — Check the basics
1. Check Google Chrome is installed (`C:\Program Files\Google\Chrome\Application\chrome.exe`).
   If not, tell me to install it from https://www.google.com/chrome/ and wait.
2. Check `git` and `gh` are installed and `gh auth status` is signed in. If not, tell me how
   to install them / run `gh auth login` and wait.

Step 2 — Download both projects
1. `gh repo clone GlitchedAdi/ReplyTrack C:\Tools\ReplyTrack`
2. `gh repo clone piyushkunder11/extracter C:\Tools\WizaTool`

Step 3 — Build WizaTool's web page (a GitHub clone doesn't include it)
WizaTool's launcher installs only its runtime packages and expects the web page to be built
already, so a clone fails with "The web page is not built and Vite is not installed".
1. If Node.js 22.13 or newer is installed (`node -v`), in `C:\Tools\WizaTool` run
   `npm ci --include=dev`, then `npm run build:web`.
2. If Node.js isn't installed, run the launcher once first (Step 4.1) — it downloads its own
   Node.js to `%LOCALAPPDATA%\WizaTool\runtime` and then stops with the Vite error. Then run
   the two commands above with that Node.js (put its folder first on PATH for the command).
3. Check `C:\Tools\WizaTool\platform\web\dist\index.html` exists.

Step 4 — Start WizaTool and set it up
1. Tell me to double-click `C:\Tools\WizaTool\Start (Windows).bat` (if Windows says
   "Windows protected your PC": More info → Run anyway). Its first start takes a few minutes.
2. It picks port 3000, or the next free port if something else uses 3000. Find it: try
   `http://127.0.0.1:3000/api/health` up to `:3029` until one answers
   `{"ok":true,"version":...}`. Tell me the port.
3. Tell me to: create the WizaTool admin account on the setup page that opened; in the
   separate Chrome window WizaTool opens, sign in to LinkedIn, install "Wiza - Phone Number &
   Email Finder" from the Chrome Web Store and sign in to Wiza; then run WizaTool's
   one-profile test. Wait for "done".
4. Remind me of WizaTool's warnings: LinkedIn may block automated browsing (HTTP 999 — stop
   for the day if it happens), keep its default 40–100 second gap between profiles, and
   Wiza's terms restrict automated use.

Step 5 — Get my Google Sheet
Tell me to open the team's "Make a copy" link, check the Google account at the top right is
the one I want, click Make a copy, and paste the new sheet's address here. Check it starts
with `https://docs.google.com/spreadsheets/d/`.

Step 6 — Load the ReplyTrack extension
Tell me to: open `chrome://extensions` in my normal Chrome, turn on Developer mode, click
Load unpacked, choose `C:\Tools\ReplyTrack\extension`, and turn OFF (not remove) any older
ReplyTrack or "LinkedIn Automated Reachout" extension. Check with me that only one
ReplyTrack is on and that its version is 2.4.0 or newer.

Step 7 — Connect ReplyTrack to the sheet
Tell me to: click the ReplyTrack icon → Settings; paste my sheet link; leave Tab name as
MY LEADS; click "Connect Google account" and approve it (the "Google hasn't verified this
app" screen is expected: Advanced → Go to … (unsafe); tick the Google Sheets box; Continue);
then click Save. Ask me to paste the message under the buttons. It must start with
`Connected to "<my sheet's name>"` and show my sheet's id. If it says the background is an
older copy, tell me to click the reload button on ReplyTrack in chrome://extensions, close
the ReplyTrack dashboard tab, open it again from the toolbar icon and test again. If it
names a different spreadsheet, open Settings → Advanced and use "Switch to the team setup"
or "Reset to default", then test again.

Step 8 — First Wiza lookup
1. Tell me to add a SCRAP tab to the sheet if it doesn't have one, with "LinkedIn Profile"
   in row 1 and two or three profile links under it (or use the ReplyTrack Scraper).
2. Tell me to open the ReplyTrack dashboard → Wiza tab → Refresh profiles → Run Wiza lookup,
   allow local access when Chrome asks, and sign in with the WizaTool account from Step 4.
   There is no port to enter: ReplyTrack finds WizaTool by itself.
3. When it finishes, ask me to check the SCRAP rows got Work Email / Personal Email /
   Phone Number columns filled.

Every day after this: start WizaTool with `Start (Windows).bat`, then use Run Wiza lookup.

If any step fails, show me the exact error, explain it in plain words, fix what you can
yourself, and only then move on. Finish with a short summary of what's installed where.
