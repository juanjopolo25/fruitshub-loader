import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@libsql/client";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURATION ====================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    ADMIN_SECRET: process.env.ADMIN_SECRET || "FH_ADMIN_ROOT_SECRET_2026",
    SIGNING_SECRET: process.env.SIGNING_SECRET || "FH_SEC_98f12a4b8c3d7e502164a3e8b09c1d2e",
    MIN_WAIT_SECONDS: parseInt(process.env.MIN_WAIT_SECONDS || "20", 10),
    KEY_DURATION_HOURS: parseInt(process.env.KEY_DURATION_HOURS || "24", 10),

    // Checkpoints (LootLabs / Linkvertise)
    LOOTLABS_LINKS: process.env.LOOTLABS_LINKS
        ? process.env.LOOTLABS_LINKS.split(",").map(s => s.trim())
        : [
            "https://lootdest.org/s?0nuABVki",
            "https://lootdest.org/s?dB7klGpP",
            "https://lootdest.org/s?JEEbtzgW"
        ],
    LINKVERTISE_LINKS: process.env.LINKVERTISE_LINKS
        ? process.env.LINKVERTISE_LINKS.split(",").map(s => s.trim())
        : [
            "https://link-target.net/574428/A2fuRuJEclPX",
            "https://link-hub.net/574428/DvFSlMdED1NU",
            "https://link-hub.net/574428/yrlFgIJxxrV6"
        ],
    LINKVERTISE_ANTI_BYPASS_TOKEN: process.env.LINKVERTISE_ANTI_BYPASS_TOKEN || "5626539749ba412c89d2205aeaba20de2db3d5b424ce54316cfcaeff5db171dd",
    LOOTLABS_API_TOKEN: process.env.LOOTLABS_API_TOKEN || "44428ecb0e20867a52d71095dba347fe128ad34dd7208a23f324ee237e7f2e76"
};

// ==================== DATABASE INITIALIZATION ====================
// Supports both local file SQLite and remote Turso cloud database
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbUrl = process.env.TURSO_DATABASE_URL || `file:${path.join(dataDir, "fruitshub.db")}`;
const dbAuthToken = process.env.TURSO_AUTH_TOKEN || undefined;

const db = createClient({
    url: dbUrl,
    authToken: dbAuthToken
});

async function initDatabase() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS keys (
            key TEXT PRIMARY KEY,
            hwid TEXT,
            created_at TEXT,
            expires_at TEXT,
            active INTEGER DEFAULT 1,
            tier TEXT DEFAULT '24h',
            provider TEXT DEFAULT 'lootlabs',
            first_used TEXT,
            last_used TEXT
        );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_hwid ON keys (hwid);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_expires ON keys (expires_at);`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            hwid TEXT,
            provider TEXT,
            step INTEGER,
            issued_at INTEGER,
            nonce TEXT,
            created_at INTEGER
        );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_issued ON sessions (issued_at);`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS conversions (
            click_id TEXT PRIMARY KEY,
            ip TEXT,
            unique_id TEXT,
            received_at INTEGER
        );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_conversions_received ON conversions (received_at);`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS system_config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS payloads (
            version TEXT PRIMARY KEY,
            payload TEXT,
            updated_at TEXT
        );
    `);

    // Seed persistent keys so they always exist on cold start
    const SEED_KEYS = [
        { key: "FH-3ab8d70d6553eec6d98601f4", hwid: "bf72f6f4b9edb5b605cd2014f07a1d25f7f35e263471106639d79b41127dc303", tier: "24h", hours: 48 },
        { key: "FH-3fdc72f8bbb5d38960e7bf35", hwid: "bf72f6f4b9edb5b605cd2014f07a1d25f7f35e263471106639d79b41127dc303", tier: "permanent", hours: 87600 }
    ];
    for (const sk of SEED_KEYS) {
        const expIso = new Date(Date.now() + sk.hours * 3600 * 1000).toISOString();
        await db.execute({
            sql: "INSERT OR IGNORE INTO keys (key, hwid, created_at, expires_at, active, tier, provider) VALUES (?, ?, ?, ?, 1, ?, 'seed')",
            args: [sk.key, sk.hwid, new Date().toISOString(), expIso, sk.tier]
        });
    }

    console.log(`[+] Database initialized successfully (${dbUrl})`);
}

// ==================== IN-MEMORY SCRIPT CACHE ====================
// Keeps the active script in RAM for instantaneous (0ms) delivery.
const SCRIPT_CACHE = {
    maintenance: false,
    version: "v1.0.1",
    payload: null
};

async function reloadScriptCache() {
    try {
        const maintRow = await db.execute({
            sql: "SELECT value FROM system_config WHERE key = 'MAINTENANCE'",
            args: []
        });
        SCRIPT_CACHE.maintenance = maintRow.rows.length > 0 && maintRow.rows[0].value === "true";

        const verRow = await db.execute({
            sql: "SELECT value FROM system_config WHERE key = 'CURRENT_VERSION'",
            args: []
        });
        if (verRow.rows.length > 0 && verRow.rows[0].value) {
            SCRIPT_CACHE.version = String(verRow.rows[0].value);
        }

        const payloadRow = await db.execute({
            sql: "SELECT payload FROM payloads WHERE version = ?",
            args: [SCRIPT_CACHE.version]
        });

        if (payloadRow.rows.length > 0 && payloadRow.rows[0].payload) {
            SCRIPT_CACHE.payload = String(payloadRow.rows[0].payload);
            console.log(`[i] Loaded active payload ${SCRIPT_CACHE.version} from DB (${SCRIPT_CACHE.payload.length} chars)`);
        } else {
            // Fallback: Check local payload.luau in server directory
            const localCandidate = path.join(__dirname, "payload.luau");
            if (fs.existsSync(localCandidate)) {
                SCRIPT_CACHE.payload = fs.readFileSync(localCandidate, "utf-8");
                console.log(`[i] Seeded payload ${SCRIPT_CACHE.version} from local payload.luau (${SCRIPT_CACHE.payload.length} chars)`);
                // Persist into DB
                await db.execute({
                    sql: "INSERT OR REPLACE INTO payloads (version, payload, updated_at) VALUES (?, ?, ?)",
                    args: [SCRIPT_CACHE.version, SCRIPT_CACHE.payload, new Date().toISOString()]
                });
                await db.execute({
                    sql: "INSERT OR REPLACE INTO system_config (key, value) VALUES ('CURRENT_VERSION', ?)",
                    args: [SCRIPT_CACHE.version]
                });
            }
        }
    } catch (err) {
        console.error("[-] Error loading script cache:", err);
    }
}

// ==================== CRYPTOGRAPHIC HMAC ====================
function signData(dataObj, secret) {
    const dataStr = JSON.stringify(dataObj);
    const signatureHex = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
    const payloadB64 = Buffer.from(dataStr, "utf-8").toString("base64");
    return `${payloadB64}.${signatureHex}`;
}

function verifyAndDecodeData(signedToken, secret) {
    if (!signedToken || typeof signedToken !== "string" || !signedToken.includes(".")) return null;
    const [payloadB64, signatureHex] = signedToken.split(".");
    try {
        const dataStr = Buffer.from(payloadB64, "base64").toString("utf-8");
        const expectedSig = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
        if (!crypto.timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expectedSig, "hex"))) {
            return null;
        }
        return JSON.parse(dataStr);
    } catch {
        return null;
    }
}

function generateSignedKey(hwid, expiresMs, tier = "24h") {
    const rawHwid = (hwid && hwid !== "DEFAULT_USER" && hwid !== "UNSET" && !hwid.startsWith("WEB_")) ? hwid : "UNBOUND";
    const nonce = crypto.randomBytes(3).toString("hex");
    const payloadStr = `${rawHwid}:${expiresMs}:${tier}:${nonce}`;
    const payloadB64 = Buffer.from(payloadStr, "utf-8").toString("base64url");
    const sig = crypto.createHmac("sha256", CONFIG.SIGNING_SECRET).update(payloadStr).digest("hex").substring(0, 16);
    return `FH-${payloadB64}.${sig}`;
}

function decodeAndVerifyKey(keyStr, secret) {
    if (!keyStr || typeof keyStr !== "string" || !keyStr.startsWith("FH-") || !keyStr.includes(".")) return null;
    const tokenPart = keyStr.substring(3);
    const dotIdx = tokenPart.indexOf(".");
    if (dotIdx === -1) return null;
    const payloadB64 = tokenPart.substring(0, dotIdx);
    const signatureHex = tokenPart.substring(dotIdx + 1);
    try {
        const payloadStr = Buffer.from(payloadB64, "base64url").toString("utf-8");
        const expectedSig = crypto.createHmac("sha256", secret).update(payloadStr).digest("hex").substring(0, 16);
        if (signatureHex.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expectedSig, "hex"))) {
            return null;
        }
        const parts = payloadStr.split(":");
        if (parts.length < 3) return null;
        const [boundHwid, expiresMsStr, tier] = parts;
        const expiresMs = Number(expiresMsStr);
        if (isNaN(expiresMs) || expiresMs < Date.now()) return null;
        return { valid: true, hwid: boundHwid, expires_at: new Date(expiresMs).toISOString(), expiresMs: expiresMs, tier: tier || "24h" };
    } catch {
        return null;
    }
}

function generateSecureKey() {
    const chars = "abcdef0123456789";
    let token = "FH-";
    for (let i = 0; i < 24; i++) {
        token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
}

// Helper to determine the public server URL
function getBaseUrl(req) {
    if (process.env.PUBLIC_URL) {
        return process.env.PUBLIC_URL.replace(/\/$/, "");
    }
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}`;
}

// ==================== EXPRESS APPLICATION ====================
const app = express();

// Middleware: Enable Gzip compression (reduces payload from ~213KB to ~45KB, saving 78% bandwidth)
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// 1. Keep-Alive Ping endpoint for UptimeRobot / Cron-job
// Responds in <1ms to keep Render Free Tier awake 24/7
app.get("/ping", (req, res) => {
    res.status(200).send("OK");
});

// 2. Health & Status Check
app.get("/status", (req, res) => {
    res.status(200).json({
        status: "online",
        maintenance: SCRIPT_CACHE.maintenance,
        version: SCRIPT_CACHE.version,
        cachedBytes: SCRIPT_CACHE.payload ? SCRIPT_CACHE.payload.length : 0
    });
});

// 3. Universal Loader for Roblox Executors
app.get(["/loader", "/loader.luau"], (req, res) => {
    const baseUrl = getBaseUrl(req);
    const loaderLua = `--[[
    FruitsHub Universal Execution Loader
    Gateway: ${baseUrl}
]]
getgenv().FruitsHub = getgenv().FruitsHub or {}
repeat task.wait() until game:IsLoaded() and game.Players.LocalPlayer

local function getClientHWID()
    if gethwid then
        local ok, h = pcall(gethwid)
        if ok and h and tostring(h) ~= "" then return tostring(h) end
    end
    local analytics = game:GetService("RbxAnalyticsService")
    local clientId = ""
    pcall(function() clientId = analytics:GetClientId() end)

    if identifyexecutor then
        local ok, ex = pcall(identifyexecutor)
        if ok and ex and tostring(ex) ~= "" then
            return tostring(clientId) .. "_" .. tostring(ex)
        end
    end
    return tostring(clientId ~= "" and clientId or "UNKNOWN_CLIENT")
end

local Key = tostring(getgenv().Key or getgenv().FruitsHubKey or ""):gsub("%s+", "")
local HWID = getClientHWID()
local CachePath = "FruitsHub/cache_v1.luau"
local VerPath = "FruitsHub/version.txt"

local hasFs = (writefile and readfile and isfile) ~= nil
local localCached = hasFs and isfile(CachePath)
local cachedVersion = (hasFs and isfile(VerPath)) and readfile(VerPath) or "none"

local requestUrl = string.format(
    "${baseUrl}/load?key=%s&hwid=%s&cv=%s",
    Key,
    HWID,
    localCached and cachedVersion or "none"
)

local success, scriptContent = pcall(function()
    return game:HttpGet(requestUrl)
end)

if not success or not scriptContent or scriptContent == "" then
    return warn("[FruitsHub] Failed to contact server gateway. Check your internet connection.")
end

if scriptContent:find("%-%-%[%[FH_CACHE_VALID%]%]") and localCached then
    local okRead, cachedCode = pcall(readfile, CachePath)
    if okRead and cachedCode and cachedCode ~= "" then
        return loadstring(cachedCode)()
    end
end

if scriptContent:find("FruitsHub:") and scriptContent:find("p:Kick") then
    return loadstring(scriptContent)()
end

if hasFs then
    pcall(function()
        if makefolder and not isfolder("FruitsHub") then
            makefolder("FruitsHub")
        end
        writefile(CachePath, scriptContent)
        writefile(VerPath, "${SCRIPT_CACHE.version}")
    end)
end

loadstring(scriptContent)()
`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    return res.status(200).send(loaderLua);
});

// Helper for generating Luau kick code
function generateKickResponse(message, copyUrl) {
    const safeMsg = JSON.stringify(message);
    const safeUrl = copyUrl ? JSON.stringify(copyUrl) : '""';
    return `
        local msg = ${safeMsg}
        local url = ${safeUrl}
        if url ~= "" and setclipboard then
            pcall(function() setclipboard(url) end)
        end
        local p = game:GetService("Players").LocalPlayer
        if p then
            p:Kick(msg .. (url ~= "" and "\\n\\nGet Key: " .. url or ""))
        else
            warn(msg .. (url ~= "" and " [URL: " .. url .. "]" or ""))
        end
    `;
}

// 4. Roblox Load Endpoint (Key Auth & Script Delivery)
app.get(["/load", "/load.luau"], async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const key = req.query.key ? String(req.query.key).trim() : "";
    const hwid = req.query.hwid ? String(req.query.hwid).trim() : "UNKNOWN_HWID";
    const clientVersion = req.query.cv ? String(req.query.cv).trim() : "";
    const keyUrl = `${baseUrl}/?hwid=${encodeURIComponent(hwid)}`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("X-FruitsHub-Version", SCRIPT_CACHE.version);

    if (!key || key === "PASTE_KEY_HERE" || key === "nil" || key === "YOUR_KEY_HERE" || key === "") {
        return res.status(200).send(generateKickResponse("FruitsHub: No access key provided. Key link has been copied to your clipboard.", keyUrl));
    }

    if (SCRIPT_CACHE.maintenance) {
        return res.status(200).send(generateKickResponse("FruitsHub: Script is currently down for scheduled maintenance."));
    }

    // Query key in Database
    try {
        let keyRow = null;
        const keyResult = await db.execute({
            sql: "SELECT * FROM keys WHERE key = ?",
            args: [key]
        });

        if (keyResult.rows.length > 0) {
            keyRow = keyResult.rows[0];
        } else {
            // Self-healing fallback: verify cryptographic signature of key
            const verified = decodeAndVerifyKey(key, CONFIG.SIGNING_SECRET);
            if (verified && verified.valid) {
                const nowIso = new Date().toISOString();
                const keyHwid = (hwid && hwid !== "UNKNOWN_CLIENT") ? hwid : (verified.hwid || "UNBOUND");
                await db.execute({
                    sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider) VALUES (?, ?, ?, ?, 1, ?, 'self_heal')",
                    args: [key, keyHwid, nowIso, verified.expires_at, verified.tier || "24h"]
                });
                keyRow = {
                    key: key,
                    hwid: keyHwid,
                    active: 1,
                    expires_at: verified.expires_at,
                    tier: verified.tier || "24h"
                };
                console.log(`[+] Self-healed and restored cryptographic key into DB: ${key}`);
            }
        }

        if (!keyRow) {
            return res.status(200).send(generateKickResponse("FruitsHub: Invalid key. Key link has been copied to your clipboard to generate a new one.", keyUrl));
        }

        if (!keyRow.active) {
            return res.status(200).send(generateKickResponse("FruitsHub: This key has been deactivated or blacklisted."));
        }

        const expiresDate = keyRow.expires_at ? new Date(String(keyRow.expires_at)) : null;
        if (expiresDate && expiresDate < new Date()) {
            return res.status(200).send(generateKickResponse("FruitsHub: Access key expired. Key link has been copied to your clipboard to renew.", keyUrl));
        }

        // HWID Lock
        const nowIso = new Date().toISOString();
        if (!keyRow.hwid || keyRow.hwid === "UNSET" || keyRow.hwid === "UNBOUND") {
            await db.execute({
                sql: "UPDATE keys SET hwid = ?, first_used = ?, last_used = ? WHERE key = ?",
                args: [hwid, nowIso, nowIso, key]
            });
        } else if (keyRow.hwid !== hwid) {
            return res.status(200).send(generateKickResponse("FruitsHub: Key is locked to another device (HWID Mismatch). Each key is single-device.", keyUrl));
        } else {
            // Debounced last_used update: only update if >15 minutes to save DB writes
            const lastUsedMs = keyRow.last_used ? new Date(String(keyRow.last_used)).getTime() : 0;
            if (Date.now() - lastUsedMs > 15 * 60 * 1000) {
                await db.execute({
                    sql: "UPDATE keys SET last_used = ? WHERE key = ?",
                    args: [nowIso, key]
                });
            }
        }

        if (!SCRIPT_CACHE.payload) {
            return res.status(200).send(generateKickResponse(`FruitsHub: Error loading script build ${SCRIPT_CACHE.version}. Contact support.`));
        }

        // Smart Cache Validation: 15-byte response if client already has this version
        if (clientVersion && clientVersion === SCRIPT_CACHE.version) {
            return res.status(200).send("--[[FH_CACHE_VALID]]");
        }

        // Deliver full payload (Express compression middleware will Gzip this automatically)
        return res.status(200).send(SCRIPT_CACHE.payload);
    } catch (err) {
        console.error("[-] DB error during /load:", err);
        return res.status(500).send(generateKickResponse("FruitsHub: Internal server error. Please retry in a moment."));
    }
});

// 5. Checkpoint Start
app.get("/checkpoint/start", async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const hwid = String(req.query.hwid || "UNBOUND");
    const provider = String(req.query.provider || "lootlabs");
    const step = parseInt(String(req.query.step || "1"), 10);

    const sessionId = crypto.randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = Math.random().toString(36).substring(2, 10);

    const tokenPayload = {
        sid: sessionId,
        hwid: hwid,
        provider: provider,
        step: step,
        issuedAt: issuedAt,
        nonce: nonce
    };

    const signedToken = signData(tokenPayload, CONFIG.SIGNING_SECRET);

    try {
        await db.execute({
            sql: "INSERT OR REPLACE INTO sessions (sid, hwid, provider, step, issued_at, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [sessionId, hwid, provider, step, issuedAt, nonce, issuedAt]
        });
    } catch (err) {
        console.error("[-] Error saving session:", err);
    }

    const returnUrl = `${baseUrl}/checkpoint/verify?token=${encodeURIComponent(signedToken)}`;

    let destinationUrl;
    if (provider === "lootlabs") {
        const linkBase = CONFIG.LOOTLABS_LINKS[step - 1] || CONFIG.LOOTLABS_LINKS[0];
        if (linkBase.includes("DEMO_")) {
            return res.send(renderDemoSimulator(step, provider, hwid, returnUrl));
        }

        let encData = "";
        if (CONFIG.LOOTLABS_API_TOKEN) {
            try {
                const encRes = await fetch("https://creators.lootlabs.gg/api/public/url_encryptor", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${CONFIG.LOOTLABS_API_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ destination_url: returnUrl })
                });
                const encJson = await encRes.json();
                if (encJson && encJson.message) {
                    encData = encJson.message;
                }
            } catch (e) {
                console.error("Lootlabs url_encryptor error:", e);
            }
        }

        if (encData) {
            destinationUrl = `${linkBase}&data=${encData}&puid=${encodeURIComponent(sessionId)}`;
        } else {
            destinationUrl = `${linkBase}&puid=${encodeURIComponent(sessionId)}`;
        }
    } else {
        const linkBase = CONFIG.LINKVERTISE_LINKS[step - 1] || CONFIG.LINKVERTISE_LINKS[0];
        if (linkBase.includes("DEMO_")) {
            return res.send(renderDemoSimulator(step, provider, hwid, returnUrl));
        }
        destinationUrl = linkBase;
    }

    res.setHeader("Set-Cookie", `fh_token=${encodeURIComponent(signedToken)}; Path=/; Max-Age=1800; SameSite=Lax; Secure`);
    return res.redirect(302, destinationUrl);
});

// 6. Checkpoint Verify
app.get("/checkpoint/verify", async (req, res) => {
    const baseUrl = getBaseUrl(req);
    let signedToken = req.query.token;
    if (!signedToken && req.headers.cookie) {
        const match = req.headers.cookie.match(/fh_token=([^;]+)/);
        if (match) signedToken = decodeURIComponent(match[1]);
    }

    if (!signedToken) {
        return res.status(403).send(renderSecurityRejection("Missing session token. Please ensure cookies are enabled and start over."));
    }

    const session = verifyAndDecodeData(signedToken, CONFIG.SIGNING_SECRET);
    if (!session) {
        return res.status(403).send(renderSecurityRejection("Invalid or tampered token."));
    }

    const sessionResult = await db.execute({
        sql: "SELECT * FROM sessions WHERE sid = ?",
        args: [session.sid]
    });

    if (sessionResult.rows.length === 0) {
        return res.status(403).send(renderSecurityRejection("Session expired or already used. Please start over.", session.hwid));
    }

    // Linkvertise hash verification
    const hash = req.query.hash;
    if (session.provider === "linkvertise" && CONFIG.LINKVERTISE_ANTI_BYPASS_TOKEN) {
        if (!hash) {
            return res.status(403).send(renderSecurityRejection("Linkvertise anti-bypass verification failed: Missing completion hash.", session.hwid));
        }
        try {
            const lvApiUrl = `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${encodeURIComponent(CONFIG.LINKVERTISE_ANTI_BYPASS_TOKEN)}&hash=${encodeURIComponent(String(hash))}`;
            const lvRes = await fetch(lvApiUrl, { method: "POST" });
            const lvText = await lvRes.text();
            if (!lvText.includes("TRUE") && !lvText.includes("true")) {
                return res.status(403).send(renderSecurityRejection("Linkvertise verification failed: Invalid completion hash.", session.hwid));
            }
        } catch (e) {
            console.error("Linkvertise verification error:", e);
        }
    }

    // LootLabs postback verification
    if (session.provider === "lootlabs") {
        let convResult = await db.execute({
            sql: "SELECT * FROM conversions WHERE click_id = ?",
            args: [session.sid]
        });
        if (convResult.rows.length === 0) {
            // Grace delay
            await new Promise(r => setTimeout(r, 2500));
            convResult = await db.execute({
                sql: "SELECT * FROM conversions WHERE click_id = ?",
                args: [session.sid]
            });
        }

        if (convResult.rows.length === 0) {
            return res.status(403).send(renderSecurityRejection("LootLabs task completion could not be verified by server. Bypass detected.", session.hwid));
        }

        const convRow = convResult.rows[0];
        if (convRow && convRow.received_at) {
            const solveDuration = Number(convRow.received_at) - session.issuedAt;
            if (solveDuration < 15) {
                return res.status(403).send(renderSecurityRejection(`Task was completed unnaturally fast (${solveDuration}s). Automated bypass detected.`, session.hwid));
            }
        }
    }

    // Time-Lock check
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsedSec = nowSec - session.issuedAt;
    if (elapsedSec < CONFIG.MIN_WAIT_SECONDS) {
        return res.status(403).send(renderSecurityRejection(`You completed this checkpoint too fast (${elapsedSec}s). Please wait at least ${CONFIG.MIN_WAIT_SECONDS}s.`, session.hwid));
    }

    await db.execute({
        sql: "DELETE FROM sessions WHERE sid = ?",
        args: [session.sid]
    });

    const currentStep = session.step;
    if (currentStep < 3) {
        const nextStep = currentStep + 1;
        return res.send(renderNextStepTransition(session.hwid, session.provider, nextStep));
    }

    // Generate 24h self-healing signed key
    const expiresDate = new Date(Date.now() + CONFIG.KEY_DURATION_HOURS * 3600 * 1000);
    const isGenericHwid = !session.hwid || session.hwid === "DEFAULT_USER" || session.hwid === "UNSET" || session.hwid === "UNBOUND" || session.hwid.startsWith("WEB_");
    const finalHwid = isGenericHwid ? "UNBOUND" : session.hwid;
    const newKey = generateSignedKey(finalHwid, expiresDate.getTime(), "24h");
    const nowIso = new Date().toISOString();
    const expiresIso = expiresDate.toISOString();

    await db.execute({
        sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider) VALUES (?, ?, ?, ?, 1, '24h', ?)",
        args: [newKey, finalHwid, nowIso, expiresIso, session.provider]
    });

    res.setHeader("Set-Cookie", `fh_token=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    return res.redirect(302, `${baseUrl}/?key=${encodeURIComponent(newKey)}&hwid=${encodeURIComponent(session.hwid)}`);
});

// 7. LootLabs Postback Webhook
app.all("/api/lootlabs/postback", async (req, res) => {
    const params = { ...req.query, ...(req.body || {}) };
    const puid = String(params.puid || params.PUID || "");
    const clickId = String(params.click_id || params.clickId || params.CLICK_ID || "");
    const ip = String(params.ip || params.IP || "");
    const uniqueId = String(params.unique_id || params.uniqueId || params.UNIQUE_ID || "");

    const targetId = puid || clickId;
    if (!targetId) {
        return res.status(400).send("Missing click_id or puid");
    }

    const receivedTimeSec = Math.floor(Date.now() / 1000);

    // Save with primary identifier (puid matches our session.sid)
    await db.execute({
        sql: "INSERT OR REPLACE INTO conversions (click_id, ip, unique_id, received_at) VALUES (?, ?, ?, ?)",
        args: [targetId, ip, uniqueId, receivedTimeSec]
    });

    // If both puid and clickId are present, insert both to guarantee lookup match
    if (clickId && clickId !== targetId) {
        await db.execute({
            sql: "INSERT OR REPLACE INTO conversions (click_id, ip, unique_id, received_at) VALUES (?, ?, ?, ?)",
            args: [clickId, ip, uniqueId, receivedTimeSec]
        });
    }

    console.log(`[+] LootLabs postback verified and recorded for: ${targetId}`);
    return res.status(200).send("OK");
});

// 8. Admin API (Key Generation & Maintenance)
app.post("/admin/key", async (req, res) => {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { action, key, hwid, hours, maintenance } = req.body;

    if (action === "create_key") {
        const duration = hours || 24;
        const nowIso = new Date().toISOString();
        const expiresMs = Date.now() + duration * 3600 * 1000;
        const expiresIso = new Date(expiresMs).toISOString();
        const finalHwid = hwid || "UNSET";
        const createdKey = key || generateSignedKey(finalHwid, expiresMs, "admin");

        await db.execute({
            sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider) VALUES (?, ?, ?, ?, 1, 'admin', 'admin')",
            args: [createdKey, finalHwid, nowIso, expiresIso]
        });

        return res.status(200).json({
            success: true,
            key: createdKey,
            data: { hwid: finalHwid, created: nowIso, expires: expiresIso, active: true, tier: "admin" }
        });
    }

    if (action === "set_maintenance") {
        const maintVal = maintenance ? "true" : "false";
        await db.execute({
            sql: "INSERT OR REPLACE INTO system_config (key, value) VALUES ('MAINTENANCE', ?)",
            args: [maintVal]
        });
        SCRIPT_CACHE.maintenance = !!maintenance;
        return res.status(200).json({ success: true, maintenance: SCRIPT_CACHE.maintenance });
    }

    return res.status(400).json({ error: "Invalid action" });
});

// 9. Instant Script Deployment API (Replaces Wrangler KV deploy)
app.post("/api/deploy", async (req, res) => {
    const authHeader = req.headers["authorization"] || "";
    if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { version, payload } = req.body;
    if (!version || !payload) {
        return res.status(400).json({ error: "Missing version or payload" });
    }

    try {
        const nowIso = new Date().toISOString();

        // Save payload
        await db.execute({
            sql: "INSERT OR REPLACE INTO payloads (version, payload, updated_at) VALUES (?, ?, ?)",
            args: [version, payload, nowIso]
        });

        // Set current version
        await db.execute({
            sql: "INSERT OR REPLACE INTO system_config (key, value) VALUES ('CURRENT_VERSION', ?)",
            args: [version]
        });

        // Update in-memory cache instantly
        SCRIPT_CACHE.version = version;
        SCRIPT_CACHE.payload = payload;

        console.log(`[+] DEPLOY SUCCESS: Version ${version} deployed (${payload.length} chars)`);

        return res.status(200).json({
            success: true,
            version: version,
            bytes: payload.length,
            message: `Version ${version} is now 100% active globally!`
        });
    } catch (err) {
        console.error("[-] Deployment error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 10. Clean Dark Mode Key System Portal
app.get(["/", "/getkey"], async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const hwidParam = String(req.query.hwid || "");
    const keyParam = String(req.query.key || "");
    let activeKey = keyParam;
    let keyInfo = null;

    const nowIso = new Date().toISOString();

    if (hwidParam && !activeKey) {
        const rowRes = await db.execute({
            sql: "SELECT * FROM keys WHERE hwid = ? AND active = 1 AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
            args: [hwidParam, nowIso]
        });
        if (rowRes.rows.length > 0) {
            keyInfo = rowRes.rows[0];
            activeKey = String(keyInfo.key);
        }
    } else if (activeKey) {
        const rowRes = await db.execute({
            sql: "SELECT * FROM keys WHERE key = ?",
            args: [activeKey]
        });
        if (rowRes.rows.length > 0) {
            keyInfo = rowRes.rows[0];
        } else {
            // Self-healing check for stateless signed key
            const verified = decodeAndVerifyKey(activeKey, CONFIG.SIGNING_SECRET);
            if (verified && verified.valid) {
                const nowIsoStr = new Date().toISOString();
                const expIsoStr = verified.expires_at;
                try {
                    await db.execute({
                        sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider) VALUES (?, ?, ?, ?, 1, ?, 'checkpoint_restore')",
                        args: [activeKey, verified.hwid, nowIsoStr, expIsoStr, verified.tier]
                    });
                    keyInfo = {
                        key: activeKey,
                        hwid: verified.hwid,
                        created_at: nowIsoStr,
                        expires_at: expIsoStr,
                        active: 1,
                        tier: verified.tier,
                        provider: 'checkpoint_restore'
                    };
                } catch (e) {
                    console.error("[-] Failed to restore signed key in portal:", e);
                }
            }
        }
    }

    function formatRemainingTime(info) {
        if (!info) return "24h left";
        const tier = String(info.tier || "").toLowerCase();
        if (tier === "permanent" || tier === "admin" || tier === "lifetime") {
            return "Permanent / Lifetime";
        }

        const expiresVal = info.expires_at || info.expires;
        if (!expiresVal) return "24h left";

        const diffMs = new Date(String(expiresVal)).getTime() - Date.now();
        if (diffMs <= 0) return "Expired";

        const totalSeconds = Math.floor(diffMs / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        if (days > 365) {
            return "Permanent / Lifetime";
        }
        if (days > 30) {
            const months = Math.floor(days / 30);
            const remDays = days % 30;
            return remDays > 0 ? `${months}mo ${remDays}d left` : `${months}mo left`;
        }
        if (days > 0) {
            return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
        }
        if (hours > 0) {
            return `${hours}h ${minutes}m left`;
        }
        return `${Math.max(1, minutes)}m left`;
    }

    const remainingTimeStr = formatRemainingTime(keyInfo);

    const loaderCode = `getgenv().Key = "${activeKey || "PASTE_KEY_HERE"}"
getgenv().Webhook = "YOUR_WEBHOOK" -- (Optional)
loadstring(game:HttpGet("${baseUrl}/loader"))()`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPortalHtml(activeKey, remainingTimeStr, loaderCode, hwidParam));
});

// ==================== HTML TEMPLATES ====================
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderPortalHtml(activeKey, remainingTimeStr, loaderCode, hwidParam) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FruitsHub Key System</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0b0e14;
      --bg-secondary: #0f131a;
      --bg-card: #121620;
      --border-subtle: rgba(255, 255, 255, 0.07);
      --border-active: rgba(56, 189, 248, 0.35);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-tertiary: #64748b;
      --accent-cyan: #38bdf8;
      --accent-green: #22c55e;
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      --radius-md: 10px;
      --radius-lg: 14px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .ambient-glow {
      position: fixed;
      border-radius: 50%;
      pointer-events: none;
      z-index: 0;
      filter: blur(120px);
    }
    .glow-top {
      top: -150px;
      left: 50%;
      transform: translateX(-50%);
      width: 600px;
      height: 350px;
      background: radial-gradient(circle, rgba(56, 189, 248, 0.08) 0%, rgba(11, 14, 20, 0) 70%);
    }
    .navbar {
      position: sticky;
      top: 0;
      width: 100%;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      background: rgba(11, 14, 20, 0.8);
      border-bottom: 1px solid var(--border-subtle);
      z-index: 100;
    }
    .nav-container {
      max-width: 760px;
      margin: 0 auto;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      font-weight: 700;
      font-size: 0.95rem;
      letter-spacing: 0.08em;
      color: var(--accent-cyan);
      text-decoration: none;
    }
    .nav-tag {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }
    .nav-tag.green {
      color: var(--accent-green);
      border-color: rgba(34, 197, 94, 0.25);
      background: rgba(34, 197, 94, 0.06);
    }
    .container {
      width: 100%;
      max-width: 760px;
      margin: 40px auto;
      padding: 0 24px;
      position: relative;
      z-index: 1;
      flex: 1;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 32px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
    }
    .card-title {
      font-size: 1.45rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 6px;
    }
    .card-desc {
      color: var(--text-secondary);
      font-size: 0.92rem;
      margin-bottom: 24px;
    }
    .info-label {
      font-size: 0.75rem;
      font-family: var(--font-mono);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
      display: block;
    }
    .code-box {
      background: #080a0f;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 12px 16px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--accent-cyan);
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-width: 0;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 18px;
      border-radius: var(--radius-md);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s ease;
      border: none;
      font-family: var(--font-sans);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .btn-primary {
      background: var(--accent-cyan);
      color: #061218;
      box-shadow: 0 4px 12px rgba(56, 189, 248, 0.2);
    }
    .btn-primary:hover {
      background: #7dd3fc;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .provider-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-top: 16px;
    }
    @media (max-width: 540px) {
      .provider-grid { grid-template-columns: 1fr; }
    }
    .provider-card {
      background: #0e121a;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 20px;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: all 0.2s ease;
    }
    .provider-card:hover {
      border-color: var(--border-active);
      background: #111722;
      transform: translateY(-2px);
    }
    .provider-badge {
      font-size: 0.72rem;
      font-family: var(--font-mono);
      color: var(--accent-cyan);
      margin-bottom: 6px;
    }
    .provider-title {
      font-size: 1.05rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    .provider-sub {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-bottom: 16px;
    }
    .footer {
      text-align: center;
      padding: 24px;
      font-size: 0.8rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }
  </style>
</head>
<body>
  <div class="ambient-glow glow-top"></div>

  <header class="navbar">
    <div class="nav-container">
      <a href="/" class="brand">FRUITSHUB</a>
      <span class="nav-tag ${activeKey ? "green" : ""}">
        ${activeKey ? "Key Active" : "Key System"}
      </span>
    </div>
  </header>

  <main class="container">
    ${activeKey ? `
      <!-- Active Key Screen -->
      <div class="card">
        <h1 class="card-title">Key Active</h1>
        <p class="card-desc">You already have a valid key for this device (${remainingTimeStr}).</p>

        <div style="margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="info-label" style="margin-bottom: 0;">Your Key</span>
            <button class="btn btn-secondary" style="padding: 6px 14px; font-size: 0.78rem;" onclick="copyText('raw-key', this)">Copy Key</button>
          </div>
          <div class="code-box" style="margin-bottom: 0; padding: 12px 16px;">
            <span id="raw-key" style="font-weight: 600; color: var(--accent-cyan); font-size: 0.9rem; user-select: all;">${activeKey}</span>
          </div>
        </div>

        <div style="margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="info-label" style="margin-bottom: 0;">Roblox Loader</span>
            <button class="btn btn-primary" style="padding: 6px 16px; font-size: 0.78rem;" onclick="copyText('raw-loader', this)">Copy Loader</button>
          </div>
          <div class="code-box" style="margin-bottom: 0; padding: 14px 16px; display: block;">
            <pre id="raw-loader" style="margin: 0; font-family: var(--font-mono); font-size: 0.82rem; line-height: 1.6; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; user-select: all;">${escapeHtml(loaderCode)}</pre>
          </div>
        </div>
      </div>
    ` : `
      <!-- Selection Screen -->
      <div class="card">
        <h1 class="card-title">FruitsHub Key System</h1>
        <p class="card-desc">Complete 3 checkpoints to get your 24-hour key.</p>

        ${hwidParam ? `
          <span class="info-label">Hardware ID</span>
          <div class="code-box" style="margin-bottom: 24px;">
            <span style="font-size: 0.8rem; color: #cbd5e1;">${escapeHtml(hwidParam)}</span>
          </div>
        ` : ""}

        <span class="info-label">Choose Provider</span>
        <div class="provider-grid">
          <!-- LootLabs -->
          <a href="/checkpoint/start?provider=lootlabs&hwid=${encodeURIComponent(hwidParam || "DEFAULT_USER")}" class="provider-card">
            <div>
              <div class="provider-badge">Recommended</div>
              <div class="provider-title">LootLabs</div>
              <div class="provider-sub">3 Quick Checkpoints</div>
            </div>
            <div class="btn btn-primary" style="width: 100%; font-size: 0.82rem; padding: 10px;">Get Key via LootLabs</div>
          </a>

          <!-- Linkvertise -->
          <a href="/checkpoint/start?provider=linkvertise&hwid=${encodeURIComponent(hwidParam || "DEFAULT_USER")}" class="provider-card">
            <div>
              <div class="provider-badge" style="color: var(--text-tertiary);">Alternative</div>
              <div class="provider-title">Linkvertise</div>
              <div class="provider-sub">3 Standard Checkpoints</div>
            </div>
            <div class="btn btn-secondary" style="width: 100%; font-size: 0.82rem; padding: 10px;">Get Key via Linkvertise</div>
          </a>
        </div>
      </div>
    `}
  </main>

  <footer class="footer">
    FruitsHub &copy; 2026
  </footer>

  <script>
    (function() {
      const urlParams = new URLSearchParams(window.location.search);
      if (!urlParams.get("hwid") && !urlParams.get("key")) {
        let devId = localStorage.getItem("fh_device_id");
        if (!devId) {
          devId = "WEB_" + Math.random().toString(36).substring(2, 10);
          localStorage.setItem("fh_device_id", devId);
        }
        document.querySelectorAll("a[href*='hwid=']").forEach(a => {
          a.href = a.href.replace("hwid=DEFAULT_USER", "hwid=" + encodeURIComponent(devId));
        });
      }
    })();

    function copyText(elemId, btn) {
      const text = document.getElementById(elemId).innerText;
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.innerText;
        btn.innerText = "Copied!";
        setTimeout(() => btn.innerText = old, 1500);
      });
    }
  </script>
</body>
</html>`;
}

function renderDemoSimulator(step, provider, hwid, returnUrl) {
    const minWait = CONFIG.MIN_WAIT_SECONDS;
    const providerName = provider === "lootlabs" ? "LootLabs" : "Linkvertise";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Checkpoint ${step}/3 (Simulation) — FruitsHub</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0e14;
      --card: #121620;
      --border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --text: #f1f5f9;
      --muted: #94a3b8;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; max-width: 480px; width: 100%; padding: 36px 32px; text-align: center; box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
    .badge { display: inline-block; font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; padding: 4px 10px; border-radius: 6px; background: rgba(56, 189, 248, 0.1); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.2); margin-bottom: 16px; letter-spacing: 0.05em; }
    h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 8px; color: #fff; }
    p { color: var(--muted); font-size: 0.88rem; margin-bottom: 24px; line-height: 1.5; }
    .timer-container { margin: 28px 0; }
    .timer-circle { font-family: 'JetBrains Mono', monospace; font-size: 2.4rem; font-weight: 700; color: var(--accent); margin-bottom: 12px; }
    .progress-bar-wrap { background: #080a0f; border-radius: 8px; height: 8px; overflow: hidden; margin-bottom: 24px; border: 1px solid rgba(255,255,255,0.05); }
    .progress-bar-fill { height: 100%; background: var(--accent); width: 0%; transition: width 1s linear; }
    .btn { display: inline-block; width: 100%; background: rgba(255,255,255,0.06); color: #64748b; padding: 12px 20px; border-radius: 8px; font-weight: 700; text-decoration: none; font-size: 0.88rem; box-sizing: border-box; cursor: not-allowed; transition: all 0.2s ease; border: none; font-family: 'Plus Jakarta Sans', sans-serif; }
    .btn.ready { background: var(--accent); color: #061218; cursor: pointer; box-shadow: 0 4px 14px rgba(56, 189, 248, 0.25); }
    .btn.ready:hover { background: #7dd3fc; }
    .info-sub { font-size: 0.75rem; color: #64748b; margin-top: 16px; font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">SIMULATION MODE · CHECKPOINT ${step} OF 3</div>
    <h1>Simulating ${providerName}</h1>
    <p>Testing gateway and anti-bypass time verification. Please wait for the countdown to verify your checkpoint.</p>
    
    <div class="timer-container">
      <div class="timer-circle" id="timer-val">${minWait}s</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
    </div>

    <a id="action-btn" href="#" class="btn">Please wait ${minWait}s...</a>
    <div class="info-sub">Server Time-Lock: ${minWait}s minimum enforced</div>
  </div>

  <script>
    const totalTime = ${minWait};
    let timeLeft = totalTime;
    const returnUrl = ${JSON.stringify(returnUrl)};
    const timerElem = document.getElementById("timer-val");
    const fillElem = document.getElementById("progress-fill");
    const btn = document.getElementById("action-btn");

    const timer = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        clearInterval(timer);
        timerElem.innerText = "Verified!";
        timerElem.style.color = "#22c55e";
        fillElem.style.width = "100%";
        btn.classList.add("ready");
        btn.innerText = "Continue to ${step < 3 ? 'Checkpoint ' + (step + 1) : 'Your 24h Key'} →";
        btn.href = returnUrl;
        setTimeout(() => {
          window.location.href = returnUrl;
        }, 600);
      } else {
        timerElem.innerText = timeLeft + "s";
        fillElem.style.width = (((totalTime - timeLeft) / totalTime) * 100) + "%";
        btn.innerText = "Please wait " + timeLeft + "s...";
      }
    }, 1000);
  </script>
</body>
</html>`;
}

function renderNextStepTransition(hwid, provider, nextStep) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Checkpoint ${nextStep}/3 — FruitsHub</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    body { background: #0b0e14; color: #f1f5f9; font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { background: #121620; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; max-width: 480px; width: 100%; padding: 32px; text-align: center; box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
    h1 { font-size: 1.3rem; margin-bottom: 8px; color: #fff; }
    p { color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px; }
    .progress { background: #080a0f; border-radius: 6px; height: 6px; overflow: hidden; margin-bottom: 24px; }
    .progress-bar { height: 100%; background: #38bdf8; width: ${((nextStep - 1) / 3) * 100}%; }
    .btn { display: inline-block; width: 100%; background: #38bdf8; color: #061218; padding: 12px 20px; border-radius: 8px; font-weight: 700; text-decoration: none; font-size: 0.88rem; box-sizing: border-box; }
    .btn:hover { background: #7dd3fc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Checkpoint ${nextStep} of 3</h1>
    <p>Step ${nextStep - 1} completed. Click below to continue.</p>
    <div class="progress">
      <div class="progress-bar"></div>
    </div>
    <a href="/checkpoint/start?provider=${encodeURIComponent(provider)}&step=${nextStep}&hwid=${encodeURIComponent(hwid)}" class="btn">Continue to Checkpoint ${nextStep}</a>
  </div>
</body>
</html>`;
}

function renderSecurityRejection(message, hwid) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Verification Failed — FruitsHub</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700&display=swap" rel="stylesheet">
  <style>
    body { background: #0b0e14; color: #f1f5f9; font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { background: #141013; border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 14px; max-width: 480px; width: 100%; padding: 32px; text-align: center; }
    h1 { font-size: 1.3rem; color: #f87171; margin-bottom: 8px; }
    p { color: #cbd5e1; font-size: 0.88rem; margin-bottom: 24px; line-height: 1.5; }
    .btn { display: inline-block; background: rgba(255,255,255,0.06); color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-size: 0.85rem; border: 1px solid rgba(255,255,255,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Verification Failed</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/?hwid=${encodeURIComponent(hwid || "")}" class="btn">Try Again</a>
  </div>
</body>
</html>`;
}

// ==================== START SERVER ====================
async function start() {
    await initDatabase();
    await reloadScriptCache();

    app.listen(CONFIG.PORT, () => {
        console.log(`
============================================================
  FruitsHub Delivery & Key Gateway Server Running
  Port: ${CONFIG.PORT}
  Environment: ${process.env.NODE_ENV || "development"}
  Active Version: ${SCRIPT_CACHE.version}
  Keep-Alive Ping: /ping
============================================================
        `);
    });
}

start().catch(err => {
    console.error("[-] Failed to start FruitsHub server:", err);
    process.exit(1);
});
