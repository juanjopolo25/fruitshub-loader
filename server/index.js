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
    ADMIN_SECRET: process.env.ADMIN_SECRET || "Juanjonosoy0//////",
    SIGNING_SECRET: process.env.SIGNING_SECRET || "FH_SEC_98f12a4b8c3d7e502164a3e8b09c1d2e",
    MIN_WAIT_SECONDS: parseInt(process.env.MIN_WAIT_SECONDS || "20", 10),
    KEY_DURATION_HOURS: parseInt(process.env.KEY_DURATION_HOURS || "24", 10),

    // Checkpoints (LootLabs / Linkvertise)
    LOOTLABS_LINKS: process.env.LOOTLABS_LINKS
        ? process.env.LOOTLABS_LINKS.split(",").map(s => s.trim())
        : [
            "https://lootdest.org/s?EdniakIO",
            "https://lootdest.org/s?U600KxJF",
            "https://loot-link.com/s?zGYj3R28"
        ],
    LINKVERTISE_LINKS: process.env.LINKVERTISE_LINKS
        ? process.env.LINKVERTISE_LINKS.split(",").map(s => s.trim())
        : [
            "https://link-target.net/574428/A2fuRuJEclPX",
            "https://link-hub.net/574428/DvFSlMdED1NU",
            "https://link-hub.net/574428/yrlFgIJxxrV6"
        ],
    LINKVERTISE_ANTI_BYPASS_TOKEN: process.env.LINKVERTISE_ANTI_BYPASS_TOKEN || "5626539749ba412c89d2205aeaba20de2db3d5b424ce54316cfcaeff5db171dd",
    LOOTLABS_API_TOKEN: process.env.LOOTLABS_API_TOKEN || "44428ecb0e20867a52d71095dba347fe128ad34dd7208a23f324ee237e7f2e76",

    // Discord Integration & Gate
    DISCORD: {
        CLIENT_ID: process.env.DISCORD_CLIENT_ID || "1547671159116529794",
        CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || Buffer.from("Q3FYNWFKdTB0S0RLZ2F6U0VYbzdqbkZ2bHdwOGtNWEc=", "base64").toString("utf-8"),
        BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || Buffer.from("TVRVME56WTNNVEUxT1RFeE5qVXlPVGM1TkEuR1V3Ykw1Ll9qNDFaLU1CcmdMTkR6X0VIcGRHczdpTHBfeDBna2R6V2pYYVpJ", "base64").toString("utf-8"),
        GUILD_ID: process.env.DISCORD_GUILD_ID || "1547661185351024701",
        REQUIRED_ROLE_ID: process.env.DISCORD_REQUIRED_ROLE_ID || "1547661710436073582",
        GRANTED_ROLE_ID: process.env.DISCORD_GRANTED_ROLE_ID || "1547673995799961701",
        INVITE_URL: process.env.DISCORD_INVITE_URL || "https://discord.gg/sM48AW4gn2",
        VAULTCORD_URL: process.env.DISCORD_VAULTCORD_URL || "https://discord.com/oauth2/authorize?client_id=1547663824960749638&redirect_uri=https://vaultcord.win/auth&response_type=code&scope=identify+guilds.join&state=130009&prompt=none"
    }
};

// ==================== DATABASE INITIALIZATION ====================
// Supports both local file SQLite and remote Turso cloud database
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbUrl = process.env.TURSO_DATABASE_URL || "libsql://fruitshub-juanjopolo25.aws-ap-northeast-1.turso.io";
const dbAuthToken = process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODg5NTUxNzIsImlkIjoiMDFhMDg2MDktNDIwMS03YzNjLThiOGYtY2E0NWEyMDY2MWNmIiwia2lkIjoiM2J4RFc3R0lCS0dhWDFWV3h3YWFmQ1AxMm1aaXd6dXVmOUY5WW9iTjVLayIsInJpZCI6ImQwMjg3M2NhLWU3MTUtNDI4MS04NDk0LWQ1ODcxNTc1MmFkNCJ9.0DGWilrthpwMxAAHvghYLwyqsjF8VXsUKYuKV6m7PiLwOmJqljLKFbL-ErgrfWJJwv3TUq5rv-hiSjzg2zdtCA";

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

    // Execution logs for real-time telemetry and executor analytics
    await db.execute(`
        CREATE TABLE IF NOT EXISTS execution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT,
            hwid TEXT,
            executor TEXT DEFAULT 'Unknown',
            status TEXT DEFAULT 'success',
            ip TEXT,
            created_at INTEGER
        );
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exec_logs_created ON execution_logs (created_at);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exec_logs_executor ON execution_logs (executor);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exec_logs_key ON execution_logs (key);`);

    // Safe schema migrations for existing keys table
    try {
        await db.execute(`ALTER TABLE keys ADD COLUMN executions_count INTEGER DEFAULT 0;`);
    } catch (e) {
        // Column already exists
    }
    try {
        await db.execute(`ALTER TABLE keys ADD COLUMN note TEXT DEFAULT '';`);
    } catch (e) {
        // Column already exists
    }
    try {
        await db.execute(`ALTER TABLE keys ADD COLUMN discord_id TEXT;`);
    } catch (e) {
        // Column already exists
    }
    try {
        await db.execute(`ALTER TABLE keys ADD COLUMN discord_tag TEXT;`);
    } catch (e) {
        // Column already exists
    }
    try {
        await db.execute(`ALTER TABLE sessions ADD COLUMN discord_id TEXT;`);
    } catch (e) {
        // Column already exists
    }
    try {
        await db.execute(`ALTER TABLE sessions ADD COLUMN discord_tag TEXT;`);
    } catch (e) {
        // Column already exists
    }

    // Seed persistent keys so they always exist on cold start
    const SEED_KEYS = [
        { key: "FH-3ab8d70d6553eec6d98601f4", hwid: "bf72f6f4b9edb5b605cd2014f07a1d25f7f35e263471106639d79b41127dc303", tier: "24h", hours: 48 },
        { key: "FH-3fdc72f8bbb5d38960e7bf35", hwid: "bf72f6f4b9edb5b605cd2014f07a1d25f7f35e263471106639d79b41127dc303", tier: "permanent", hours: 87600 },
        { key: "FH-N2IzODMyNDIzNDM4NDEzNDQxMmQ0NjQxMzQzMjJkMzQzMzQxMzAyZDQyNDEzNDQ2MmQ0NDQ0NDQzNzQzNDYzMzMyMzgzMzQ2MzM3ZDoxNzg5MDU5NjkwMDE1OjI0aDo4Yzg0OTg.d704356136083072", hwid: "7b38324234384134412d464134322d343341302d424134462d4444443743463332383346337d", tier: "24h", hours: 48 }
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

// ==================== DISCORD API HELPERS ====================
function getDiscordSession(req) {
    if (!req.headers || !req.headers.cookie) return null;
    const match = req.headers.cookie.match(/(?:^|;\s*)fh_discord=([^;]+)/);
    if (!match) return null;
    const session = verifyAndDecodeData(decodeURIComponent(match[1]), CONFIG.SIGNING_SECRET);
    if (!session || !session.id) return null;
    return session;
}

async function exchangeDiscordCode(code, redirectUri) {
    const params = new URLSearchParams();
    params.append("client_id", CONFIG.DISCORD.CLIENT_ID);
    params.append("client_secret", CONFIG.DISCORD.CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", redirectUri);

    const res = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Discord token exchange failed (${res.status}): ${errText}`);
    }
    return await res.json();
}

async function fetchDiscordUser(accessToken) {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Discord fetch user failed (${res.status}): ${errText}`);
    }
    return await res.json();
}

async function fetchGuildMember(discordUserId) {
    try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${CONFIG.DISCORD.GUILD_ID}/members/${discordUserId}`, {
            headers: { "Authorization": `Bot ${CONFIG.DISCORD.BOT_TOKEN}` }
        });
        if (res.status === 404) {
            return { inGuild: false, roles: [] };
        }
        if (!res.ok) {
            const errText = await res.text();
            console.error(`[-] Discord fetch member failed (${res.status}): ${errText}`);
            return { inGuild: false, roles: [], error: errText };
        }
        const member = await res.json();
        return { inGuild: true, roles: member.roles || [] };
    } catch (err) {
        console.error("[-] Discord fetch member network error:", err);
        return { inGuild: false, roles: [], error: err.message };
    }
}

async function grantDiscordRole(discordUserId, roleId) {
    try {
        const res = await fetch(`https://discord.com/api/v10/guilds/${CONFIG.DISCORD.GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bot ${CONFIG.DISCORD.BOT_TOKEN}`,
                "X-Audit-Log-Reason": "FruitsHub Key Portal Verification"
            }
        });
        if (res.status === 204 || res.status === 200) {
            console.log(`[+] Granted role ${roleId} to Discord user ${discordUserId}`);
            return true;
        }
        const errText = await res.text();
        console.error(`[-] Discord grant role error (${res.status}): ${errText}`);
        return false;
    } catch (err) {
        console.error("[-] Discord grant role network error:", err);
        return false;
    }
}

async function evaluateDiscordGate(discordUserId) {
    const member = await fetchGuildMember(discordUserId);
    if (!member.inGuild) {
        return { status: "NOT_IN_GUILD" };
    }
    const hasRequired = member.roles.includes(CONFIG.DISCORD.REQUIRED_ROLE_ID);
    if (!hasRequired) {
        return { status: "MISSING_REQUIRED_ROLE" };
    }
    // Has required role -> ensure delivery role is granted
    const hasGranted = member.roles.includes(CONFIG.DISCORD.GRANTED_ROLE_ID);
    if (!hasGranted) {
        await grantDiscordRole(discordUserId, CONFIG.DISCORD.GRANTED_ROLE_ID);
    }
    return { status: "VERIFIED" };
}

// ==================== EXPRESS APPLICATION ====================
const app = express();

// Middleware: Enable Gzip compression (reduces payload from ~213KB to ~45KB, saving 78% bandwidth)
app.use(compression());
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-FruitsHub-Key", "Cache-Control"]
}));
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

local function getClientExecutor()
    if identifyexecutor then
        local ok, n = pcall(identifyexecutor)
        if ok and n and tostring(n) ~= "" then return tostring(n) end
    elseif getexecutorname then
        local ok, n = pcall(getexecutorname)
        if ok and n and tostring(n) ~= "" then return tostring(n) end
    end
    return "Unknown"
end

local Key = tostring(getgenv().Key or getgenv().FruitsHubKey or ""):gsub("%s+", "")
local HWID = getClientHWID()
local EX = getClientExecutor()
local CachePath = "FruitsHub/cache_v2.luau"
local VerPath = "FruitsHub/version_v2.txt"

-- Purge stale legacy v1 cache if present on disk
pcall(function()
    if isfile and isfile("FruitsHub/cache_v1.luau") then
        if writefile then writefile("FruitsHub/cache_v1.luau", "") end
        if delfile then delfile("FruitsHub/cache_v1.luau") end
    end
    if isfile and isfile("FruitsHub/version.txt") then
        if writefile then writefile("FruitsHub/version.txt", "") end
        if delfile then delfile("FruitsHub/version.txt") end
    end
end)

local hasFs = (writefile and readfile and isfile) ~= nil
local localCached = hasFs and isfile(CachePath)
local cachedVersion = (hasFs and isfile(VerPath)) and readfile(VerPath) or "none"

local encEx = EX
pcall(function()
    local hs = game:GetService("HttpService")
    if hs and hs.UrlEncode then encEx = hs:UrlEncode(EX) end
end)

local requestUrl = string.format(
    "${baseUrl}/load?key=%s&hwid=%s&cv=%s&ex=%s",
    Key,
    HWID,
    localCached and cachedVersion or "none",
    encEx
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

// Helper to record execution events for telemetry & analytics
async function recordExecutionLog(keyStr, hwidStr, execStr, statusStr, ipStr) {
    try {
        await db.execute({
            sql: "INSERT INTO execution_logs (key, hwid, executor, status, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            args: [
                String(keyStr || "NONE").substring(0, 100),
                String(hwidStr || "UNKNOWN").substring(0, 120),
                String(execStr || "Unknown").substring(0, 60),
                String(statusStr || "unknown").substring(0, 30),
                String(ipStr || "0.0.0.0").substring(0, 50),
                Date.now()
            ]
        });
    } catch (e) {
        console.error("[-] Failed to record execution log:", e.message);
    }
}

// 4. Roblox Load Endpoint (Key Auth & Script Delivery)
app.get(["/load", "/load.luau"], async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const key = req.query.key ? String(req.query.key).trim() : "";
    const hwid = req.query.hwid ? String(req.query.hwid).trim() : "UNKNOWN_HWID";
    const clientVersion = req.query.cv ? String(req.query.cv).trim() : "";
    const rawEx = req.query.ex ? String(req.query.ex).trim() : "Unknown";
    const executor = rawEx.length > 50 ? rawEx.substring(0, 50) : rawEx;
    const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const keyUrl = `${baseUrl}/?hwid=${encodeURIComponent(hwid)}`;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("X-FruitsHub-Version", SCRIPT_CACHE.version);

    if (!key || key === "PASTE_KEY_HERE" || key === "nil" || key === "YOUR_KEY_HERE" || key === "") {
        recordExecutionLog("NONE", hwid, executor, "missing_key", clientIp);
        return res.status(200).send(generateKickResponse("FruitsHub: No access key provided. Key link has been copied to your clipboard.", keyUrl));
    }

    if (SCRIPT_CACHE.maintenance) {
        recordExecutionLog(key, hwid, executor, "maintenance", clientIp);
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
            recordExecutionLog(key, hwid, executor, "invalid_key", clientIp);
            return res.status(200).send(generateKickResponse("FruitsHub: Invalid key. Key link has been copied to your clipboard to generate a new one.", keyUrl));
        }

        if (!keyRow.active) {
            recordExecutionLog(key, hwid, executor, "deactivated", clientIp);
            return res.status(200).send(generateKickResponse("FruitsHub: This key has been deactivated or blacklisted."));
        }

        const expiresDate = keyRow.expires_at ? new Date(String(keyRow.expires_at)) : null;
        if (expiresDate && expiresDate < new Date()) {
            recordExecutionLog(key, hwid, executor, "expired", clientIp);
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
            recordExecutionLog(key, hwid, executor, "hwid_mismatch", clientIp);
            return res.status(200).send(generateKickResponse("FruitsHub: Key is locked to another device (HWID Mismatch). Each key is single-device.", keyUrl));
        }

        // Increment executions_count and update last_used
        await db.execute({
            sql: "UPDATE keys SET executions_count = COALESCE(executions_count, 0) + 1, last_used = ? WHERE key = ?",
            args: [nowIso, key]
        });

        // Record successful execution log
        recordExecutionLog(key, hwid, executor, "success", clientIp);

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

// ==================== DISCORD OAUTH2 & GATE ROUTES ====================

// Initiate Discord OAuth2 authorization
app.get("/api/auth/discord/login", (req, res) => {
    const baseUrl = getBaseUrl(req);
    const redirectUri = `${baseUrl}/api/auth/discord/callback`;
    const hwid = String(req.query.hwid || "");
    const stateData = {
        hwid: hwid,
        ts: Date.now()
    };
    const signedState = signData(stateData, CONFIG.SIGNING_SECRET);
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CONFIG.DISCORD.CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify&state=${encodeURIComponent(signedState)}`;
    return res.redirect(302, discordAuthUrl);
});

// Discord OAuth2 callback handler
app.get("/api/auth/discord/callback", async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const code = req.query.code;
    const stateRaw = req.query.state;
    let hwid = "";

    if (stateRaw) {
        const decodedState = verifyAndDecodeData(String(stateRaw), CONFIG.SIGNING_SECRET);
        if (decodedState && decodedState.hwid) {
            hwid = decodedState.hwid;
        }
    }

    if (!code) {
        return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}&auth_error=cancelled`);
    }

    try {
        const redirectUri = `${baseUrl}/api/auth/discord/callback`;
        const tokenData = await exchangeDiscordCode(code, redirectUri);
        const user = await fetchDiscordUser(tokenData.access_token);

        const discordUserSession = {
            id: String(user.id),
            username: user.global_name || user.username,
            tag: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username,
            avatar: user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
                : "https://cdn.discordapp.com/embed/avatars/0.png",
            ts: Date.now()
        };

        const signedSessionToken = signData(discordUserSession, CONFIG.SIGNING_SECRET);

        // Pre-evaluate gate (if they already qualify, assign the role immediately)
        try {
            await evaluateDiscordGate(discordUserSession.id);
        } catch (gateErr) {
            console.error("[-] Error evaluating Discord gate on callback:", gateErr);
        }

        res.setHeader("Set-Cookie", `fh_discord=${encodeURIComponent(signedSessionToken)}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`);
        return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}`);
    } catch (err) {
        console.error("[-] Discord OAuth callback error:", err);
        return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}&auth_error=oauth_failed`);
    }
});

// Re-check Discord status in real time
app.get("/api/auth/discord/recheck", async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const hwid = String(req.query.hwid || "");
    const discordUser = getDiscordSession(req);
    if (!discordUser) {
        return res.redirect(302, `${baseUrl}/api/auth/discord/login?hwid=${encodeURIComponent(hwid)}`);
    }

    try {
        await evaluateDiscordGate(discordUser.id);
    } catch (e) {
        console.error("[-] Error during Discord recheck:", e);
    }

    return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}&rechecked=1`);
});

// Logout from Discord session
app.get("/api/auth/discord/logout", (req, res) => {
    const baseUrl = getBaseUrl(req);
    const hwid = String(req.query.hwid || "");
    res.setHeader("Set-Cookie", `fh_discord=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}`);
});

// 5. Checkpoint Start
app.get("/checkpoint/start", async (req, res) => {
    const baseUrl = getBaseUrl(req);
    const hwid = String(req.query.hwid || "UNBOUND");
    const provider = String(req.query.provider || "lootlabs");
    const step = parseInt(String(req.query.step || "1"), 10);

    // Discord Gate Enforcement
    const discordUser = getDiscordSession(req);
    if (!discordUser) {
        return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}&error=discord_required`);
    }
    const gateCheck = await evaluateDiscordGate(discordUser.id);
    if (gateCheck.status !== "VERIFIED") {
        return res.redirect(302, `${baseUrl}/?hwid=${encodeURIComponent(hwid)}`);
    }

    const sessionId = crypto.randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = Math.random().toString(36).substring(2, 10);

    const tokenPayload = {
        sid: sessionId,
        hwid: hwid,
        provider: provider,
        step: step,
        issuedAt: issuedAt,
        nonce: nonce,
        discordId: discordUser.id,
        discordTag: discordUser.tag
    };

    const signedToken = signData(tokenPayload, CONFIG.SIGNING_SECRET);

    try {
        await db.execute({
            sql: "INSERT OR REPLACE INTO sessions (sid, hwid, provider, step, issued_at, nonce, created_at, discord_id, discord_tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            args: [sessionId, hwid, provider, step, issuedAt, nonce, issuedAt, discordUser.id, discordUser.tag]
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

    const dId = session.discordId || null;
    const dTag = session.discordTag || null;

    await db.execute({
        sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider, discord_id, discord_tag) VALUES (?, ?, ?, ?, 1, '24h', ?, ?, ?)",
        args: [newKey, finalHwid, nowIso, expiresIso, session.provider, dId, dTag]
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

// ==================== COMPREHENSIVE ADMIN API SUITE ====================

// Anti-bruteforce protection for admin login: max 5 failed attempts per 15 min per IP
const adminLoginAttempts = new Map();

function checkAdminLoginRateLimit(ip) {
    const now = Date.now();
    const entry = adminLoginAttempts.get(ip);
    if (entry) {
        if (now - entry.lastAttempt > 5 * 60 * 1000) {
            adminLoginAttempts.delete(ip);
            return true;
        }
        if (entry.count >= 25) {
            return false;
        }
    }
    return true;
}

function recordAdminFailedLogin(ip) {
    const now = Date.now();
    const entry = adminLoginAttempts.get(ip) || { count: 0, lastAttempt: now };
    entry.count++;
    entry.lastAttempt = now;
    adminLoginAttempts.set(ip, entry);
}

function clearAdminLoginRateLimit(ip) {
    adminLoginAttempts.delete(ip);
}

// Strict Admin Auth Middleware
function requireAdminAuth(req, res, next) {
    const authHeader = req.headers["authorization"] || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
    } else if (authHeader) {
        token = authHeader.trim();
    }

    if (!token && req.query && req.query.admin_token) {
        token = String(req.query.admin_token).trim();
    }

    if (!token) {
        return res.status(401).json({ error: "Unauthorized: Missing admin credentials" });
    }

    // Direct match with ADMIN_SECRET
    if (token === CONFIG.ADMIN_SECRET) {
        return next();
    }

    // Signed admin session token verification
    const sessionData = verifyAndDecodeData(token, CONFIG.SIGNING_SECRET);
    if (sessionData && sessionData.admin === true) {
        // Valid session for 7 days
        if (Date.now() - (sessionData.created_at || 0) < 7 * 24 * 3600 * 1000) {
            return next();
        }
    }

    return res.status(401).json({ error: "Unauthorized: Invalid or expired admin credentials" });
}

// 8.1 Admin Login
app.post("/api/admin/login", (req, res) => {
    const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!checkAdminLoginRateLimit(clientIp)) {
        return res.status(429).json({ error: "Too many failed attempts. Please try again in 15 minutes." });
    }

    const secret = req.body.secret || req.body.password || "";
    if (secret !== CONFIG.ADMIN_SECRET) {
        recordAdminFailedLogin(clientIp);
        return res.status(401).json({ error: "Invalid admin secret" });
    }

    clearAdminLoginRateLimit(clientIp);
    const sessionToken = signData({ admin: true, created_at: Date.now() }, CONFIG.SIGNING_SECRET);
    return res.status(200).json({ success: true, token: sessionToken });
});

// 8.2 Admin Verify Session
app.get("/api/admin/verify", requireAdminAuth, (req, res) => {
    return res.status(200).json({ success: true, admin: true });
});

// 8.3 Admin Dashboard Overview KPIs
app.get("/api/admin/overview", requireAdminAuth, async (req, res) => {
    try {
        const nowIso = new Date().toISOString();
        const yesterdayMs = Date.now() - 24 * 3600 * 1000;

        // Total keys
        const totalKeysRes = await db.execute("SELECT COUNT(*) as count FROM keys;");
        const totalKeys = Number(totalKeysRes.rows[0]?.count || 0);

        // Active keys
        const activeKeysRes = await db.execute({
            sql: "SELECT COUNT(*) as count FROM keys WHERE active = 1 AND (expires_at > ? OR tier IN ('permanent', 'lifetime', 'admin'));",
            args: [nowIso]
        });
        const activeKeys = Number(activeKeysRes.rows[0]?.count || 0);

        // Total executions (sum of executions_count from keys)
        const totalExecsRes = await db.execute("SELECT SUM(COALESCE(executions_count, 0)) as total FROM keys;");
        let totalExecs = Number(totalExecsRes.rows[0]?.total || 0);

        // Also check count of successful logs in execution_logs
        const totalLogsRes = await db.execute("SELECT COUNT(*) as total FROM execution_logs WHERE status = 'success';");
        const totalLogs = Number(totalLogsRes.rows[0]?.total || 0);
        if (totalLogs > totalExecs) totalExecs = totalLogs;

        // Executions today (last 24h)
        const todayExecsRes = await db.execute({
            sql: "SELECT COUNT(*) as count FROM execution_logs WHERE created_at > ? AND status = 'success';",
            args: [yesterdayMs]
        });
        const todayExecs = Number(todayExecsRes.rows[0]?.count || 0);

        // Top 5 Executors
        const topExecutorsRes = await db.execute(`
            SELECT executor, COUNT(*) as count 
            FROM execution_logs 
            WHERE status = 'success'
            GROUP BY executor 
            ORDER BY count DESC 
            LIMIT 5;
        `);
        const topExecutors = topExecutorsRes.rows.map(r => ({
            executor: String(r.executor || "Unknown"),
            count: Number(r.count || 0)
        }));

        return res.status(200).json({
            success: true,
            kpi: {
                totalKeys,
                activeKeys,
                totalExecutions: totalExecs,
                todayExecutions: todayExecs,
                maintenance: SCRIPT_CACHE.maintenance,
                activeVersion: SCRIPT_CACHE.version
            },
            topExecutors
        });
    } catch (err) {
        console.error("[-] Overview KPI error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.4 Keys Management: List & Filter Keys
app.get("/api/admin/keys", requireAdminAuth, async (req, res) => {
    try {
        const search = String(req.query.search || "").trim();
        const status = String(req.query.status || "all").toLowerCase();
        const tier = String(req.query.tier || "all").toLowerCase();
        const page = Math.max(1, parseInt(req.query.page || "1", 10));
        const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || "50", 10)));
        const offset = (page - 1) * limit;

        const nowIso = new Date().toISOString();
        const whereClauses = [];
        const args = [];

        if (search) {
            whereClauses.push("(key LIKE ? OR hwid LIKE ? OR note LIKE ? OR discord_tag LIKE ? OR discord_id LIKE ?)");
            const wild = `%${search}%`;
            args.push(wild, wild, wild, wild, wild);
        }

        if (status === "active") {
            whereClauses.push("(active = 1 AND (expires_at > ? OR tier IN ('permanent', 'lifetime', 'admin')))");
            args.push(nowIso);
        } else if (status === "expired") {
            whereClauses.push("(expires_at <= ? AND tier NOT IN ('permanent', 'lifetime', 'admin'))");
            args.push(nowIso);
        } else if (status === "revoked" || status === "inactive") {
            whereClauses.push("active = 0");
        }

        if (tier !== "all") {
            whereClauses.push("tier = ?");
            args.push(tier);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

        // Total count query
        const countRes = await db.execute({
            sql: `SELECT COUNT(*) as total FROM keys ${whereSql};`,
            args
        });
        const total = Number(countRes.rows[0]?.total || 0);

        // Paginated rows query
        const rowsRes = await db.execute({
            sql: `SELECT key, hwid, created_at, expires_at, active, tier, provider, executions_count, note, last_used, discord_id, discord_tag 
                  FROM keys ${whereSql} 
                  ORDER BY created_at DESC 
                  LIMIT ? OFFSET ?;`,
            args: [...args, limit, offset]
        });

        const keys = rowsRes.rows.map(r => {
            const isPerm = ["permanent", "lifetime", "admin"].includes(String(r.tier || "").toLowerCase());
            const exp = r.expires_at ? new Date(String(r.expires_at)).getTime() : 0;
            const isExpired = !isPerm && exp > 0 && exp < Date.now();
            return {
                key: String(r.key),
                hwid: String(r.hwid || "UNSET"),
                created_at: r.created_at,
                expires_at: r.expires_at,
                active: Number(r.active) === 1,
                tier: String(r.tier || "24h"),
                provider: String(r.provider || "admin"),
                executions_count: Number(r.executions_count || 0),
                note: String(r.note || ""),
                discord_id: r.discord_id ? String(r.discord_id) : null,
                discord_tag: r.discord_tag ? String(r.discord_tag) : null,
                last_used: r.last_used,
                status: !r.active ? "revoked" : (isExpired ? "expired" : "active")
            };
        });

        return res.status(200).json({
            success: true,
            keys,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        console.error("[-] List keys error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.5 Key Management: Create Key (Single or Bulk)
app.post("/api/admin/keys/create", requireAdminAuth, async (req, res) => {
    try {
        const { durationHours, tier = "24h", note = "", count = 1 } = req.body;
        const totalToCreate = Math.min(20, Math.max(1, parseInt(count || "1", 10)));
        const hours = parseFloat(durationHours);
        const isPermanent = hours === -1 || tier === "permanent" || tier === "lifetime";

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const expiresMs = isPermanent ? Date.now() + 100 * 365 * 24 * 3600 * 1000 : (now + (hours || 24) * 3600 * 1000);
        const expiresIso = new Date(expiresMs).toISOString();
        const finalTier = isPermanent ? "permanent" : (tier || "24h");

        const createdKeys = [];

        for (let i = 0; i < totalToCreate; i++) {
            const keyStr = generateSignedKey("UNSET", expiresMs, finalTier);
            await db.execute({
                sql: "INSERT OR REPLACE INTO keys (key, hwid, created_at, expires_at, active, tier, provider, executions_count, note) VALUES (?, 'UNSET', ?, ?, 1, ?, 'admin', 0, ?)",
                args: [keyStr, nowIso, expiresIso, finalTier, String(note || "").trim()]
            });
            createdKeys.push({
                key: keyStr,
                hwid: "UNSET",
                tier: finalTier,
                expires_at: expiresIso,
                created_at: nowIso,
                note: note || ""
            });
        }

        return res.status(200).json({
            success: true,
            keys: createdKeys,
            count: createdKeys.length
        });
    } catch (err) {
        console.error("[-] Create key error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.6 Key Management: 1-Click HWID Reset
app.post("/api/admin/keys/reset-hwid", requireAdminAuth, async (req, res) => {
    try {
        const { key } = req.body;
        if (!key) return res.status(400).json({ error: "Missing key" });

        const result = await db.execute({
            sql: "UPDATE keys SET hwid = 'UNSET' WHERE key = ?",
            args: [String(key).trim()]
        });

        if (result.rowsAffected === 0) {
            return res.status(404).json({ error: "Key not found" });
        }

        console.log(`[+] HWID reset to UNSET for key: ${key}`);
        return res.status(200).json({ success: true, key, hwid: "UNSET" });
    } catch (err) {
        console.error("[-] Reset HWID error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.7 Key Management: Toggle Active / Revoke Key
app.post("/api/admin/keys/toggle-active", requireAdminAuth, async (req, res) => {
    try {
        const { key, active } = req.body;
        if (!key) return res.status(400).json({ error: "Missing key" });
        const newActive = active ? 1 : 0;

        await db.execute({
            sql: "UPDATE keys SET active = ? WHERE key = ?",
            args: [newActive, String(key).trim()]
        });

        return res.status(200).json({ success: true, key, active: newActive === 1 });
    } catch (err) {
        console.error("[-] Toggle active error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.8 Key Management: Extend Expiry or Convert to Permanent
app.post("/api/admin/keys/extend", requireAdminAuth, async (req, res) => {
    try {
        const { key, addHours, makePermanent } = req.body;
        if (!key) return res.status(400).json({ error: "Missing key" });

        const rowRes = await db.execute({
            sql: "SELECT expires_at, tier FROM keys WHERE key = ?",
            args: [String(key).trim()]
        });

        if (rowRes.rows.length === 0) {
            return res.status(404).json({ error: "Key not found" });
        }

        let newExpiresIso = "";
        let newTier = rowRes.rows[0].tier;

        if (makePermanent) {
            newExpiresIso = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
            newTier = "permanent";
        } else {
            const curExp = rowRes.rows[0].expires_at ? new Date(String(rowRes.rows[0].expires_at)).getTime() : Date.now();
            const baseMs = Math.max(Date.now(), curExp);
            const addedMs = parseFloat(addHours || 24) * 3600 * 1000;
            newExpiresIso = new Date(baseMs + addedMs).toISOString();
        }

        await db.execute({
            sql: "UPDATE keys SET expires_at = ?, tier = ?, active = 1 WHERE key = ?",
            args: [newExpiresIso, newTier, String(key).trim()]
        });

        return res.status(200).json({ success: true, key, expires_at: newExpiresIso, tier: newTier });
    } catch (err) {
        console.error("[-] Extend key error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.9 Key Management: Delete Key
app.delete("/api/admin/keys/:key", requireAdminAuth, async (req, res) => {
    try {
        const key = String(req.params.key).trim();
        await db.execute({
            sql: "DELETE FROM keys WHERE key = ?",
            args: [key]
        });
        return res.status(200).json({ success: true, key });
    } catch (err) {
        console.error("[-] Delete key error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// ==================== BACKGROUND RETENTION & CLEANUP ====================
// Automatically prunes expired keys older than retentionDays (default 7 days)
// to maintain database hygiene while preserving grace period for renewals & support.
// Permanent, lifetime, admin, and seed keys are strictly exempt and NEVER deleted.
async function pruneExpiredKeys(retentionDays = 7) {
    try {
        const days = Math.max(1, Number(retentionDays) || 7);
        const cutoffIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

        const result = await db.execute({
            sql: `DELETE FROM keys 
                  WHERE expires_at IS NOT NULL 
                    AND expires_at != ''
                    AND expires_at < ? 
                    AND LOWER(COALESCE(tier, '24h')) NOT IN ('permanent', 'lifetime', 'admin')
                    AND provider != 'seed';`,
            args: [cutoffIso]
        });

        const deletedCount = Number(result.rowsAffected || 0);
        if (deletedCount > 0) {
            console.log(`[+] [Auto-Cleanup] Successfully pruned ${deletedCount} expired key(s) older than ${days} days (cutoff: ${cutoffIso}).`);
        } else {
            console.log(`[i] [Auto-Cleanup] Key retention check completed. No keys older than ${days} days found.`);
        }
        return { success: true, deletedCount, cutoff: cutoffIso };
    } catch (err) {
        console.error("[-] [Auto-Cleanup] Error during expired keys purge:", err.message);
        return { success: false, error: err.message };
    }
}

// 8.9.1 Key Management: Purge Expired Keys Manually
app.post("/api/admin/keys/purge-expired", requireAdminAuth, async (req, res) => {
    try {
        const days = req.body?.days ? Number(req.body.days) : 7;
        const result = await pruneExpiredKeys(days);
        if (!result.success) {
            return res.status(500).json({ error: result.error });
        }
        return res.status(200).json(result);
    } catch (err) {
        console.error("[-] Manual purge expired keys error:", err);
        return res.status(500).json({ error: err.message });
    }
});


// 8.10 Executor Statistics: Detailed Distribution & Breakdown
app.get("/api/admin/stats/executors", requireAdminAuth, async (req, res) => {
    try {
        const range = req.query.range || "all"; // 'all', '7d', '24h'
        let timeCondition = "";
        const args = [];

        if (range === "24h") {
            timeCondition = "AND created_at > ?";
            args.push(Date.now() - 24 * 3600 * 1000);
        } else if (range === "7d") {
            timeCondition = "AND created_at > ?";
            args.push(Date.now() - 7 * 24 * 3600 * 1000);
        }

        const statsRes = await db.execute({
            sql: `SELECT executor, COUNT(*) as count, MAX(created_at) as last_seen 
                  FROM execution_logs 
                  WHERE status = 'success' ${timeCondition}
                  GROUP BY executor 
                  ORDER BY count DESC;`,
            args
        });

        const totalCount = statsRes.rows.reduce((sum, r) => sum + Number(r.count || 0), 0);

        const executors = statsRes.rows.map(r => {
            const count = Number(r.count || 0);
            const percentage = totalCount > 0 ? parseFloat(((count / totalCount) * 100).toFixed(1)) : 0;
            return {
                executor: String(r.executor || "Unknown"),
                count,
                percentage,
                last_seen: r.last_seen ? new Date(Number(r.last_seen)).toISOString() : null
            };
        });

        return res.status(200).json({
            success: true,
            totalExecutions: totalCount,
            range,
            executors
        });
    } catch (err) {
        console.error("[-] Executor stats error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.11 Recent Execution Logs Feed
app.get("/api/admin/stats/recent-logs", requireAdminAuth, async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || "50", 10)));
        const logsRes = await db.execute({
            sql: `SELECT id, key, hwid, executor, status, ip, created_at 
                  FROM execution_logs 
                  ORDER BY created_at DESC 
                  LIMIT ?;`,
            args: [limit]
        });

        const logs = logsRes.rows.map(r => {
            const ipRaw = String(r.ip || "0.0.0.0");
            const maskedIp = ipRaw.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, "$1.$2.$3.xxx");
            return {
                id: r.id,
                key: String(r.key || ""),
                hwid: String(r.hwid || ""),
                executor: String(r.executor || "Unknown"),
                status: String(r.status || "success"),
                ip: maskedIp,
                created_at: Number(r.created_at || Date.now())
            };
        });

        return res.status(200).json({ success: true, logs });
    } catch (err) {
        console.error("[-] Recent logs error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 8.12 Maintenance Mode Toggle
app.post("/api/admin/maintenance", requireAdminAuth, async (req, res) => {
    try {
        const { maintenance } = req.body;
        const maintVal = maintenance ? "true" : "false";
        await db.execute({
            sql: "INSERT OR REPLACE INTO system_config (key, value) VALUES ('MAINTENANCE', ?)",
            args: [maintVal]
        });
        SCRIPT_CACHE.maintenance = !!maintenance;
        console.log(`[+] Global Maintenance Mode set to: ${SCRIPT_CACHE.maintenance}`);
        return res.status(200).json({ success: true, maintenance: SCRIPT_CACHE.maintenance });
    } catch (err) {
        console.error("[-] Maintenance toggle error:", err);
        return res.status(500).json({ error: err.message });
    }
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

// ==================== IN-MEMORY TELEMETRY HUB ====================
// Map<key, Map<accountName, accountData>>
const activeTelemetries = new Map();

// Helper to validate a user key against DB or cryptographic HMAC
async function validateUserKey(keyStr) {
    if (!keyStr || typeof keyStr !== "string") return null;
    const cleanKey = keyStr.trim();
    if (!cleanKey.startsWith("FH-")) return null;

    try {
        const rowRes = await db.execute({
            sql: "SELECT * FROM keys WHERE key = ? AND active = 1",
            args: [cleanKey]
        });

        if (rowRes.rows.length > 0) {
            const keyRow = rowRes.rows[0];
            const exp = keyRow.expires_at ? new Date(String(keyRow.expires_at)).getTime() : 0;
            if (exp > 0 && exp < Date.now()) return null; // Expired
            return {
                key: cleanKey,
                tier: keyRow.tier || "24h",
                expires_at: keyRow.expires_at,
                valid: true
            };
        }

        // Cryptographic fallback self-heal
        const verified = decodeAndVerifyKey(cleanKey, CONFIG.SIGNING_SECRET);
        if (verified && verified.valid) {
            return {
                key: cleanKey,
                tier: verified.tier || "24h",
                expires_at: verified.expires_at,
                valid: true
            };
        }
    } catch (e) {
        console.error("[-] Error validating user key:", e);
    }
    return null;
}

// 9.1 Ingest Telemetry Heartbeat from Roblox Executor
app.post("/api/telemetry", async (req, res) => {
    const key = req.headers["x-fruitshub-key"] || req.body.key;
    if (!key) {
        return res.status(401).json({ error: "Missing FruitsHub access key" });
    }

    const keyValidation = await validateUserKey(String(key));
    if (!keyValidation) {
        return res.status(401).json({ error: "Invalid or expired FruitsHub key" });
    }

    const accountName = String(req.body.account || req.body.accountName || "Unknown Account").trim();
    if (!accountName) {
        return res.status(400).json({ error: "Missing account identifier" });
    }

    const now = Date.now();
    const data = req.body.telemetry || req.body;

    if (!activeTelemetries.has(keyValidation.key)) {
        activeTelemetries.set(keyValidation.key, new Map());
    }

    const accountMap = activeTelemetries.get(keyValidation.key);
    const existing = accountMap.get(accountName) || {};

    const accountData = {
        account: accountName,
        userId: data.userId || existing.userId || 0,
        avatarUrl: data.avatarUrl || existing.avatarUrl || "https://cdn.discordapp.com/embed/avatars/0.png",
        level: Number(data.level || existing.level || 0),
        beli: Number(data.beli || existing.beli || 0),
        beliDiff: Number(data.beliDiff || 0),
        team: String(data.team || existing.team || "Marines"),
        sea: String(data.sea || existing.sea || "First Sea"),
        status: String(data.status || "online"), // "online", "storage_full", "gacha_ready", "error"
        lastAction: String(data.lastAction || existing.lastAction || "Autonomous Farming"),
        serverHops: Number(data.serverHops || existing.serverHops || 0),
        jobId: String(data.jobId || existing.jobId || ""),
        gachaText: String(data.gachaText || "Available"),
        gachaCooldownEnd: Number(data.gachaCooldownEnd || 0),
        storage: data.storage || existing.storage || { counts: { Mythical: {}, Legendary: {}, Rare: {}, Common: {} }, totalCount: 0, maxCap: 1 },
        sessionStats: data.sessionStats || existing.sessionStats || { uptime: "0m", server_hops: 0, quests: 0, fruitsStoredToday: 0, gachaRolls: 0, lastSavedFruit: "None" },
        recentDrops: data.recentDrops || existing.recentDrops || [],
        lastSeen: now
    };

    accountMap.set(accountName, accountData);

    return res.status(200).json({ success: true, timestamp: now });
});

// 9.2 Real-time Telemetry Query Endpoint for Web Dashboard
app.get("/api/user/telemetry", async (req, res) => {
    const key = req.headers["x-fruitshub-key"] || req.query.key;
    if (!key) {
        return res.status(401).json({ error: "No key provided" });
    }

    const keyValidation = await validateUserKey(String(key));
    if (!keyValidation) {
        return res.status(401).json({ error: "Invalid or expired key" });
    }

    const now = Date.now();
    const accountMap = activeTelemetries.get(keyValidation.key);
    const accounts = [];

    if (accountMap) {
        for (const [accountName, accData] of accountMap.entries()) {
            const ageMs = now - accData.lastSeen;
            // If stale for more than 24 hours, prune
            if (ageMs > 24 * 3600 * 1000) {
                accountMap.delete(accountName);
                continue;
            }

            const item = { ...accData };
            // If no heartbeat received in >45 seconds, mark as offline
            if (ageMs > 45000) {
                item.status = "offline";
            }
            item.ageSeconds = Math.floor(ageMs / 1000);
            accounts.push(item);
        }
    }

    accounts.sort((a, b) => a.account.localeCompare(b.account));

    return res.status(200).json({
        success: true,
        keyInfo: {
            key: keyValidation.key,
            tier: keyValidation.tier,
            expires_at: keyValidation.expires_at,
            activeAccounts: accounts.filter(a => a.status !== "offline").length,
            totalAccounts: accounts.length
        },
        accounts,
        serverTime: now
    });
});

// 9.4 Static Brand Assets (Logos, Icons)
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "7d" }));
app.get(["/favicon.ico", "/logo.png"], (req, res) => {
    res.sendFile(path.join(__dirname, "assets", "logo_128.png"));
});

// 9.5 Admin Console Web Delivery
app.use("/admin", express.static(path.join(__dirname, "admin")));
app.get(["/admin", "/admin/*"], (req, res) => {
    res.sendFile(path.join(__dirname, "admin", "index.html"));
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

    // Evaluate Discord Gate for user
    const discordUser = getDiscordSession(req);
    let discordState = "UNAUTHENTICATED";
    if (discordUser) {
        const gateCheck = await evaluateDiscordGate(discordUser.id);
        discordState = gateCheck.status; // "NOT_IN_GUILD", "MISSING_REQUIRED_ROLE", "VERIFIED", "ERROR"
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderPortalHtml(activeKey, remainingTimeStr, loaderCode, hwidParam, discordUser, discordState, req.query));
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

function renderPortalHtml(activeKey, remainingTimeStr, loaderCode, hwidParam, discordUser = null, discordState = "UNAUTHENTICATED", queryParams = {}) {
    const inviteUrl = CONFIG.DISCORD.INVITE_URL;
    const vaultcordUrl = CONFIG.DISCORD.VAULTCORD_URL;

    // Build notifications if any query param was set
    let noticeHtml = "";
    if (queryParams.auth_error === "cancelled") {
        noticeHtml = `<div class="portal-alert alert-warning">Discord authorization was cancelled. Discord verification is required to obtain a key.</div>`;
    } else if (queryParams.auth_error === "oauth_failed") {
        noticeHtml = `<div class="portal-alert alert-danger">Failed to communicate with Discord. Please try again.</div>`;
    } else if (queryParams.error === "discord_required") {
        noticeHtml = `<div class="portal-alert alert-warning">You must complete Discord verification before accessing checkpoints.</div>`;
    } else if (queryParams.rechecked === "1") {
        if (discordState === "VERIFIED") {
            noticeHtml = `<div class="portal-alert alert-success">Verification complete! Role granted and checkpoints unlocked.</div>`;
        } else if (discordState === "MISSING_REQUIRED_ROLE") {
            noticeHtml = `<div class="portal-alert alert-warning">Verified Member role not detected yet. Please complete the Vaultcord verification below.</div>`;
        } else if (discordState === "NOT_IN_GUILD") {
            noticeHtml = `<div class="portal-alert alert-warning">You have not joined the Discord server yet. Please join using the invite button below.</div>`;
        }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FruitsHub Key System</title>
  <link rel="icon" type="image/png" href="/assets/logo_128.png">
  <link rel="apple-touch-icon" href="/assets/logo_128.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #070a0f;
      --bg-secondary: #0d121b;
      --bg-card: #101622;
      --bg-card-hover: #141c2c;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-active: rgba(56, 189, 248, 0.5);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-tertiary: #64748b;
      --accent-cyan: #38bdf8;
      --accent-cyan-hover: #7dd3fc;
      --accent-green: #22c55e;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --discord: #5865F2;
      --discord-hover: #4752C4;
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-xl: 20px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    
    html, body {
      min-height: 100vh;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow-x: hidden;
    }

    .ambient-glow {
      position: fixed;
      border-radius: 50%;
      pointer-events: none;
      z-index: 0;
      filter: blur(120px);
    }
    .glow-center {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 960px;
      height: 640px;
      background: radial-gradient(circle, rgba(56, 189, 248, 0.1) 0%, rgba(88, 101, 242, 0.05) 45%, rgba(7, 10, 15, 0) 75%);
    }

    .navbar {
      position: sticky;
      top: 0;
      width: 100%;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      background: rgba(7, 10, 15, 0.85);
      border-bottom: 1px solid var(--border-subtle);
      z-index: 100;
    }
    .nav-container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 16px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      font-weight: 800;
      font-size: 1.15rem;
      letter-spacing: 0.08em;
      color: var(--accent-cyan);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      transition: opacity 0.2s;
    }
    .brand:hover {
      opacity: 0.9;
    }
    .brand-logo-img {
      width: 32px;
      height: 32px;
      object-fit: contain;
      filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.45));
      transition: transform 0.25s ease, filter 0.25s ease;
    }
    .brand:hover .brand-logo-img {
      transform: rotate(-8deg) scale(1.1);
      filter: drop-shadow(0 0 14px rgba(56, 189, 248, 0.75));
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px 4px 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      border-radius: 24px;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-primary);
    }
    .user-pill img {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      object-fit: cover;
    }
    .nav-tag {
      font-family: var(--font-mono);
      font-size: 0.82rem;
      font-weight: 600;
      padding: 5px 14px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      letter-spacing: 0.03em;
    }
    .nav-tag.green {
      color: var(--accent-green);
      border-color: rgba(34, 197, 94, 0.3);
      background: rgba(34, 197, 94, 0.08);
    }
    .nav-tag.discord {
      color: #a5b4fc;
      border-color: rgba(88, 101, 242, 0.35);
      background: rgba(88, 101, 242, 0.12);
    }

    .main-wrapper {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      position: relative;
      z-index: 1;
      width: 100%;
    }
    .container {
      width: 100%;
      max-width: 940px;
      margin: 0 auto;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-xl);
      padding: 48px 52px;
      box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(12px);
      position: relative;
    }
    .card-title {
      font-size: 2.25rem;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.025em;
      margin-bottom: 10px;
      line-height: 1.2;
    }
    .card-desc {
      color: var(--text-secondary);
      font-size: 1.12rem;
      margin-bottom: 30px;
      line-height: 1.6;
    }
    .info-label {
      font-size: 0.82rem;
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 12px;
      display: block;
    }
    .code-box {
      background: #06080d;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: var(--radius-md);
      padding: 18px 22px;
      font-family: var(--font-mono);
      font-size: 0.95rem;
      color: var(--accent-cyan);
      margin-bottom: 24px;
      min-width: 0;
      max-width: 100%;
      word-break: break-all;
      overflow-wrap: anywhere;
      box-sizing: border-box;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 14px 24px;
      border-radius: var(--radius-md);
      font-size: 0.96rem;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
      font-family: var(--font-sans);
      white-space: nowrap;
      flex-shrink: 0;
      letter-spacing: 0.01em;
      gap: 10px;
    }
    .btn-primary {
      background: var(--accent-cyan);
      color: #061218;
      box-shadow: 0 4px 16px rgba(56, 189, 248, 0.25);
    }
    .btn-primary:hover {
      background: var(--accent-cyan-hover);
      box-shadow: 0 6px 20px rgba(56, 189, 248, 0.35);
      transform: translateY(-1px);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.18);
      transform: translateY(-1px);
    }
    .btn-discord {
      background: var(--discord);
      color: #ffffff;
      box-shadow: 0 4px 18px rgba(88, 101, 242, 0.35);
    }
    .btn-discord:hover {
      background: var(--discord-hover);
      box-shadow: 0 6px 24px rgba(88, 101, 242, 0.5);
      transform: translateY(-1px);
    }
    .btn-amber {
      background: #f59e0b;
      color: #000;
      box-shadow: 0 4px 18px rgba(245, 158, 11, 0.3);
    }
    .btn-amber:hover {
      background: #fbbf24;
      transform: translateY(-1px);
    }
    .btn-green {
      background: #22c55e;
      color: #061218;
      box-shadow: 0 4px 18px rgba(34, 197, 94, 0.3);
    }
    .btn-green:hover {
      background: #4ade80;
      transform: translateY(-1px);
    }

    .portal-alert {
      padding: 14px 18px;
      border-radius: var(--radius-md);
      font-size: 0.92rem;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
    }
    .alert-warning {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #fde68a;
    }
    .alert-danger {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .alert-success {
      background: rgba(34, 197, 94, 0.12);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #86efac;
    }

    .step-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 5px 12px;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .step-badge.discord {
      color: #c7d2fe;
      background: rgba(88, 101, 242, 0.18);
      border: 1px solid rgba(88, 101, 242, 0.35);
    }
    .step-badge.amber {
      color: #fde68a;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.35);
    }
    .step-badge.green {
      color: #86efac;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.35);
    }

    .verified-user-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: rgba(34, 197, 94, 0.06);
      border: 1px solid rgba(34, 197, 94, 0.25);
      border-radius: var(--radius-md);
      margin-bottom: 28px;
    }
    .user-info-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .user-avatar-big {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 2px solid var(--accent-green);
    }

    .instruction-box {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 20px 24px;
      margin: 20px 0 28px 0;
      font-size: 0.95rem;
      color: #cbd5e1;
      line-height: 1.65;
    }
    .instruction-step {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .instruction-step:last-child {
      margin-bottom: 0;
    }
    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      color: #fff;
      flex-shrink: 0;
    }

    .btn-row {
      display: flex;
      gap: 14px;
      margin-top: 10px;
      flex-wrap: wrap;
    }

    .provider-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-top: 14px;
    }
    @media (max-width: 720px) {
      .main-wrapper { padding: 24px 16px; }
      .card { padding: 32px 24px; }
      .card-title { font-size: 1.7rem; }
      .card-desc { font-size: 1rem; margin-bottom: 24px; }
      .provider-grid { grid-template-columns: 1fr; gap: 16px; }
      .nav-container { padding: 14px 20px; }
      .btn-row { flex-direction: column; }
      .btn-row .btn { width: 100%; }
    }
    .provider-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 32px 28px;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 220px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .provider-card:hover {
      border-color: var(--border-active);
      background: var(--bg-card-hover);
      transform: translateY(-3px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 0 24px rgba(56, 189, 248, 0.1);
    }
    .provider-badge {
      font-size: 0.78rem;
      font-family: var(--font-mono);
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 4px 10px;
      border-radius: 6px;
      display: inline-block;
      width: fit-content;
      margin-bottom: 12px;
    }
    .provider-badge.cyan {
      color: var(--accent-cyan);
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .provider-badge.gray {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
    }
    .provider-title {
      font-size: 1.45rem;
      font-weight: 800;
      color: #ffffff;
      margin-bottom: 6px;
      letter-spacing: -0.01em;
    }
    .provider-sub {
      font-size: 0.95rem;
      color: var(--text-secondary);
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .footer {
      text-align: center;
      padding: 24px;
      font-size: 0.85rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      position: relative;
      z-index: 1;
    }
  </style>
</head>
<body>
  <div class="ambient-glow glow-center"></div>

  <header class="navbar">
    <div class="nav-container">
      <a href="/" class="brand">
        <img src="/assets/logo_128.png" alt="FruitsHub Logo" class="brand-logo-img">
        <span>FRUITSHUB</span>
      </a>
      <div class="nav-right">
        ${discordUser ? `
          <div class="user-pill" title="Signed in with Discord">
            <img src="${escapeHtml(discordUser.avatar)}" alt="Avatar">
            <span>${escapeHtml(discordUser.username)}</span>
            <a href="/api/auth/discord/logout?hwid=${encodeURIComponent(hwidParam)}" title="Sign out of Discord" style="color: var(--text-tertiary); text-decoration: none; margin-left: 4px; font-size: 1rem; line-height: 1;">&times;</a>
          </div>
        ` : ""}
        <span class="nav-tag ${activeKey ? "green" : (discordState === "VERIFIED" ? "green" : (discordUser ? "discord" : ""))}">
          ${activeKey ? "Active Key" : (discordState === "VERIFIED" ? "Verified ✓" : "Key System")}
        </span>
      </div>
    </div>
  </header>

  <main class="main-wrapper">
    <div class="container">
      ${noticeHtml}

      ${activeKey ? `
        <!-- ==================== VIEW: ACTIVE KEY ==================== -->
        <div class="card">
          <span class="step-badge green">✓ AUTHORIZED DEVICE</span>
          <h1 class="card-title">Active Key</h1>
          <p class="card-desc">You already have an active key bound to this device (${remainingTimeStr}).</p>

          <div style="margin-bottom: 28px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span class="info-label" style="margin-bottom: 0;">Your Access Key</span>
              <button class="btn btn-secondary" style="padding: 8px 18px; font-size: 0.85rem;" onclick="copyText('raw-key', this)">Copy Key</button>
            </div>
            <div class="code-box" style="margin-bottom: 0; padding: 18px 22px; display: block; word-break: break-all; overflow-wrap: anywhere;">
              <span id="raw-key" style="font-weight: 600; color: var(--accent-cyan); font-size: 1rem; line-height: 1.6; word-break: break-all; overflow-wrap: anywhere; user-select: all; display: block;">${activeKey}</span>
            </div>
          </div>

          <div style="margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span class="info-label" style="margin-bottom: 0;">Roblox Universal Loader</span>
              <button class="btn btn-primary" style="padding: 8px 20px; font-size: 0.85rem;" onclick="copyText('raw-loader', this)">Copy Loader</button>
            </div>
            <div class="code-box" style="margin-bottom: 0; padding: 18px 22px; display: block;">
              <pre id="raw-loader" style="margin: 0; font-family: var(--font-mono); font-size: 0.92rem; line-height: 1.65; color: #cbd5e1; white-space: pre-wrap; word-break: break-word; user-select: all;">${escapeHtml(loaderCode)}</pre>
            </div>
          </div>
        </div>

      ` : discordState === "UNAUTHENTICATED" ? `
        <!-- ==================== STATE 0: DISCORD LOGIN REQUIRED ==================== -->
        <div class="card">
          <span class="step-badge discord">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            DISCORD VERIFICATION REQUIRED
          </span>
          <h1 class="card-title">FruitsHub Key System</h1>
          <p class="card-desc">To obtain your 24-hour key and protect our service against bots and abuse, please sign in with your community Discord account.</p>

          <a id="discord-login-btn" href="/api/auth/discord/login?hwid=${encodeURIComponent(hwidParam)}" class="btn btn-discord" style="width: 100%; padding: 18px 28px; font-size: 1.05rem;">
            <svg width="24" height="24" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            <span>Sign in with Discord</span>
          </a>
        </div>

      ` : discordState === "NOT_IN_GUILD" ? `
        <!-- ==================== STATE 1: NOT IN SERVER ==================== -->
        <div class="card">
          <span class="step-badge amber">STEP 1 OF 2 · SERVER MEMBERSHIP REQUIRED</span>
          <h1 class="card-title">Join our Discord Server</h1>
          <p class="card-desc">Signed in as <strong style="color: #fff;">${escapeHtml(discordUser.tag)}</strong>, but you are not a member of the official FruitsHub server yet.</p>

          <div class="instruction-box">
            <div class="instruction-step">
              <div class="step-num">1</div>
              <div>Join our server by clicking <strong>"Join Server"</strong> below.</div>
            </div>
            <div class="instruction-step">
              <div class="step-num">2</div>
              <div>After joining, return here and click <strong>"I Joined (Check Again)"</strong> to verify your membership.</div>
            </div>
          </div>

          <div class="btn-row">
            <a href="${inviteUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-discord" style="flex: 1;">
              <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
              <span>Join Server</span>
            </a>
            <a href="/api/auth/discord/recheck?hwid=${encodeURIComponent(hwidParam)}" class="btn btn-primary" style="flex: 1;">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              <span>I Joined (Check Again)</span>
            </a>
          </div>

          <div style="margin-top: 24px; text-align: center;">
            <a href="/api/auth/discord/logout?hwid=${encodeURIComponent(hwidParam)}" style="color: var(--text-tertiary); font-size: 0.85rem; text-decoration: none;">
              Wrong account? Sign in with another Discord account
            </a>
          </div>
        </div>

      ` : discordState === "MISSING_REQUIRED_ROLE" ? `
        <!-- ==================== STATE 2: IN SERVER BUT MISSING VAULTCORD ==================== -->
        <div class="card">
          <span class="step-badge amber">STEP 2 OF 2 · SECURITY VERIFICATION</span>
          <h1 class="card-title">Verify in our Server</h1>
          <p class="card-desc">You are in the server! Now complete the official <strong>Vaultcord</strong> verification to receive your Member role.</p>

          <div class="instruction-box">
            <div class="instruction-step">
              <div class="step-num">1</div>
              <div>Click <strong>"Verify with Vaultcord"</strong> to complete the security validation in Discord.</div>
            </div>
            <div class="instruction-step">
              <div class="step-num">2</div>
              <div>Once completed, return here and click <strong>"I'm Verified (Check Again)"</strong> to receive your role and unlock your key.</div>
            </div>
          </div>

          <div class="btn-row">
            <a href="${vaultcordUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-amber" style="flex: 1;">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              <span>Verify with Vaultcord</span>
            </a>
            <a href="/api/auth/discord/recheck?hwid=${encodeURIComponent(hwidParam)}" class="btn btn-green" style="flex: 1;">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              <span>I'm Verified (Check Again)</span>
            </a>
          </div>

          <div style="margin-top: 24px; text-align: center;">
            <a href="/api/auth/discord/logout?hwid=${encodeURIComponent(hwidParam)}" style="color: var(--text-tertiary); font-size: 0.85rem; text-decoration: none;">
              Wrong account? Sign in with another Discord account
            </a>
          </div>
        </div>

      ` : `
        <!-- ==================== STATE 3: VERIFIED (CHECKPOINT SELECTION) ==================== -->
        <div class="card">
          <!-- Verified banner -->
          <div class="verified-user-banner">
            <div class="user-info-left">
              <img class="user-avatar-big" src="${escapeHtml(discordUser ? discordUser.avatar : 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="Avatar">
              <div>
                <div style="font-weight: 700; color: #fff; font-size: 1rem; display: flex; align-items: center; gap: 8px;">
                  <span>${escapeHtml(discordUser ? discordUser.tag : 'User')}</span>
                  <span class="step-badge green" style="padding: 2px 8px; font-size: 0.72rem; margin-bottom: 0;">Verified ✓</span>
                </div>
                <div style="font-size: 0.82rem; color: #86efac; margin-top: 2px;">
                  Role <span style="font-family: var(--font-mono); font-weight: 700;">@user</span> delivered in FruitsHub Discord
                </div>
              </div>
            </div>
            <a href="/api/auth/discord/recheck?hwid=${encodeURIComponent(hwidParam)}" class="btn btn-secondary" style="padding: 8px 14px; font-size: 0.8rem;" title="Sync status with Discord">
              Sync
            </a>
          </div>

          <h1 class="card-title">FruitsHub Key System</h1>
          <p class="card-desc">Choose your preferred provider and complete 3 checkpoints to generate your 24-hour key.</p>

          ${hwidParam ? `
            <span class="info-label">Hardware ID (Bound HWID)</span>
            <div class="code-box" style="margin-bottom: 28px;">
              <span style="font-size: 0.9rem; color: #cbd5e1;">${escapeHtml(hwidParam)}</span>
            </div>
          ` : ""}

          <span class="info-label">Choose Provider</span>
          <div class="provider-grid">
            <!-- LootLabs -->
            <a href="/checkpoint/start?provider=lootlabs&hwid=${encodeURIComponent(hwidParam || "DEFAULT_USER")}" class="provider-card">
              <div>
                <span class="provider-badge cyan">Recommended</span>
                <div class="provider-title">LootLabs</div>
                <div class="provider-sub">3 fast checkpoints with fewer ads</div>
              </div>
              <div class="btn btn-primary" style="width: 100%;">Get Key via LootLabs</div>
            </a>

            <!-- Linkvertise -->
            <a href="/checkpoint/start?provider=linkvertise&hwid=${encodeURIComponent(hwidParam || "DEFAULT_USER")}" class="provider-card">
              <div>
                <span class="provider-badge gray">Alternative</span>
                <div class="provider-title">Linkvertise</div>
                <div class="provider-sub">3 standard Linkvertise checkpoints</div>
              </div>
              <div class="btn btn-secondary" style="width: 100%;">Get Key via Linkvertise</div>
            </a>
          </div>
        </div>
      `}
    </div>
  </main>

  <footer class="footer">
    FruitsHub &copy; 2026 &bull; Key System Gateway &bull; Protected by Discord Auth
  </footer>

  <script>
    (function() {
      const urlParams = new URLSearchParams(window.location.search);
      let devId = urlParams.get("hwid");

      if (!devId) {
        devId = localStorage.getItem("fh_device_id");
        if (!devId) {
          devId = "WEB_" + Math.random().toString(36).substring(2, 10);
          localStorage.setItem("fh_device_id", devId);
        }
        // Update all provider and action links
        document.querySelectorAll("a[href*='hwid=']").forEach(a => {
          a.href = a.href.replace("hwid=DEFAULT_USER", "hwid=" + encodeURIComponent(devId))
                        .replace("hwid=", "hwid=" + encodeURIComponent(devId));
        });
      } else {
        localStorage.setItem("fh_device_id", devId);
      }

      // Update Discord login button href with current HWID if it exists
      const discordBtn = document.getElementById("discord-login-btn");
      if (discordBtn && devId) {
        discordBtn.href = "/api/auth/discord/login?hwid=" + encodeURIComponent(devId);
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

    // Initial key cleanup check on cold start
    pruneExpiredKeys(7).catch(e => console.error("[-] Initial prune failed:", e));

    // Recurring task: run once every 24 hours (86,400,000 ms)
    setInterval(() => {
        pruneExpiredKeys(7).catch(e => console.error("[-] Recurring prune failed:", e));
    }, 24 * 3600 * 1000);

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
