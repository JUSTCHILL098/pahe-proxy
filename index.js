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

// REMOVED stateful cookieJar Map to ensure absolute stateless Serverless capability on Vercel

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

function buildUpstreamHeaders(req, url, headersParam) {
    const headers = {
        "User-Agent": CONFIG.DEFAULT_USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,en-IN;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1"
    };

    // Forward player range request directly
    if (req.headers.range) {
        headers['range'] = req.headers.range;
    }

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;
    
    // Serverless Fix: Parse passed cookies / headers from query pipeline parameters dynamically
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

    if (url.hostname.includes('owocdn')) {
        headers['Sec-Fetch-Dest'] = 'video';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
    } else {
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
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
                } catch (e) {
                    return match;
                }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam);
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
        const headers = buildUpstreamHeaders(req, url, headersParam);

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

        const options = {
            method: 'GET',
            url: url.href,
            headers: headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 25000
        };

        try {
            const targetResponse = await cloudscraper(options);
            setCorsHeaders(req, res);

            // Serverless Fix: Extract session cookies returned by this exact segment execution loop
            // and package them forward safely inside structural references
            let incomingCookies = "";
            const setCookie = targetResponse.headers['set-cookie'];
            if (setCookie) {
                const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
                incomingCookies = cookies.map(c => c.split(';')[0]).join('; ');
            }

            // Append captured context to subsequent fragments
            let nextHeadersParam = headersParam;
            if (incomingCookies) {
                try {
                    const currentObj = headersParam ? JSON.parse(headersParam) : {};
                    currentObj['cookie'] = currentObj['cookie'] 
                        ? `${currentObj['cookie']}; ${incomingCookies}` 
                        : incomingCookies;
                    nextHeadersParam = JSON.stringify(currentObj);
                } catch(e) {}
            }

            const contentType = targetResponse.headers['content-type'] || '';
            const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8") ||
                contentType.includes("mpegURL") ||
                contentType.includes("application/x-mpegurl");

            if (isPlaylist) {
                const content = targetResponse.body.toString('utf8');
                const proxiedContent = proxyPlaylistContent(content, url, nextHeadersParam);
                res.setHeader('Content-Type', "application/vnd.apple.mpegurl");
                res.status(200).send(proxiedContent);
            } else {
                if (targetResponse.statusCode >= 400) {
                    return safeSend(targetResponse.statusCode, {
                        message: "Upstream returned error",
                        upstreamStatus: targetResponse.statusCode
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
                res.end(targetResponse.body);
            }

        } catch (err) {
            if (err.response) {
                return safeSend(err.response.statusCode || 502, {
                    message: "Upstream connection timed out/failed",
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
