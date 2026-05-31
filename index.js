import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cookieJar = new Map();

function createSafeSender(res) {
    let sent = false;
    return (statusCode, data) => {
        if (!sent) {
            sent = true;
            res.status(statusCode).send(data);
        }
    };
}

function isOriginAllowed(origin) {
    if (CONFIG.ALLOWED_ORIGINS.includes("*")) {
        return true;
    }
    if (CONFIG.ALLOWED_ORIGINS.length && !CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        return false;
    }
    return true;
}

/**
 * Normalize a headers object from any of the supported JSON formats:
 *
 *   Format A  – per-source headers map  (miruro / bonk style)
 *     { "referer": "https://…", "User-Agent": "…", "Origin": "https://…" }
 *
 *   Format B  – provider-level headers map  (animex / uwu style)
 *     { "Referer": "https://kwik.cx" }
 *
 *   Format C  – no explicit headers at all (megastatics / burntburst style)
 *     undefined / null / {}
 *
 * Returns a plain object with lower-cased keys, or {} when nothing useful is found.
 */
function normalizeSourceHeaders(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v.trim()) {
            out[k.toLowerCase()] = v.trim();
        }
    }
    return out;
}

/**
 * Merge source-level headers (from the API JSON) with the proxy's own defaults.
 * Source headers win over defaults for the same key, except for cookie which is appended.
 */
function buildUpstreamHeaders(req, url, headersParam) {
    // --- proxy defaults ---
    const headers = {
        "user-agent": CONFIG.DEFAULT_USER_AGENT,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        "connection": "keep-alive",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "upgrade-insecure-requests": "1"
    };

    // Forward selected client headers
    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h.toLowerCase()] = req.headers[h];
    });

    // --- parse headersParam (JSON string passed as query param) ---
    let sourceHeaders = {};
    if (headersParam) {
        try {
            const parsed = JSON.parse(decodeURIComponent(headersParam));
            sourceHeaders = normalizeSourceHeaders(parsed);
        } catch (_) { /* ignore malformed JSON */ }
    }

    // Merge: source headers win
    Object.assign(headers, sourceHeaders);

    // --- derive referer / origin ---
    let referer = sourceHeaders['referer'] || sourceHeaders['referrer'] || CONFIG.DEFAULT_REFERER;

    // Domain-specific overrides (keep existing logic)
    if (url.hostname.includes('kwik') || url.hostname.includes('kwics')) {
        referer = CONFIG.ANIMEPAHE_BASE;
        if (!referer.endsWith('/')) referer += '/';
    } else if (url.hostname.includes('owocdn') || url.hostname.includes('cdn')) {
        if (!referer.includes('kwik.cx')) {
            // Only override if the source didn't already supply a referer
            if (!sourceHeaders['referer']) {
                referer = CONFIG.DEFAULT_REFERER;
            }
        }
    }

    try { referer = decodeURIComponent(referer); } catch (_) {}

    if (referer.includes('kwik.cx') && !referer.endsWith('/')) referer += '/';

    headers['referer'] = referer;

    // Set origin from referer unless source already provided one
    if (!sourceHeaders['origin']) {
        try {
            headers['origin'] = new URL(referer).origin;
        } catch (_) {
            headers['origin'] = referer;
        }
    }

    // --- Sec-Fetch headers ---
    if (url.hostname.includes('owocdn')) {
        headers['sec-fetch-dest'] = 'iframe';
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-site'] = 'cross-site';
    } else {
        headers['sec-fetch-dest'] = 'empty';
        headers['sec-fetch-mode'] = 'cors';
        headers['sec-fetch-site'] = 'cross-site';
    }

    // --- cookie jar ---
    const storedCookies = cookieJar.get(url.hostname);
    if (storedCookies) {
        headers['cookie'] = headers['cookie']
            ? `${headers['cookie']}; ${storedCookies}`
            : storedCookies;
    }

    return headers;
}

function updateCookieJar(url, targetResponse) {
    const setCookie = targetResponse.headers['set-cookie'];
    if (setCookie) {
        const current = cookieJar.get(url.hostname) || "";
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];

        const merged = [...new Set([
            ...current.split('; '),
            ...cookies.map(c => c.split(';')[0])
        ])].filter(Boolean).join('; ');

        cookieJar.set(url.hostname, merged);
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    res.setHeader('Cache-Control', CONFIG.CACHE_CONTROL);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function generateProxyUrl(targetUrl, headersParam) {
    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, headersParam) {
    return content.split("\n").map((line) => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) {
            return line;
        }

        if (trimmed.startsWith("#")) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(abs, headersParam)}${suffix}`;
                } catch (_) {
                    return match;
                }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam);
        } catch (_) {
            return line;
        }
    }).join("\n");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
    const origin = req.headers.origin || "";
    if (!isOriginAllowed(origin)) {
        res.status(403).send(`The origin "${origin}" was blacklisted by the operator of this proxy.`);
        return;
    }
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.options("/m3u8-proxy", (req, res) => {
    setCorsHeaders(req, res);
    res.sendStatus(204);
});

app.get("/m3u8-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);
    const origin = req.headers.origin || "";

    if (!isOriginAllowed(origin)) {
        return safeSend(403, `The origin "${origin}" was blacklisted by the operator of this proxy.`);
    }

    try {
        const urlStr = req.query.url;
        if (!urlStr) {
            return safeSend(400, { message: "URL is required" });
        }

        const url = new URL(urlStr);

        // `headers` query param can be:
        //   • A JSON string:  {"Referer":"https://kwik.cx","User-Agent":"…"}
        //   • Already URI-encoded by the client
        const headersParam = req.query.headers
            ? decodeURIComponent(req.query.headers)
            : "";

        const headers = buildUpstreamHeaders(req, url, headersParam);

        process.env.NODE_TLS_REJECT_UNAUTHORIZED =
            url.pathname.endsWith(".mp4") ? "0" : "1";

        const options = {
            method: 'GET',
            url: url.href,
            headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20000
        };

        try {
            const targetResponse = await cloudscraper(options);

            updateCookieJar(url, targetResponse);
            setCorsHeaders(req, res);

            const contentType = targetResponse.headers['content-type'] || '';
            const isPlaylist =
                url.pathname.toLowerCase().endsWith(".m3u8") ||
                contentType.includes("mpegURL") ||
                contentType.includes("application/x-mpegurl");

            if (isPlaylist) {
                const content = targetResponse.body.toString('utf8');
                const proxiedContent = proxyPlaylistContent(content, url, headersParam);
                res.setHeader('Content-Type', "application/vnd.apple.mpegurl");
                return res.status(200).send(proxiedContent);
            }

            if (targetResponse.statusCode >= 400) {
                const bodyStr = targetResponse.body.toString('utf8');
                return safeSend(targetResponse.statusCode, {
                    message: "Upstream returned error",
                    upstreamStatus: targetResponse.statusCode,
                    body: bodyStr.substring(0, 1000)
                });
            }

            Object.entries(targetResponse.headers).forEach(([k, v]) => {
                if (CONFIG.UPSTREAM_HEADERS.includes(k.toLowerCase())) {
                    res.setHeader(k, v);
                }
            });

            res.writeHead(targetResponse.statusCode);
            res.end(targetResponse.body);

        } catch (err) {
            console.error("Cloudscraper error:", err.message);
            if (err.response) {
                return safeSend(err.response.statusCode || 502, {
                    message: "Upstream error (Cloudscraper)",
                    error: err.message
                });
            }
            return safeSend(500, { message: err.message });
        }

    } catch (e) {
        if (!res.headersSent) {
            safeSend(500, { message: e.message });
        }
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`Server listening on PORT: ${CONFIG.PORT}`);
});
