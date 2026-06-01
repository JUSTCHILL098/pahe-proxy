import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import https from 'https';
import { CONFIG } from './config.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function buildUpstreamHeaders(req, url, headersParam, passedCookies) {
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity", 
        "Connection": "keep-alive"
    };

    if (req.headers.range) {
        headers['range'] = req.headers.range;
    }

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            const additionalHeaders = JSON.parse(headersParam);
            Object.entries(additionalHeaders).forEach(([key, value]) => {
                const lk = key.toLowerCase();
                headers[lk] = value;
                if (lk === 'referer' || lk === 'referrer') referer = value;
            });
        } catch (e) { }
    }

    if (referer) {
        let refStr = decodeURIComponent(referer);
        if (url.hostname.includes('kwik') || url.hostname.includes('kwics')) {
            refStr = CONFIG.ANIMEPAHE_BASE;
            if (!refStr.endsWith('/')) refStr += '/';
        } else if (url.hostname.includes('owocdn') || url.hostname.includes('cdn')) {
            if (!refStr.includes('kwik.cx')) {
                refStr = CONFIG.DEFAULT_REFERER;
            }
        }
        if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
            refStr += '/';
        }
        headers['referer'] = refStr;
        try {
            headers['origin'] = new URL(refStr).origin;
        } catch (e) {
            headers['origin'] = refStr;
        }
    }

    // CRITICAL: Inject cookies extracted from the query parameters if they exist
    if (passedCookies) {
        headers['cookie'] = headers['cookie'] 
            ? `${headers['cookie']}; ${passedCookies}` 
            : passedCookies;
    }

    return headers;
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS || '*');
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS || '*');
    res.setHeader('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Fixed to dynamically attach routing session tokens inside child segments
function generateProxyUrl(targetUrl, headersParam, sessionCookies) {
    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    if (sessionCookies) proxyUrl += `&_cookies=${encodeURIComponent(sessionCookies)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, headersParam, sessionCookies) {
    return content.split("\n").map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) {
            return line;
        }
        if (trimmed.startsWith("#")) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(abs, headersParam, sessionCookies)}${suffix}`;
                } catch (e) {
                    return match;
                }
            });
        }
        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam, sessionCookies);
        } catch (e) {
            return line;
        }
    }).join("\n");
}

app.get('/', (req, res) => {
    const origin = req.headers.origin || "";
    if (!isOriginAllowed(origin)) {
        res.status(403).send(`The origin "${origin}" was blacklisted by the operator of this proxy.`);
        return;
    }
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
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
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const passedCookies = req.query._cookies ? decodeURIComponent(req.query._cookies) : "";
        
        const headers = buildUpstreamHeaders(req, url, headersParam, passedCookies);

        setCorsHeaders(req, res);

        const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8");

        if (isPlaylist) {
            const options = {
                method: 'GET',
                url: url.href,
                headers: headers,
                encoding: null,
                resolveWithFullResponse: true,
                timeout: 15000
            };

            try {
                const targetResponse = await cloudscraper(options);
                
                // Read and capture authentication cookies from the live playlist response
                let sessionCookies = passedCookies || "";
                const setCookie = targetResponse.headers['set-cookie'];
                if (setCookie) {
                    const parsed = Array.isArray(setCookie) ? setCookie : [setCookie];
                    const extracted = parsed.map(c => c.split(';')[0]).join('; ');
                    sessionCookies = sessionCookies ? `${sessionCookies}; ${extracted}` : extracted;
                }

                const content = targetResponse.body.toString('utf8');
                // Pass captured cookies directly down to the rewritten lines inside the manifest
                const proxiedContent = proxyPlaylistContent(content, url, headersParam, sessionCookies);
                
                res.setHeader('Content-Type', "application/vnd.apple.mpegurl");
                res.status(200).send(proxiedContent);
            } catch (err) {
                return safeSend(502, { message: "Failed parsing playlist", error: err.message });
            }
            
        } else {
            // Media segments, chunk streaming, and decryption keys (.key / .jpg)
            const proxyRequest = https.get(url.href, { 
                headers, 
                rejectUnauthorized: false 
            }, (targetResponse) => {
                
                if (targetResponse.statusCode >= 400) {
                    return safeSend(targetResponse.statusCode, { 
                        message: `Upstream error status: ${targetResponse.statusCode}` 
                    });
                }

                const streamHeaders = [
                    'content-type',
                    'content-length',
                    'content-range',
                    'accept-ranges'
                ];

                Object.entries(targetResponse.headers).forEach(([k, v]) => {
                    const lk = k.toLowerCase();
                    if (streamHeaders.includes(lk)) {
                        res.setHeader(k, v);
                    }
                });

                if (!targetResponse.headers['accept-ranges']) {
                    res.setHeader('Accept-Ranges', 'bytes');
                }

                res.writeHead(targetResponse.statusCode);
                targetResponse.pipe(res);
            });

            proxyRequest.on('error', (err) => {
                if (!res.headersSent) safeSend(502, { message: err.message });
            });
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
