// server.js
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
// import AnonymizeUaPlugin from "puppeteer-extra-plugin-anonymize-ua";
import zlib from "zlib";


const PORT = 3000;

// config
const headless = true;
const randomProxy = false; // kalau false, pakai proxy secara round-robin
const minBrowserCount = 5; // jumlah browser yg dibuka (kalau proxy lebih banyak, sesuaikan dengan jumlah proxy)

const proxies = [
    // isi proxy disini, formatnya: http://username:password@host:port
    // kalau ga pakai proxy, biarin aja kosong
    "socks5://localhost:40000",
];

const userAgents = [
    // "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36",
    // Desktop Chrome
    // "Mozilla/5.0 (Linux; Android 15; SM-S931B Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36",
    // Desktop Firefox
    // "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    // // macOS Safari
    // "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.2 Safari/605.1.15",
    // // iPhone Safari
    // "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.2 Mobile/15E148 Safari/604.1",
    // // Android Chrome
    // "Mozilla/5.0 (Linux; Android 12; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
];

puppeteer.use(StealthPlugin());
// puppeteer.use(AnonymizeUaPlugin({}));
// puppeteer.use(AnonymizeUaPlugin({ customFn: (ua) => ua.replace("HeadlessChrome", "Chrome") }));
// puppeteer.use(AnonymizeUaPlugin({
//     customFn: (ua) => {
//         // getUserAgent() akan mengembalikan user-agent asli, jadi kita bisa modifikasi di sini
//         ua = getUserAgent();
//         return ua;
//     }
// }));
const app = express();
app.use(cors());

let browsers;
let browserIndexUsed = 0;

function getUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function initBrowser() {
    // tentukan jumlah browser final
    let finalCount = minBrowserCount;

    if (proxies.length > 0) {
        if (minBrowserCount < proxies.length) {
            finalCount = proxies.length; // minimal sebanyak proxy
        }
    }

    console.log(`Target browser count: ${finalCount}`);

    // buat daftar proxy yang sudah di-expand
    let expandedProxies = [];
    if (proxies.length === 0) {
        // kalau tidak ada proxy → semua kosong
        expandedProxies = Array(finalCount).fill(null);
    } else {
        // ulangi proxies sampai jumlah = finalCount
        for (let i = 0; i < finalCount; i++) {
            expandedProxies.push(proxies[i % proxies.length]);
        }
    }

    console.log(`Initializing ${expandedProxies.length} browsers...`);

    // launch semua browser
    await Promise.all(expandedProxies.map(async (proxy) => {
        if (
            browsers &&
            proxy &&
            browsers.find(b => b.process().spawnargs.includes(`--proxy-server=${proxy}`))
        ) {
            console.log(`Browser with proxy ${proxy} already exists`);
            return;
        }

        try {
            const browser = await puppeteer.launch({
                headless,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    proxy ? `--proxy-server=${proxy}` : "",
                ].filter(Boolean),
            });

            browsers = browsers || [];
            browsers.push(browser);

            // get user agent
            // const userAgent = await browser.userAgent();
            // console.log(`User agent: ${userAgent}`);

            console.log(`Browser launched with proxy: ${proxy || "NO PROXY"}`);
        } catch (err) {
            console.error(`Failed to launch browser with proxy ${proxy}:`, err);
        }
    }));

    console.log(`Total browsers launched: ${browsers.length}`);
}

app.get("/proxy", async (req, res) => {
    if (!browsers || browsers.length === 0 || browsers.length < proxies.length) {
        try {
            await initBrowser();
        } catch (err) {
            return res.status(500).json({ error: "Failed to launch browser", details: err.message });
        }
    }

    let browser;
    if (randomProxy) {
        // pilih browser secara acak dari list
        browser = browsers[Math.floor(Math.random() * browsers.length)];
        if (!browser) {
            return res.status(500).json({ error: "No browser instance available" });
        }
    } else {
        // pilih browser secara round-robin
        browser = browsers[browserIndexUsed % browsers.length];
        browserIndexUsed++;
    }

    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Missing url param" });

    let page;
    try {
        page = await browser.newPage();

        // set user-agent random
        if (userAgents.length > 0) {
            const ua = getUserAgent();
            await page.setUserAgent(ua);
            console.log(`Using User-Agent: ${ua}`);
        }

        // bikin promise untuk nunggu response
        const waitForResponse = new Promise((resolve, reject) => {
            page.on("response", async (response) => {
                try {
                    const responseUrl = response.url();
                    if (responseUrl === targetUrl || responseUrl.startsWith(targetUrl)) {
                        const headers = response.headers();
                        const buffer = await response.buffer();

                        let jsonBuffer = buffer;
                        try {
                            if (headers["content-encoding"] === "gzip") {
                                jsonBuffer = zlib.gunzipSync(buffer);
                            } else if (headers["content-encoding"] === "br") {
                                jsonBuffer = zlib.brotliDecompressSync(buffer);
                            } else if (headers["content-encoding"] === "deflate") {
                                jsonBuffer = zlib.inflateSync(buffer);
                            }
                        } catch {
                            // fallback pakai buffer asli
                        }

                        try {
                            const data = jsonBuffer.toString();
                            resolve(data);
                        } catch (e) {
                            reject(new Error("Failed to parse response as text"));
                        }
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        // jalanin goto tanpa nunggu networkidle0 (biar cepat)
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        // balikin response pertama yg ketangkep
        const data = await waitForResponse;

        // kirim response sebagai JSON
        try {
            res.json(JSON.parse(data));
        } catch (e) {
            res.send(data);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (page) await page.close();
    }
});

await initBrowser();
app.listen(PORT, () => console.log(`Proxy running at http://localhost:${PORT}`));
