// MAIN world, linkedin.com pages (not Sales Navigator — injected.js covers that),
// document_start. Wraps the page's own fetch + XMLHttpRequest so the extension
// sees LinkedIn's requests and answers exactly as the page does — no DOM
// scraping, no guessing selectors.
//
// What it forwards to contact-finder.js (isolated world) with window.postMessage:
//  • CF_TAP  — a request whose URL/body/answer is LinkedIn's Contact info card,
//              with the request (method, URL, headers, body) and the answer text.
//              contact-finder.js parses it and learns the request, so later
//              lookups replay it directly for any profile (1 API call, no popup).
//  • CF_TAP  — (debug mode only) a one-line summary of every other API call.
//  • CF_TAP_HEADERS — LinkedIn's own x-li-* headers, reused on replays.
// Nothing is kept here; each answer is read once from a clone and dropped.
(function () {
	if (window.__cfTap) return;
	window.__cfTap = true;

	const SAME = location.origin;
	const SKIP = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|mp4|m3u8|ts)(\?|$)|\/li\/track|\/realtime\/|sensorCollect|\/tscp-serving|\/li\/tscp|\/csp\/|\/beacons?\b|\/lix\/|\/collect\b/i;
	const TEXTY = /json|text|x-component|javascript|html|octet-stream|^$/i;
	const CONTACT_HINT = /ContactDetailsOverlay|contact[-_ ]?info|contactinfo/i;
	const CONTACT_BODY = /ContactDetailsOverlay|mailto:|tel:\+?\d|"emailAddress"\s*:|"phoneNumbers"\s*:/i;
	const COPY_HEADERS = /^(accept|content-type|csrf-token|x-li-[\w-]+|x-restli-protocol-version|rsc|next-[\w-]+|x-sdui-[\w-]+|x-li-rsc-[\w-]+)$/i;
	const MAX_BODY = 4 * 1024 * 1024;

	let debug = false; // switched on by contact-finder.js when debug.js is loaded
	let seq = 0;

	const post = m => {
		try {
			window.postMessage(m, SAME);
		} catch (e) {}
	};
	window.addEventListener("message", e => {
		if (e.source === window && e.data && e.data.type === "CF_TAP_DEBUG") debug = !!e.data.on;
	});

	function absUrl(u) {
		try {
			return new URL(u, location.href);
		} catch (e) {
			return null;
		}
	}
	function headersObj(h) {
		const out = {};
		try {
			new Headers(h || undefined).forEach((v, k) => COPY_HEADERS.test(k) && (out[k.toLowerCase()] = v));
		} catch (e) {}
		return out;
	}
	function bodyText(b) {
		if (b == null) return "";
		if (typeof b === "string") return b.length > 200000 ? b.slice(0, 200000) : b;
		if (b instanceof URLSearchParams) return b.toString();
		if (b instanceof FormData) return "[FormData]";
		if (b instanceof Blob) return "[Blob]";
		if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
			try {
				return new TextDecoder().decode(b);
			} catch (e) {
				return "[binary]";
			}
		}
		return "[" + typeof b + "]";
	}
	// LinkedIn's own headers, reused on the extension's requests:
	//  rsc     — from the new UI's /flagship-web/rsc-action/ calls (app version, layout…)
	//  voyager — from /voyager/api/ calls (x-li-track, page instance…)
	const learned = { rsc: {}, voyager: {} };
	const PER_REQUEST = /^(csrf-token|x-li-traceparent|x-li-tracestate|x-li-pageforestid|x-li-page-instance-tracking-id)$/i;
	function learnHeaders(url, h) {
		const kind = /\/rsc-action\//.test(url) ? "rsc" : /\/voyager\/api\//.test(url) ? "voyager" : "";
		if (!kind) return;
		let changed = false;
		for (const [k, v] of Object.entries(h)) {
			if (!/^x-li-/.test(k) || PER_REQUEST.test(k) || !v || v === "undefined") continue;
			if (learned[kind][k] !== v) {
				learned[kind][k] = v;
				changed = true;
			}
		}
		if (changed) post({ type: "CF_TAP_HEADERS", kind, headers: { ...learned[kind] } });
	}

	function report(req, status, ct, text, ms, via) {
		const contactReq = CONTACT_HINT.test(req.url) || CONTACT_HINT.test(req.body);
		const contactBody = typeof text === "string" && CONTACT_BODY.test(text);
		if (!contactReq && !contactBody && !debug) return;
		const rec = {
			id: ++seq,
			via,
			method: req.method,
			url: req.url,
			page: req.page,
			status,
			ct: ct || "",
			bytes: typeof text === "string" ? text.length : -1,
			ms,
			contactReq,
			contactBody,
		};
		if (contactReq || contactBody) {
			rec.reqHeaders = req.headers;
			rec.reqBody = req.body;
		}
		post({ type: "CF_TAP", rec, body: contactReq || contactBody ? text : undefined });
	}

	function wanted(u) {
		return u && u.origin === SAME && !SKIP.test(u.pathname + u.search);
	}

	// ---- fetch ----
	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		let req = null;
		try {
			const u = absUrl(input instanceof Request ? input.url : String(input));
			if (wanted(u)) {
				const h = { ...headersObj(input instanceof Request ? input.headers : undefined), ...headersObj(init && init.headers) };
				learnHeaders(u.pathname, h);
				req = {
					url: u.pathname + u.search,
					method: String((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase(),
					headers: h,
					body: bodyText(init && init.body),
					page: location.pathname,
					t0: performance.now(),
				};
			}
		} catch (e) {}
		// A LinkedIn request that fails (offline, blocked by an ad blocker…) while nothing on the page
		// waits for its answer would show up in chrome://extensions as an error of THIS extension,
		// because this wrapper is in its stack. The page still gets the very same promise; this only
		// marks a failure nobody listens to as handled.
		const p = origFetch.apply(this, arguments);
		p.catch(() => {});
		if (req) {
			p.then(res => {
				const ct = res.headers.get("content-type") || "";
				const len = +res.headers.get("content-length") || 0;
				if (!TEXTY.test(ct) || len > MAX_BODY) return report(req, res.status, ct, null, Math.round(performance.now() - req.t0), "fetch");
				res.clone()
					.text()
					.then(t => report(req, res.status, ct, t.length > MAX_BODY ? null : t, Math.round(performance.now() - req.t0), "fetch"))
					.catch(() => {});
			}).catch(() => {});
		}
		return p;
	};

	// ---- XHR ----
	const X = XMLHttpRequest.prototype;
	const oOpen = X.open;
	const oSend = X.send;
	const oSet = X.setRequestHeader;
	X.open = function (method, url) {
		try {
			const u = absUrl(url);
			this.__cf = wanted(u) ? { url: u.pathname + u.search, method: String(method || "GET").toUpperCase(), headers: {}, page: location.pathname } : null;
		} catch (e) {
			this.__cf = null;
		}
		return oOpen.apply(this, arguments);
	};
	X.setRequestHeader = function (k, v) {
		try {
			if (this.__cf && COPY_HEADERS.test(k)) this.__cf.headers[String(k).toLowerCase()] = v;
		} catch (e) {}
		return oSet.apply(this, arguments);
	};
	X.send = function (body) {
		const req = this.__cf;
		if (req) {
			req.body = bodyText(body);
			req.t0 = performance.now();
			learnHeaders(req.url, req.headers);
			this.addEventListener("loadend", () => {
				try {
					const ct = this.getResponseHeader("content-type") || "";
					let t = null;
					if (this.responseType === "" || this.responseType === "text") t = this.responseText;
					else if (this.responseType === "json") t = JSON.stringify(this.response);
					report(req, this.status, ct, t, Math.round(performance.now() - req.t0), "xhr");
				} catch (e) {}
			});
		}
		return oSend.apply(this, arguments);
	};

	post({ type: "CF_TAP_READY" });
})();
