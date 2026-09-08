--[[
    FruitsHub — Blox Fruits
    Autonomous: Join Marines -> Fruit roll (Gacha) -> Scan & collect
    spawned ground fruits via 164-speed NoClip tween -> Smart server hop.
    Status-only Fullscreen GUI (no controls).
    Rich Discord alerts with official high-res thumbnails & detailed stats.
]]

-- ===================== Persistent Config (getgenv) =====================
getgenv().FruitsHub = getgenv().FruitsHub or {}
local Cfg = getgenv().FruitsHub

Cfg.Team = Cfg.Team or "Marines"
Cfg.RollBox = Cfg.RollBox or "ZiolesGacha"
Cfg.Speed = 164 -- 164 studs/s tested safe anti-cheat speed (exact HoHo Hub safe cap)
Cfg.HopAfterEmptyScans = Cfg.HopAfterEmptyScans or 2
Cfg.StoredFruits = Cfg.StoredFruits or {} -- [cleanName] = true: confirmed fruits in storage
Cfg.Disable3D = (Cfg.Disable3D ~= nil and Cfg.Disable3D) or true -- 3D rendering disabled by default (extreme GPU saving)
Cfg.TargetFPS = Cfg.TargetFPS or 30 -- FPS limiter to minimize CPU usage
-- LogoAsset is resolved at GUI build time via getcustomasset("FruitsHub/logo.png") or rbxthumb fallback
Cfg.LogoAsset = Cfg.LogoAsset or "rbxthumb://type=Asset&id=94904197752233&w=150&h=150"
Cfg.MagnetFarm = (Cfg.MagnetFarm ~= nil and Cfg.MagnetFarm) or true
Cfg.MagnetGacha = (Cfg.MagnetGacha ~= nil and Cfg.MagnetGacha) or true
Cfg.MagnetOverheadHeight = Cfg.MagnetOverheadHeight or 30
Cfg.AutoQuestFarm = (Cfg.AutoQuestFarm ~= nil and Cfg.AutoQuestFarm) or true
Cfg.QuestSpeed = Cfg.QuestSpeed or 135
Cfg.QuestOverheadHeight = Cfg.QuestOverheadHeight or 30
Cfg.AutoStats = (Cfg.AutoStats ~= nil and Cfg.AutoStats) or true

-- ===================== Services / Instances =====================
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local RunService = game:GetService("RunService")
local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local UserInputService = game:GetService("UserInputService")
local CollectionService = game:GetService("CollectionService")

local LP = Players.LocalPlayer
local CommF_ = ReplicatedStorage:WaitForChild("Remotes", 30):WaitForChild("CommF_", 30)
local ServerBrowser = ReplicatedStorage:FindFirstChild("__ServerBrowser")
local MagnetEvent = nil -- [TEMPORARY: MAGNET EVENT FORWARD DECLARATION - ELIMINAR EN 15 DÍAS]
local AutoQuestFarm = nil -- Auto Quest & Beli Farming forward declaration
local stopTween = nil
local stopQuestTween = nil
local setQuestHoverBV = nil
local autoAssignStats = nil

-- Helper to normalize names and storage keys (handles "T-Rex-T-Rex", "Flame-Flame", etc.)
local function cleanFruitKey(str)
    if not str or str == "" then return "" end
    local s = tostring(str):gsub("%s*Fruit", ""):gsub("%s*%[.*%]", ""):gsub("^%s+", ""):gsub("%s+$", "")
    if s:find("T%-Rex") then
        return "T-Rex"
    end
    local half = s:match("^(.-)%-(%1)$")
    if half then return half:gsub("%s*%(.*%)", ""):gsub("%s+$", "") end
    local lastDash = s:match("^(.-)%-[^%-]+$")
    if lastDash then
        return lastDash:gsub("%s*%(.*%)", ""):gsub("%s+$", "")
    end
    return s:gsub("%-.*", ""):gsub("%s*%(.*%)", ""):gsub("%s+$", "")
end

-- ===================== Populate StoredFruits from ItemReplicationService =====================
-- The main loop waits for Cfg.StorageLoaded before the first scan to avoid
-- chasing fruits already stored (after server hop getgenv resets and this repopulates).
-- Retried in the background if uninitialized.
Cfg.StorageLoaded = false

-- Helper to get maximum fruit storage capacity per fruit for the current player
local function getMaxFruitCap()
    local cap = LP and LP:FindFirstChild("Data") and LP.Data:FindFirstChild("FruitCap") and LP.Data.FruitCap.Value
    if type(cap) == "number" and cap > 0 then
        return cap
    end
    return 1
end

local function preloadStoredFruits()
    local IRService = require(ReplicatedStorage:WaitForChild("ItemReplicationService", 10))
    local KEYS = require(ReplicatedStorage:WaitForChild("ItemReplicationService"):WaitForChild("KEYS", 10))
    local ItemConfig = require(ReplicatedStorage:WaitForChild("ItemConfig", 10))
    local ItemId = require(ReplicatedStorage:WaitForChild("Economy"):WaitForChild("ItemId", 10))
    local PseudoEnum = require(ReplicatedStorage:WaitForChild("PseudoEnum", 10))
    if not IRService or not KEYS or not ItemConfig or not ItemId or not PseudoEnum then
        return false
    end

    -- Wait for service initialization
    for _ = 1, 60 do
        if IRService.IsInitialized then break end
        task.wait(0.5)
    end
    if not IRService.IsInitialized then return false end

    local storedMethod = PseudoEnum.ItemStorageMethod.StoredFruits
    local owned = IRService:GetItems(KEYS.IS_OWNED)
    if not owned then return false end

    local quantities = (KEYS.QUANTITY and IRService:GetItems(KEYS.QUANTITY)) or {}
    local qtyMap = {}
    for _, q in ipairs(quantities) do
        if q.ItemId and q.Value then
            qtyMap[q.ItemId] = q.Value
        end
    end

    local freshStored = {}
    local count = 0
    for _, item in pairs(owned) do
        local ok, cfg = pcall(ItemConfig.tryGet, item.ItemId)
        if ok and cfg and cfg.State and cfg.State.StorageMethod == storedMethod then
            local dOk, data = pcall(function()
                return ItemId.getDataFromId(item.ItemId):unwrap()
            end)
            local storageKey = (cfg.Index and cfg.Index.StorageKey)
                or (dOk and data and data.StorageKey)
                or (cfg.Display and cfg.Display.Name)
                or ""
            local clean = cleanFruitKey(storageKey)
            if clean ~= "" then
                local qty = qtyMap[item.ItemId] or 1
                freshStored[clean] = (freshStored[clean] or 0) + qty
                count = count + qty
            end
        end
    end
    Cfg.StoredFruits = freshStored
    return true
end

task.spawn(function()
    Cfg.StorageLoaded = preloadStoredFruits()
    if not Cfg.StorageLoaded then
        -- Deferred retry: service might take time to load when entering server
        task.wait(15)
        Cfg.StorageLoaded = preloadStoredFruits()
    end
end)

-- ===================== Fruit Catalog & Icons (Discord / Embeds) =====================
-- Direct verified URLs for official Blox Fruits icons (crisp PNG)
local FRUIT_ICONS = {
    ["Rocket"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/cb/Rocket_Fruit.png",
    ["Spin"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/88/Spin_Fruit.png",
    ["Blade"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/0/01/Blade_Fruit.png",
    ["Chop"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/0/0e/Chop_Fruit.png",
    ["Spring"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/8a/Spring_Fruit.png",
    ["Bomb"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/4/43/Bomb_Fruit.png",
    ["Smoke"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/7/7e/Smoke_Fruit.png",
    ["Spike"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/ce/Spike_Fruit.png",
    ["Flame"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/c4/Flame_Fruit.png",
    ["Falcon"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/e/ef/Falcon_Fruit.png",
    ["Eagle"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/e/ef/Falcon_Fruit.png",
    ["Ice"]           = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/c5/Ice_Fruit.png",
    ["Sand"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/7/72/Sand_Fruit.png",
    ["Dark"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/5/5c/Dark_Fruit.png",
    ["Diamond"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/88/Diamond_Fruit.png",
    ["Light"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/83/Light_Fruit.png",
    ["Rubber"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/5/5c/Rubber_Fruit.png",
    ["Barrier"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/1/19/Barrier_Fruit.png",
    ["Creation"]      = "https://static.wikia.nocookie.net/roblox-blox-piece/images/1/19/Barrier_Fruit.png",
    ["Ghost"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/8c/Ghost_Fruit.png",
    ["Revive"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/8c/Ghost_Fruit.png",
    ["Magma"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/2/27/Magma_Fruit.png",
    ["Quake"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/4/42/Quake_Fruit.png",
    ["Buddha"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/d/df/Buddha_Fruit.png",
    ["Love"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/b/b3/Love_Fruit.png",
    ["Spider"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/6/61/Spider_Fruit.png",
    ["Sound"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/b/ba/Sound_Fruit.png",
    ["Phoenix"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/f/fc/Phoenix_Fruit.png",
    ["Portal"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/8/8a/Portal_Fruit.png",
    ["Rumble"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/7/78/Lightning_Fruit.png",
    ["Lightning"]     = "https://static.wikia.nocookie.net/roblox-blox-piece/images/7/78/Lightning_Fruit.png",
    ["Pain"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/4/40/Pain_Fruit.png",
    ["Paw"]           = "https://static.wikia.nocookie.net/roblox-blox-piece/images/4/40/Pain_Fruit.png",
    ["Blizzard"]      = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/c9/Blizzard_Fruit.png",
    ["Gravity"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/5/5f/Gravity_Fruit.png",
    ["Mammoth"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/9/95/Mammoth_Fruit.png",
    ["T-Rex"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/d/d9/T-Rex_Fruit.png",
    ["Dough"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/0/02/Dough_Fruit.png",
    ["Shadow"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/5/58/Shadow_Fruit.png",
    ["Venom"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/d/d2/Venom_Fruit.png",
    ["Control"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/1/19/Control_Fruit.png",
    ["Spirit"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/6/66/Spirit_Fruit.png",
    ["Dragon"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/2/29/Dragon_Fruit.png",
    ["Dragon (East)"] = "https://static.wikia.nocookie.net/roblox-blox-piece/images/2/29/Dragon_Fruit.png",
    ["Dragon (West)"] = "https://static.wikia.nocookie.net/roblox-blox-piece/images/2/29/Dragon_Fruit.png",
    ["Leopard"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/a/a3/Leopard_Fruit.png",
    ["Tiger"]         = "https://static.wikia.nocookie.net/roblox-blox-piece/images/a/a3/Leopard_Fruit.png",
    ["Kitsune"]       = "https://static.wikia.nocookie.net/roblox-blox-piece/images/6/65/Kitsune_Fruit.png",
    ["Gas"]           = "https://static.wikia.nocookie.net/roblox-blox-piece/images/e/ed/Gas_Fruit.png",
    ["Yeti"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/2/2f/Yeti_Fruit.png",
    ["Magnet"]        = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/c5/Magnet_Fruit.png",
    ["Arcsteel Magnet"] = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/c5/Magnet_Fruit.png",
    ["Kilo"]          = "https://static.wikia.nocookie.net/roblox-blox-piece/images/c/cb/Rocket_Fruit.png",
}

-- Default official base metadata (fallback if ItemConfig fails to load)
local DEFAULT_FRUITS_META = {
    ["Rocket"]        = { rarity = "Common",    price = 5000 },
    ["Spin"]          = { rarity = "Common",    price = 7500 },
    ["Blade"]         = { rarity = "Common",    price = 30000 },
    ["Lime Blade"]    = { rarity = "Common",    price = 30000 },
    ["Chop"]          = { rarity = "Common",    price = 30000 },
    ["Spring"]        = { rarity = "Common",    price = 60000 },
    ["Bomb"]          = { rarity = "Common",    price = 80000 },
    ["Smoke"]         = { rarity = "Common",    price = 100000 },
    ["Spike"]         = { rarity = "Common",    price = 180000 },
    ["Flame"]         = { rarity = "Uncommon",  price = 250000 },
    ["Falcon"]        = { rarity = "Uncommon",  price = 550000 },
    ["Eagle"]         = { rarity = "Uncommon",  price = 550000 },
    ["Ice"]           = { rarity = "Uncommon",  price = 350000 },
    ["Sand"]          = { rarity = "Uncommon",  price = 420000 },
    ["Dark"]          = { rarity = "Uncommon",  price = 500000 },
    ["Diamond"]       = { rarity = "Uncommon",  price = 600000 },
    ["Light"]         = { rarity = "Rare",      price = 650000 },
    ["Rubber"]        = { rarity = "Rare",      price = 750000 },
    ["Barrier"]       = { rarity = "Legendary", price = 1400000 },
    ["Creation"]      = { rarity = "Legendary", price = 1400000 },
    ["Ghost"]         = { rarity = "Rare",      price = 940000 },
    ["Scarlet Ghost"] = { rarity = "Rare",      price = 940000 },
    ["Revive"]        = { rarity = "Rare",      price = 940000 },
    ["Magma"]         = { rarity = "Rare",      price = 960000 },
    ["Quake"]         = { rarity = "Legendary", price = 1000000 },
    ["Buddha"]        = { rarity = "Legendary", price = 1200000 },
    ["Love"]          = { rarity = "Legendary", price = 1300000 },
    ["Spider"]        = { rarity = "Legendary", price = 1500000 },
    ["Sound"]         = { rarity = "Legendary", price = 1700000 },
    ["Phoenix"]       = { rarity = "Legendary", price = 1800000 },
    ["Portal"]        = { rarity = "Legendary", price = 1900000 },
    ["Rumble"]        = { rarity = "Legendary", price = 2100000 },
    ["Lightning"]     = { rarity = "Legendary", price = 2100000 },
    ["Pain"]          = { rarity = "Legendary", price = 2300000 },
    ["Paw"]           = { rarity = "Legendary", price = 2300000 },
    ["Blizzard"]      = { rarity = "Legendary", price = 2400000 },
    ["Gravity"]       = { rarity = "Mythical",  price = 2500000 },
    ["Starlight Gravity"] = { rarity = "Mythical", price = 2500000 },
    ["Mammoth"]       = { rarity = "Mythical",  price = 2700000 },
    ["T-Rex"]         = { rarity = "Mythical",  price = 2700000 },
    ["Dough"]         = { rarity = "Mythical",  price = 2800000 },
    ["Shadow"]        = { rarity = "Mythical",  price = 2900000 },
    ["Venom"]         = { rarity = "Mythical",  price = 3000000 },
    ["Gas"]           = { rarity = "Mythical",  price = 3200000 },
    ["Control"]       = { rarity = "Mythical",  price = 9000000 },
    ["Spirit"]        = { rarity = "Mythical",  price = 3400000 },
    ["Dragon"]        = { rarity = "Mythical",  price = 15000000 },
    ["Dragon (East)"] = { rarity = "Mythical",  price = 15000000 },
    ["Dragon (West)"] = { rarity = "Mythical",  price = 15000000 },
    ["Leopard"]       = { rarity = "Mythical",  price = 5000000 },
    ["Tiger"]         = { rarity = "Mythical",  price = 5000000 },
    ["Yeti"]          = { rarity = "Mythical",  price = 5000000 },
    ["Runic Fiend"]   = { rarity = "Mythical",  price = 5000000 },
    ["Kitsune"]       = { rarity = "Mythical",  price = 8000000 },
    ["Magnet"]        = { rarity = "Mythical",  price = 6000000 },
    ["Arcsteel Magnet"] = { rarity = "Mythical", price = 6000000 },
    ["Celestial"]     = { rarity = "Mythical",  price = 0 },
    ["Meme"]          = { rarity = "Mythical",  price = 1 },
    ["Oni"]           = { rarity = "Mythical",  price = 0 },
}

local RARITY_COLORS = {
    ["Common"]    = 0x9ca3af, -- Gray
    ["Uncommon"]  = 0x3b82f6, -- Blue
    ["Rare"]      = 0x8b5cf6, -- Purple
    ["Legendary"] = 0xf59e0b, -- Amber / Orange
    ["Mythical"]  = 0xef4444, -- Red
}

-- Numeric Beli formatter ($1,200,000)
local function formatBeli(n)
    if not n or n == 0 then return "0" end
    local left, num, right = string.match(tostring(n), '^([^%d]*%d)(%d*)(.-)$')
    return left .. (num:reverse():gsub('(%d%d%d)','%1,'):reverse()) .. right
end

-- Dynamic cache of game data extracted from ItemConfig
local itemConfigCache = nil
local function getItemConfigData()
    if itemConfigCache then return itemConfigCache end
    itemConfigCache = {}

    local ok, ItemConfig = pcall(function()
        return require(ReplicatedStorage:WaitForChild("ItemConfig", 5))
    end)
    if ok and ItemConfig and typeof(ItemConfig.dumpItems) == "function" then
        local okDump, dump = pcall(ItemConfig.dumpItems)
        if okDump and type(dump) == "table" then
            -- Pass 1: PhysicalMoveset (contains physical fruit with Name, MoneyPrice, true Rarity and description)
            for _, it in pairs(dump) do
                if it.Index and it.Display and it.Display.Category == "Blox Fruit" and it.Index.IdType == "PhysicalMoveset" then
                    local key = it.Index.StorageKey or ""
                    local name = (it.Display.Name and it.Display.Name ~= "" and it.Display.Name)
                        or (key ~= "" and key)
                        or (it.Index.DebugLabel and it.Index.DebugLabel:match("^(.-)%s*%["))
                        or ""
                    local rarity = it.Quality and it.Quality.Rarity or "Common"
                    local price = it.Quality and it.Quality.MoneyPrice or 0
                    local desc = it.Display.Description or ""
                    local entry = { name = name, cleanName = name, rarity = rarity, price = price, desc = desc }

                    if key ~= "" then itemConfigCache[key] = entry end
                    if name ~= "" then itemConfigCache[name] = entry end
                    if name ~= "" then itemConfigCache[name .. " Fruit"] = entry end

                    -- Blox Fruits update aliases / skins
                    if name == "Tiger" then
                        itemConfigCache["Leopard"] = entry
                        itemConfigCache["Leopard Fruit"] = entry
                    elseif name == "Eagle" then
                        itemConfigCache["Falcon"] = entry
                        itemConfigCache["Falcon Fruit"] = entry
                    elseif name == "Lightning" then
                        itemConfigCache["Rumble"] = entry
                        itemConfigCache["Rumble Fruit"] = entry
                    elseif name == "Pain" then
                        itemConfigCache["Paw"] = entry
                        itemConfigCache["Paw Fruit"] = entry
                    elseif name == "Ghost" then
                        itemConfigCache["Revive"] = entry
                        itemConfigCache["Revive Fruit"] = entry
                    elseif name == "Rocket" then
                        itemConfigCache["Kilo"] = entry
                        itemConfigCache["Kilo Fruit"] = entry
                    elseif name == "Creation" then
                        itemConfigCache["Barrier"] = entry
                        itemConfigCache["Barrier Fruit"] = entry
                    elseif name == "Magnet" then
                        itemConfigCache["Arcsteel Magnet"] = entry
                        itemConfigCache["Arcsteel Magnet Fruit"] = entry
                    end
                end
            end

            -- Pass 2: Movesets for any fruit not listed in PhysicalMoveset
            for _, it in pairs(dump) do
                if it.Index and it.Display and it.Display.Category == "Blox Fruit" and it.Index.IdType == "Moveset" then
                    local key = it.Index.StorageKey or ""
                    local name = (it.Display.Name and it.Display.Name ~= "" and it.Display.Name)
                        or (key ~= "" and key)
                        or ""
                    if name ~= "" and not itemConfigCache[name] then
                        local rarity = it.Quality and it.Quality.Rarity or "Common"
                        local price = it.Quality and it.Quality.MoneyPrice or 0
                        local desc = it.Display.Description or ""
                        local entry = { name = name, cleanName = name, rarity = rarity, price = price, desc = desc }
                        if key ~= "" then itemConfigCache[key] = entry end
                        itemConfigCache[name] = entry
                        itemConfigCache[name .. " Fruit"] = entry
                    end
                end
            end
        end
    end

    -- Pass 3: Integrate default base metadata if missing
    for k, v in pairs(DEFAULT_FRUITS_META) do
        if not itemConfigCache[k] then
            local entry = { name = k, cleanName = k, rarity = v.rarity, price = v.price, desc = "" }
            itemConfigCache[k] = entry
            itemConfigCache[k .. " Fruit"] = entry
        end
    end

    return itemConfigCache
end

-- Resolves clean name, official icon, and metadata for any fruit
local function getFruitInfo(nameOrTool)
    if type(nameOrTool) == "table" and nameOrTool.cleanName and nameOrTool.rarity then
        return nameOrTool
    end

    local rawName = ""
    local origName = nil
    if typeof(nameOrTool) == "Instance" then
        rawName = nameOrTool.Name
        origName = nameOrTool:GetAttribute("OriginalName")
    elseif type(nameOrTool) == "string" then
        rawName = nameOrTool
    end

    local clean = cleanFruitKey(rawName)
    if origName and type(origName) == "string" and origName ~= "" then
        local parsed = cleanFruitKey(origName)
        if parsed ~= "" then clean = parsed end
    end

    local cfgMap = getItemConfigData()
    local meta = (origName and cfgMap[origName])
        or cfgMap[clean]
        or cfgMap[rawName]
        or (origName and DEFAULT_FRUITS_META[origName])
        or DEFAULT_FRUITS_META[clean]
        or DEFAULT_FRUITS_META[rawName]
        or {}

    local name = (meta.name and meta.name ~= "" and meta.name)
        or (clean ~= "" and clean)
        or (rawName ~= "" and rawName)
        or "Unknown"
    local rarity = meta.rarity or (DEFAULT_FRUITS_META[name] and DEFAULT_FRUITS_META[name].rarity) or "Common"
    local price = meta.price or (DEFAULT_FRUITS_META[name] and DEFAULT_FRUITS_META[name].price) or 0
    local desc = meta.desc or ""
    local iconUrl = FRUIT_ICONS[clean] or FRUIT_ICONS[name] or (origName and FRUIT_ICONS[origName])
    if not iconUrl then
        for baseFruit, url in pairs(FRUIT_ICONS) do
            if clean:find(baseFruit) or name:find(baseFruit) then
                iconUrl = url
                break
            end
        end
    end
    local color = RARITY_COLORS[rarity] or 0x06b6d4

    return {
        name = name,
        cleanName = clean,
        displayName = name .. " Fruit",
        rarity = rarity,
        price = price,
        desc = desc,
        iconUrl = iconUrl,
        color = color,
    }
end

-- ===================== Live Dashboard System & Persistence =====================
-- Safe executor filesystem wrappers (workspace/)
local fs = {
    writeFile  = (typeof(writefile) == "function" and writefile) or function() end,
    readFile   = (typeof(readfile) == "function" and readfile) or function() return "" end,
    isFile     = (typeof(isfile) == "function" and isfile) or function() return false end,
    isFolder   = (typeof(isfolder) == "function" and isfolder) or function() return false end,
    makeFolder = (typeof(makefolder) == "function" and makefolder) or function() end,
}

local httpRequest = (typeof(request) == "function" and request)
    or (typeof(http_request) == "function" and http_request)
    or (syn and typeof(syn.request) == "function" and syn.request)
    or (http and typeof(http.request) == "function" and http.request)

-- General configuration (workspace/FruitsHub/config.json)
-- Webhook fields are intentionally NOT in DEFAULT_CONFIG — they are
-- session-only values that must never be written to or read from disk.
-- Only the loader's getgenv() values are authoritative (see override below).
local DEFAULT_CONFIG = {
    ping_on_store = true, -- Ping on Discord when fruit is stored
    ping_role_id = "@everyone", -- Role or user to ping ("@everyone", "<@userId>", "<@&roleId>")
    min_rarity_for_alert = "All", -- "All", "Legendary", or "Mythical"
    emojis = {
        ["Magnet"]        = "🧲",
        ["Kitsune"]       = "",
        ["Dragon"]        = "",
        ["Leopard"]       = "",
        ["Dough"]         = "",
        ["T-Rex"]         = "",
        ["Mammoth"]       = "",
        ["Spirit"]        = "",
        ["Control"]       = "",
        ["Venom"]         = "",
        ["Shadow"]        = "",
        ["Buddha"]        = "",
        ["Portal"]        = "",
        ["Blizzard"]      = "",
        ["Rumble"]        = "",
        ["Sound"]         = "",
        ["Magma"]         = "",
        ["Light"]         = "",
        ["Ghost"]         = "",
    }
}

local Config = {}
for k, v in pairs(DEFAULT_CONFIG) do Config[k] = v end
-- Webhooks start empty; only set by getgenv() below — never from disk.
Config.dashboard_webhook = ""
Config.drops_webhook = ""

local function initConfig()
    pcall(function()
        if not fs.isFolder("FruitsHub") then
            fs.makeFolder("FruitsHub")
        end
        if not fs.isFolder("FruitsHub/accounts") then
            fs.makeFolder("FruitsHub/accounts")
        end

        -- Automatic migration from old brand if present
        if not fs.isFile("FruitsHub/config.json") and fs.isFile("MuyEstable/config.json") then
            local oldRaw = fs.readFile("MuyEstable/config.json")
            if oldRaw and oldRaw ~= "" then
                fs.writeFile("FruitsHub/config.json", oldRaw)
            end
        end

        if fs.isFile("FruitsHub/config.json") then
            local raw = fs.readFile("FruitsHub/config.json")
            local parsed = HttpService:JSONDecode(raw)
            if type(parsed) == "table" then
                for k, v in pairs(parsed) do
                    -- SECURITY: never load webhook fields from disk — doing so
                    -- would cause one user's webhook to bleed into another
                    -- user's session (or persist a developer's test webhook).
                    if k ~= "dashboard_webhook" and k ~= "drops_webhook" then
                        Config[k] = v
                    end
                end
            end
        else
            fs.writeFile("FruitsHub/config.json", HttpService:JSONEncode(DEFAULT_CONFIG))
        end
    end)
end
initConfig()

-- Override with execution loader parameters if specified.
-- These are the ONLY valid sources for webhook URLs.
if getgenv().Webhook and tostring(getgenv().Webhook) ~= "" then
    Config.dashboard_webhook = tostring(getgenv().Webhook)
end
if getgenv().DropsWebhook and tostring(getgenv().DropsWebhook) ~= "" then
    Config.drops_webhook = tostring(getgenv().DropsWebhook)
end

-- Account session data (workspace/FruitsHub/accounts/<Name>.json)
local accountFilePath = "FruitsHub/accounts/" .. LP.Name .. ".json"
local oldAccountFilePath = "MuyEstable/accounts/" .. LP.Name .. ".json"

local Session = {
    discord_message_id = nil,
    session_start = os.time(),
    initial_beli = 0,
    server_hops = 1,
    fruits_stored = 0,
    gacha_rolls = 0,
    recent_fruits = {},
    last_action = "Starting bot...",
    gacha_cooldown_end = 0,
    gacha_no_beli = false,
    gacha_cost = 0,
    quest_completed = 0,
    status_state = "normal", -- "normal", "gacha_ready", "storage_full", "error"
    storage_full_fruit = nil,
}

local cachedBeli = 0
local cachedLevel = 1

local function getPlayerData()
    pcall(function()
        -- 1. Try from Data (Blox Fruits standard)
        local data = LP:FindFirstChild("Data")
        if data then
            local b = data:FindFirstChild("Beli")
            if b and b:IsA("ValueBase") and b.Value > 0 then cachedBeli = b.Value end
            local l = data:FindFirstChild("Level")
            if l and l:IsA("ValueBase") and l.Value > 0 then cachedLevel = l.Value end
        end

        -- 2. Try from leaderstats
        local ls = LP:FindFirstChild("leaderstats")
        if ls then
            local b = ls:FindFirstChild("Beli")
            if b and b:IsA("ValueBase") and b.Value > 0 then cachedBeli = b.Value end
            local l = ls:FindFirstChild("Level")
            if l and l:IsA("ValueBase") and l.Value > 0 then cachedLevel = l.Value end
        end

        -- 3. Try from PlayerGui.Main if Values haven't replicated yet
        local pg = LP:FindFirstChild("PlayerGui")
        if pg then
            local main = pg:FindFirstChild("Main")
            if main then
                local bTxt = main:FindFirstChild("Beli")
                if bTxt and bTxt:IsA("TextLabel") and bTxt.Text ~= "" then
                    local cleanB = bTxt.Text:gsub("[^%d]", "")
                    local numB = tonumber(cleanB)
                    if numB and numB > 0 then cachedBeli = numB end
                end
                local lTxt = main:FindFirstChild("Level")
                if lTxt and lTxt:IsA("TextLabel") and lTxt.Text ~= "" then
                    local cleanL = lTxt.Text:gsub("[^%d]", "")
                    local numL = tonumber(cleanL)
                    if numL and numL > 0 then cachedLevel = numL end
                end
            end
        end
    end)
    return cachedBeli, cachedLevel
end

local function getSeaName()
    local pid = game.PlaceId
    if pid == 2753915549 then return "First Sea"
    elseif pid == 4442272183 then return "Second Sea"
    elseif pid == 7449423635 then return "Third Sea"
    end
    return "Main Sea"
end

local function formatDuration(seconds)
    if not seconds or seconds <= 0 then return "0m" end
    local h = math.floor(seconds / 3600)
    local m = math.floor((seconds % 3600) / 60)
    if h > 0 then
        return string.format("%dh %02dm", h, m)
    end
    return string.format("%dm", m)
end

local function formatCountdown(seconds)
    local rem = math.max(0, math.floor(tonumber(seconds) or 0))
    local h = math.floor(rem / 3600)
    local m = math.floor((rem % 3600) / 60)
    local s = rem % 60
    if h > 0 then
        return string.format("%dh %02dm %02ds", h, m, s)
    elseif m > 0 then
        return string.format("%dm %02ds", m, s)
    else
        return string.format("%ds", s)
    end
end

local function loadAccountSession()
    pcall(function()
        local path = accountFilePath
        if not fs.isFile(path) and fs.isFile(oldAccountFilePath) then
            path = oldAccountFilePath
        end

        if fs.isFile(path) then
            local raw = fs.readFile(path)
            local data = HttpService:JSONDecode(raw)
            if type(data) == "table" then
                Session.discord_message_id = data.discord_message_id
                Session.session_start = data.session_start or os.time()
                Session.initial_beli = data.initial_beli or 0
                Session.server_hops = (data.server_hops or 0) + 1
                Session.fruits_stored = data.fruits_stored or 0
                Session.gacha_rolls = data.gacha_rolls or 0
                Session.recent_fruits = data.recent_fruits or {}
                for _, rf in ipairs(Session.recent_fruits) do
                    if rf.source and tostring(rf.source):lower() == "suelo" then
                        rf.source = "Ground"
                    end
                    if rf.name then
                        rf.name = tostring(rf.name):gsub("%s*%b()", ""):gsub("^%s+", ""):gsub("%s+$", "")
                    end
                end
                Session.avatar_url = data.avatar_url
            end
        else
            local curBeli, _ = getPlayerData()
            Session.initial_beli = curBeli
            Session.server_hops = 1
        end
    end)
end

local function saveAccountSession()
    pcall(function()
        local payload = {
            account_name = LP.Name,
            discord_message_id = Session.discord_message_id,
            session_start = Session.session_start,
            initial_beli = Session.initial_beli,
            server_hops = Session.server_hops,
            fruits_stored = Session.fruits_stored,
            gacha_rolls = Session.gacha_rolls,
            recent_fruits = Session.recent_fruits,
            avatar_url = Session.avatar_url,
            last_saved = os.time(),
        }
        fs.writeFile(accountFilePath, HttpService:JSONEncode(payload))
    end)
end
loadAccountSession()

-- Resolves direct CDN headshot URL (tr.rbxcdn.com) so Discord renders it cleanly without 302 redirect errors
local cachedAvatarUrl = Session.avatar_url
local function getAvatarUrl()
    if cachedAvatarUrl and cachedAvatarUrl ~= "" then
        return cachedAvatarUrl
    end

    pcall(function()
        local url = "https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=" .. tostring(LP.UserId) .. "&size=150x150&format=Png&isCircular=false"
        local res = httpRequest({
            Url = url,
            Method = "GET",
        })
        if res and res.StatusCode == 200 and res.Body then
            local parsed = HttpService:JSONDecode(res.Body)
            if parsed and parsed.data and #parsed.data > 0 and parsed.data[1].imageUrl then
                cachedAvatarUrl = parsed.data[1].imageUrl
                Session.avatar_url = cachedAvatarUrl
                saveAccountSession()
            end
        end
    end)

    return cachedAvatarUrl or "https://cdn.discordapp.com/embed/avatars/0.png"
end

-- ===================== Live Dashboard Engine =====================
local updateDashboardUI = function() end
local DiscordDashboard = {}
local lastSyncTime = 0
local syncDebounceSecs = 10
local pendingSync = false

-- Build categorized inventory by rarity with Emojis
local function buildInventorySection()
    local counts = {
        Mythical = {},
        Legendary = {},
        Rare = {},
        Common = {},
    }
    local totalCount = 0

    for fruitKey, storedVal in pairs(Cfg.StoredFruits) do
        local qty = (type(storedVal) == "number" and storedVal) or 1
        local fInfo = getFruitInfo(fruitKey)
        local r = fInfo.rarity or "Common"
        local cat = "Common"
        if r == "Mythical" then cat = "Mythical"
        elseif r == "Legendary" then cat = "Legendary"
        elseif r == "Rare" then cat = "Rare"
        end

        local cName = (fInfo.name and fInfo.name ~= "" and fInfo.name) or fruitKey
        counts[cat][cName] = (counts[cat][cName] or 0) + qty
        totalCount = totalCount + qty
    end

    if totalCount == 0 then
        return "*(Syncing storage or no confirmed fruits yet)*", 0
    end

    local function formatCategory(catMap)
        local items = {}
        for name, qty in pairs(catMap) do
            if name and name ~= "" then
                local customEmoji = Config.emojis and Config.emojis[name]
                local prefix = (customEmoji and customEmoji ~= "") and (customEmoji .. " ") or ""
                local qtyStr = (qty > 1) and (" (" .. qty .. ")") or ""
                items[#items + 1] = prefix .. "**" .. name .. "**" .. qtyStr
            end
        end
        table.sort(items)
        return items
    end

    local lines = {}
    local myth = formatCategory(counts.Mythical)
    if #myth > 0 then
        lines[#lines + 1] = "**Mythical:**\n" .. table.concat(myth, "  •  ")
    end

    local leg = formatCategory(counts.Legendary)
    if #leg > 0 then
        lines[#lines + 1] = "**Legendary:**\n" .. table.concat(leg, "  •  ")
    end

    local rare = formatCategory(counts.Rare)
    if #rare > 0 then
        lines[#lines + 1] = "**Rare:**\n" .. table.concat(rare, "  •  ")
    end

    local com = formatCategory(counts.Common)
    if #com > 0 then
        if #com > 8 then
            local preview = {}
            for i = 1, 8 do preview[#preview + 1] = com[i] end
            lines[#lines + 1] = "**Common / Uncommon:**\n" .. table.concat(preview, "  •  ") .. " *(+" .. (#com - 8) .. " more)*"
        else
            lines[#lines + 1] = "**Common / Uncommon:**\n" .. table.concat(com, "  •  ")
        end
    end

    return table.concat(lines, "\n\n"), totalCount
end

-- Build Live Dashboard Embed payload
local function buildDashboardPayload()
    local curBeli, curLevel = getPlayerData()
    local beliDiff = curBeli - Session.initial_beli
    local beliDiffStr = ""
    if beliDiff > 0 then
        beliDiffStr = " (+$" .. formatBeli(beliDiff) .. ")"
    elseif beliDiff < 0 then
        beliDiffStr = " (-$" .. formatBeli(math.abs(beliDiff)) .. ")"
    end

    -- Gacha status
    local gachaText = "🟢 AVAILABLE NOW"
    local now = os.time()
    if AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming() then
        if curLevel < 50 then
            gachaText = string.format("⚔️ AutoQuest Level (%d/50)", curLevel)
        else
            local targetCost = (Session.gacha_cost and Session.gacha_cost > 0 and Session.gacha_cost) or (AutoQuestFarm.getGachaPrice and AutoQuestFarm.getGachaPrice()) or 0
            if Session.gacha_cooldown_end > now then
                gachaText = string.format("⚔️ AutoQuest Beli ($%s / $%s) · CD <t:%d:R>", formatBeli(curBeli), formatBeli(targetCost), Session.gacha_cooldown_end)
            else
                gachaText = string.format("⚔️ AutoQuest Beli ($%s / $%s)", formatBeli(curBeli), formatBeli(targetCost))
            end
        end
    elseif Session.gacha_cooldown_end > now then
        gachaText = "⏳ <t:" .. Session.gacha_cooldown_end .. ":R>"
    elseif Session.gacha_no_beli then
        if curBeli < Session.gacha_cost and Session.gacha_cost > 0 then
            gachaText = "🔴 Out of Beli ($" .. formatBeli(curBeli) .. " / $" .. formatBeli(Session.gacha_cost) .. ")"
        else
            Session.gacha_no_beli = false
        end
    end

    -- [TEMPORARY: MAGNET EVENT GACHA WEBHOOK - ELIMINAR EN 15 DÍAS]
    local gachaFieldName = "⏳ Gacha Roll"
    if Cfg.MagnetGacha and MagnetEvent and MagnetEvent.getTokenBalance then
        local magTokens = MagnetEvent.getTokenBalance()
        local magReady = MagnetEvent.canRoll and MagnetEvent.canRoll()
        if magReady then
            gachaFieldName = "⚡ Gacha Roll (Magnet Priority)"
            gachaText = "⚡ **MAGNET GACHA READY** (" .. tostring(magTokens) .. " Tokens)\n*Zioles: " .. gachaText .. "*"
        elseif magTokens > 0 then
            gachaText = gachaText .. "\n*⚡ Magnet Tokens: " .. tostring(magTokens) .. "/500*"
        end
    end
    -- [END TEMPORARY: MAGNET EVENT GACHA WEBHOOK]

    -- Card status color
    local color = 0x22c55e -- Green (normal)
    local stateTag = "🟢 Online"
    if Session.status_state == "storage_full" then
        color = 0xf97316 -- Orange
        stateTag = "🟠 STORAGE FULL"
    elseif Session.status_state == "gacha_ready" then
        color = 0xf59e0b -- Gold
        stateTag = "🟡 Gacha Ready"
    elseif Session.status_state == "error" then
        color = 0xef4444 -- Red
        stateTag = "🔴 Attention"
    end

    local avatarUrl = getAvatarUrl()
    local invText, totalStoredCount = buildInventorySection()
    local maxCap = getMaxFruitCap()
    local storageTitle = string.format("📦 FRUIT STORAGE (%d Stored · Cap: %d/fruit)", totalStoredCount, maxCap)

    local fields = {
        {
            name = "💰 Current Beli",
            value = "$" .. formatBeli(curBeli) .. beliDiffStr,
            inline = true,
        },
        {
            name = "⚓ Team / Sea",
            value = tostring(LP.Team and LP.Team.Name or "Marines") .. " • " .. getSeaName(),
            inline = true,
        },
        {
            name = gachaFieldName,
            value = gachaText,
            inline = true,
        },
        {
            name = "⚙️ CURRENT ACTIVITY",
            value = Session.last_action .. "\n*Server #" .. tostring(Session.server_hops) .. " • Session: `" .. string.sub(tostring(game.JobId), 1, 8) .. "...`*",
            inline = false,
        },
        {
            name = storageTitle,
            value = invText,
            inline = false,
        },
    }

    -- Session summary
    local uptimeStr = formatDuration(os.time() - Session.session_start)
    local lastSavedStr = "None yet"
    if #Session.recent_fruits > 0 then
        local lf = Session.recent_fruits[#Session.recent_fruits]
        local lfName = tostring(lf.name or "Fruit"):gsub("%s*%b()", ""):gsub("^%s+", ""):gsub("%s+$", "")
        local lfSrc = tostring(lf.source or "Ground")
        if lfSrc:lower() == "suelo" then lfSrc = "Ground" end
        lastSavedStr = "**" .. lfName .. "** (<t:" .. lf.time .. ":R> • " .. lfSrc .. ")"
    end

    fields[#fields + 1] = {
        name = "📊 SESSION SUMMARY",
        value = string.format("• **Uptime:** %s\n• **Servers Explored (Hops):** %d\n• **Quests Completed:** %d\n• **Fruits Stored Today:** %d\n• **Gacha Rolls:** %d\n• **Last Stored Fruit:** %s",
            uptimeStr, Session.server_hops, Session.quest_completed or 0, Session.fruits_stored, Session.gacha_rolls, lastSavedStr),
        inline = false,
    }

    local embed = {
        color = color,
        author = {
            name = LP.Name .. "  •  " .. stateTag .. "  (Level " .. tostring(curLevel) .. ")",
            icon_url = avatarUrl,
        },
        fields = fields,
        footer = { text = "FruitsHub · Blox Fruits · Updated" },
        timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    }

    -- Show official HD thumbnail if recent drop or target fruit is active
    if #Session.recent_fruits > 0 then
        local lf = Session.recent_fruits[#Session.recent_fruits]
        local fInfo = getFruitInfo(lf.name)
        if fInfo and fInfo.iconUrl and fInfo.iconUrl ~= "" then
            embed.thumbnail = { url = fInfo.iconUrl }
        end
    elseif Session.active_fruit_target then
        local fInfo = getFruitInfo(Session.active_fruit_target)
        if fInfo and fInfo.iconUrl and fInfo.iconUrl ~= "" then
            embed.thumbnail = { url = fInfo.iconUrl }
        end
    end

    return {
        username = "FruitsHub Dashboard",
        avatar_url = "https://cdn.discordapp.com/embed/avatars/0.png",
        embeds = { embed },
    }
end

-- Dashboard synchronization (POST ?wait=true or PATCH)
function DiscordDashboard.sync(force)
    pcall(updateDashboardUI)
    if not httpRequest or not Config.dashboard_webhook or Config.dashboard_webhook == "" then
        return
    end

    local now = os.clock()
    if not force and (now - lastSyncTime) < syncDebounceSecs then
        if not pendingSync then
            pendingSync = true
            task.delay(syncDebounceSecs - (now - lastSyncTime) + 1, function()
                pendingSync = false
                DiscordDashboard.sync(true)
            end)
        end
        return
    end
    lastSyncTime = now

    task.spawn(function()
        local payload = buildDashboardPayload()
        local jsonBody = HttpService:JSONEncode(payload)

        -- Case A: Message ID exists -> Try PATCH
        if Session.discord_message_id and Session.discord_message_id ~= "" then
            local patchUrl = Config.dashboard_webhook .. "/messages/" .. Session.discord_message_id
            local okPatch, resPatch = pcall(function()
                return httpRequest({
                    Url = patchUrl,
                    Method = "PATCH",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = jsonBody,
                })
            end)

            if okPatch and type(resPatch) == "table" then
                if resPatch.StatusCode == 200 or resPatch.StatusCode == 204 then
                    saveAccountSession()
                    return -- Full success
                elseif resPatch.StatusCode == 404 then
                    -- Deleted in Discord: reset ID to trigger fresh POST
                    warn("[FruitsHub] Dashboard message not found on Discord (404). Creating a new one...")
                    Session.discord_message_id = nil
                else
                    warn("[FruitsHub] PATCH Dashboard responded: " .. tostring(resPatch.StatusCode))
                end
            end
        end

        -- Case B: No message_id or failed with 404 -> POST ?wait=true
        if not Session.discord_message_id or Session.discord_message_id == "" then
            local postUrl = Config.dashboard_webhook .. "?wait=true"
            local okPost, resPost = pcall(function()
                return httpRequest({
                    Url = postUrl,
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = jsonBody,
                })
            end)

            if okPost and type(resPost) == "table" and resPost.StatusCode and resPost.StatusCode >= 200 and resPost.StatusCode < 300 then
                local dOk, bodyData = pcall(function()
                    return HttpService:JSONDecode(resPost.Body)
                end)
                if dOk and bodyData and bodyData.id then
                    Session.discord_message_id = tostring(bodyData.id)
                    saveAccountSession()
                    print("[FruitsHub] Live Dashboard successfully linked. ID: " .. Session.discord_message_id)
                end
            else
                warn("[FruitsHub] Failed to create Dashboard message (POST ?wait=true)")
            end
        end
    end)
end

-- Ghost Ping on main account dashboard: Edit (with mention) -> Wait 0.8s -> Edit (clear mention)
function DiscordDashboard.ghostPing(pingStr)
    pcall(updateDashboardUI)
    if not httpRequest or not Config.dashboard_webhook or Config.dashboard_webhook == "" then
        return
    end

    task.spawn(function()
        local payload = buildDashboardPayload()
        payload.content = pingStr or "@everyone"
        local jsonWithPing = HttpService:JSONEncode(payload)

        -- If no message ID exists yet, create it with ping via POST ?wait=true
        if not Session.discord_message_id or Session.discord_message_id == "" then
            local postUrl = Config.dashboard_webhook .. "?wait=true"
            local okPost, resPost = pcall(function()
                return httpRequest({
                    Url = postUrl,
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = jsonWithPing,
                })
            end)

            if okPost and type(resPost) == "table" and resPost.StatusCode and resPost.StatusCode >= 200 and resPost.StatusCode < 300 then
                local dOk, bodyData = pcall(function() return HttpService:JSONDecode(resPost.Body) end)
                if dOk and bodyData and bodyData.id then
                    Session.discord_message_id = tostring(bodyData.id)
                    saveAccountSession()
                    print("[FruitsHub] Live Dashboard linked with ghost ping. ID: " .. Session.discord_message_id)
                end
            end
        else
            -- Step 1: Edit existing dashboard with mention
            local patchUrl = Config.dashboard_webhook .. "/messages/" .. Session.discord_message_id
            local okPatch, resPatch = pcall(function()
                return httpRequest({
                    Url = patchUrl,
                    Method = "PATCH",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = jsonWithPing,
                })
            end)

            if okPatch and type(resPatch) == "table" and resPatch.StatusCode == 404 then
                Session.discord_message_id = nil
                DiscordDashboard.ghostPing(pingStr)
                return
            end
        end

        if not Session.discord_message_id or Session.discord_message_id == "" then
            return
        end

        -- Step 2: Short delay so Discord client dispatches push notification / mention
        task.wait(0.8)

        -- Step 3: Edit again removing the mention text, keeping the clean dashboard embed
        payload.content = ""
        local jsonClean = HttpService:JSONEncode(payload)
        local patchCleanUrl = Config.dashboard_webhook .. "/messages/" .. Session.discord_message_id
        pcall(function()
            return httpRequest({
                Url = patchCleanUrl,
                Method = "PATCH",
                Headers = { ["Content-Type"] = "application/json" },
                Body = jsonClean,
            })
        end)
    end)
end

-- ===================== Valuable Drops Notifier & Ghost Ping =====================
local function notifyValuableDrop(fruitTarget, source)
    if not httpRequest then return end
    local fInfo = getFruitInfo(fruitTarget)
    if not fInfo or not fInfo.rarity then return end

    -- Filter rarity
    local r = fInfo.rarity or "Common"
    local minRarity = Config.min_rarity_for_alert or "All"
    local isValuable = false
    if minRarity == "All" then
        isValuable = true
    elseif minRarity == "Mythical" then
        isValuable = (r == "Mythical")
    else
        isValuable = (r == "Mythical" or r == "Legendary")
    end

    local pingStr = ""
    if isValuable and Config.ping_on_store ~= false then
        if Config.ping_role_id and Config.ping_role_id ~= "" then
            pingStr = Config.ping_role_id
        else
            pingStr = "@everyone"
        end
    end

    -- Trigger ghost ping on the main account dashboard
    if isValuable and pingStr ~= "" then
        DiscordDashboard.ghostPing(pingStr)
    else
        DiscordDashboard.sync(true)
    end

    -- Dedicated drops channel: only send separate card if drops_webhook is set and different from dashboard_webhook
    if isValuable and Config.drops_webhook and Config.drops_webhook ~= "" and Config.drops_webhook ~= Config.dashboard_webhook then
        local title = "📦 FRUIT STORED IN CHEST!"
        if r == "Mythical" then
            title = "🚨 NEW MYTHICAL FRUIT STORED!"
        elseif r == "Legendary" then
            title = "⭐ NEW LEGENDARY FRUIT STORED!"
        end

        local desc = "**" .. LP.Name .. "** has successfully stored a **" .. fInfo.displayName .. "** in the chest."

        local dropEmbed = {
            color = fInfo.color or 0x22c55e,
            title = title,
            description = desc,
            fields = {
                { name = "⭐ Rarity", value = fInfo.rarity, inline = true },
                { name = "💰 Value", value = "$" .. formatBeli(fInfo.price) .. " Beli", inline = true },
                { name = "📍 Method", value = tostring(source or "Unknown"), inline = true },
                { name = "👤 Account", value = LP.Name, inline = true },
            },
            footer = { text = "FruitsHub · Blox Fruits" },
            timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ"),
        }

        if fInfo.iconUrl and fInfo.iconUrl ~= "" then
            dropEmbed.thumbnail = { url = fInfo.iconUrl }
        end

        task.spawn(function()
            pcall(function()
                httpRequest({
                    Url = Config.drops_webhook,
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json" },
                    Body = HttpService:JSONEncode({
                        username = "FruitsHub Storage",
                        avatar_url = "https://cdn.discordapp.com/embed/avatars/0.png",
                        embeds = { dropEmbed },
                    })
                })
            end)
        end)
    end
end

-- ===================== Unified DiscordAlerts Adapter =====================
-- Maintains full compatibility while keeping console logs clean and informative
local DiscordAlerts = {}

DiscordAlerts.setActivity = function(act)
    Session.last_action = tostring(act)
    DiscordDashboard.sync(false)
end

DiscordAlerts.info = function(desc, title)
    print("[FruitsHub Info] " .. tostring(title or "") .. ": " .. tostring(desc or ""))
end

DiscordAlerts.warn = function(desc, title)
    print("[FruitsHub Warning] " .. tostring(title or "") .. ": " .. tostring(desc or ""))
end

DiscordAlerts.error = function(desc, title)
    warn("[FruitsHub Error] " .. tostring(title or "") .. ": " .. tostring(desc or ""))
end

DiscordAlerts.fruit = function(fruitTarget, dist)
    local fInfo = getFruitInfo(fruitTarget)
    Session.active_fruit_target = fruitTarget
    local distText = dist and (tostring(math.floor(dist)) .. " studs") or ""
    Session.last_action = "Moving towards " .. fInfo.displayName .. " (" .. distText .. ")"
    DiscordDashboard.sync(false)
end

DiscordAlerts.collected = function(fruitTarget)
    local fInfo = getFruitInfo(fruitTarget)
    Session.last_action = "Storing " .. fInfo.displayName .. "..."
    DiscordDashboard.sync(false)
end

DiscordAlerts.stored = function(fruitTarget)
    local fInfo = getFruitInfo(fruitTarget)
    Session.fruits_stored = Session.fruits_stored + 1
    Session.status_state = "normal"
    Session.last_action = "Stored: " .. fInfo.displayName

    table.insert(Session.recent_fruits, {
        name = fInfo.name,
        time = os.time(),
        source = "Ground",
    })
    if #Session.recent_fruits > 5 then
        table.remove(Session.recent_fruits, 1)
    end

    saveAccountSession()
    notifyValuableDrop(fruitTarget, "Ground")
end

DiscordAlerts.rolled = function(fruitTarget, boxName)
    local fInfo = getFruitInfo(fruitTarget)
    Session.gacha_rolls = Session.gacha_rolls + 1
    Session.status_state = "normal"

    -- [TEMPORARY: MAGNET EVENT GACHA ALERT - ELIMINAR EN 15 DÍAS]
    local isMagnet = (boxName == "MagnetEventGacha26")
    local rollTitle = isMagnet and "⚡ Magnet Gacha: " or ("Gacha Roll (" .. tostring(boxName) .. "): ")
    local rollSource = isMagnet and "Magnet Gacha" or "Gacha"
    -- [END TEMPORARY: MAGNET EVENT GACHA ALERT]

    Session.last_action = rollTitle .. fInfo.displayName

    table.insert(Session.recent_fruits, {
        name = fInfo.name,
        time = os.time(),
        source = rollSource,
    })
    if #Session.recent_fruits > 5 then
        table.remove(Session.recent_fruits, 1)
    end

    saveAccountSession()
    notifyValuableDrop(fruitTarget, rollSource)
end

DiscordAlerts.storageFull = function(fruitTarget, capacity)
    local fInfo = getFruitInfo(fruitTarget)
    Session.status_state = "storage_full"
    Session.storage_full_fruit = fInfo.displayName
    Session.last_action = "⚠️ Storage full for " .. fInfo.displayName .. " (Limit: " .. tostring(capacity) .. ")"
    DiscordDashboard.sync(true)
end

DiscordAlerts.skipped = function()
    -- 100% silent (zero spam)
end

DiscordAlerts.storageStatus = function()
    DiscordDashboard.sync(true)
end

DiscordAlerts.setGachaCooldown = function(secs)
    if type(secs) == "number" and secs > 0 then
        Session.gacha_cooldown_end = os.time() + math.floor(secs)
        Session.gacha_no_beli = false
        DiscordDashboard.sync(false)
    end
end

DiscordAlerts.setGachaNoBeli = function(curBeli, cost)
    Session.gacha_no_beli = true
    Session.gacha_cost = cost or 0
    DiscordDashboard.sync(false)
end

-- Synchronize first Live Dashboard card
task.defer(function()
    task.wait(2)
    DiscordDashboard.sync(true)
end)

-- ===================== GUI Status State =====================
local onStatusCallback = nil
local statusBaseMsg = ""
local function setStatus(msg)
    statusBaseMsg = tostring(msg)
    local cb = onStatusCallback
    if cb then cb(statusBaseMsg) end
    print("[FruitsHub] " .. statusBaseMsg)
end

local function setStatusErr(msg)
    statusBaseMsg = tostring(msg)
    local cb = onStatusCallback
    if cb then cb(statusBaseMsg) end
    warn("[FruitsHub] " .. statusBaseMsg)
end

-- ===================== Character Lifecycle & Death Recovery =====================
local CharacterState = {
    isDead = false,
    diedAt = 0,
    respawnCount = 0,
    lastRespawnAt = 0,
    currentActivity = "IDLE", -- "AUTO_QUEST", "COLLECT_FRUIT", "MAGNET_EVENT", "IDLE"
    currentActivityData = nil,
    respawnCallbacks = {}
}

local function isAlive(char)
    char = char or LP.Character
    if not char or not char.Parent then return false end
    local hum = char:FindFirstChildOfClass("Humanoid")
    local root = char:FindFirstChild("HumanoidRootPart")
    return hum ~= nil and hum.Health > 0 and root ~= nil
end

local function setBotActivity(actType, actData)
    CharacterState.currentActivity = actType or "IDLE"
    CharacterState.currentActivityData = actData
end

local function getBotActivity()
    return CharacterState.currentActivity, CharacterState.currentActivityData
end

local function registerRespawnCallback(cb)
    if type(cb) == "function" then
        table.insert(CharacterState.respawnCallbacks, cb)
    end
end

local function waitForChar(timeout)
    timeout = timeout or 30
    local startT = os.clock()
    while (os.clock() - startT < timeout) do
        local c = LP.Character
        if c and c.Parent then
            local root = c:FindFirstChild("HumanoidRootPart")
            local hum = c:FindFirstChildOfClass("Humanoid")
            if root and hum and hum.Health > 0 then
                task.wait(0.3)
                return c
            end
        end
        task.wait(0.2)
    end
    return LP.Character
end

local function ensureAlive(timeout)
    if isAlive() then return true end
    setStatus("Character waiting for respawn...")
    local c = waitForChar(timeout or 35)
    return isAlive(c)
end

local function getHum()
    local ch = LP.Character
    if not ch then return nil end
    return ch:FindFirstChildOfClass("Humanoid")
end

local function getRoot()
    local ch = LP.Character
    if not ch then return nil end
    return ch:FindFirstChild("HumanoidRootPart")
end

local function setupCharacterLifecycle()
    local function hookCharacter(char)
        if not char then return end
        local hum = char:WaitForChild("Humanoid", 10)
        local root = char:WaitForChild("HumanoidRootPart", 10)
        if not hum or not root then return end

        CharacterState.isDead = false
        CharacterState.lastRespawnAt = tick()
        CharacterState.respawnCount = CharacterState.respawnCount + 1

        local deathConn
        local healthConn

        local function handleDeath()
            if CharacterState.isDead then return end
            CharacterState.isDead = true
            CharacterState.diedAt = tick()
            setStatusErr(string.format("⚠️ Character died! Activity was '%s'. Waiting for respawn...", CharacterState.currentActivity))

            pcall(function()
                if stopTween then stopTween() end
                if stopQuestTween then stopQuestTween() end
                if setQuestHoverBV then setQuestHoverBV(false) end
            end)

            if deathConn then deathConn:Disconnect(); deathConn = nil end
            if healthConn then healthConn:Disconnect(); healthConn = nil end
        end

        deathConn = hum.Died:Connect(handleDeath)
        healthConn = hum.HealthChanged:Connect(function(hp)
            if hp <= 0 then
                handleDeath()
            end
        end)
    end

    if LP.Character then
        task.spawn(function() hookCharacter(LP.Character) end)
    end

    LP.CharacterAdded:Connect(function(newChar)
        task.spawn(function()
            hookCharacter(newChar)
            local c = waitForChar(25)
            if c and isAlive(c) then
                setStatus(string.format("Character ready! Resuming activity: %s", CharacterState.currentActivity))
                task.wait(0.4)
                pcall(autoAssignStats)

                for _, cb in ipairs(CharacterState.respawnCallbacks) do
                    pcall(cb, c)
                end
            end
        end)
    end)
end

-- ===================== Team (Marines) =====================
function Cfg.JoinTeam(team)
    team = team or Cfg.Team
    if not game.Teams:FindFirstChild(team) then
        return false
    end
    setStatus("Joining " .. team .. "...")
    local ok, res = pcall(function()
        return CommF_:InvokeServer("SetTeam2", team)
    end)
    if ok then
        setStatus("Requested to join " .. team .. "...")
        return true
    end
    setStatusErr("Failed to join " .. team .. ": " .. tostring(res))
    return false
end

-- ===================== Fruit Search & Discrimination =====================
local function fruitPart(fruit)
    if not fruit then return nil end
    if fruit:IsA("BasePart") then return fruit end
    local h = fruit:FindFirstChild("Handle")
    if h and h:IsA("BasePart") then return h end
    if fruit:IsA("Model") then
        local p = fruit.PrimaryPart
        if p and p:IsA("BasePart") then return p end
        return fruit:FindFirstChildWhichIsA("BasePart")
    end
    return nil
end

local function fruitDisplayName(fruit)
    local n = typeof(fruit) == "Instance" and fruit.Name or tostring(fruit)
    n = n:gsub("%s*%[.*%]$", "")
    n = n:gsub("%s*%(.*%)$", "")
    return n
end

local function isDroppedFruit(tool)
    if not tool or not tool:IsA("Tool") then return false end
    if tool:IsDescendantOf(workspace:FindFirstChild("Characters")) then return false end
    if not (tool:FindFirstChild("Handle") and tool.Handle:IsA("BasePart")) then return false end
    local attrs = tool:GetAttributes()
    if type(attrs.DroppedAt) == "number" then return true end
    if attrs.WaitForHandle == true then return true end
    if type(attrs.DroppedBy) == "string" or type(attrs.OriginalName) == "string" then return true end
    return false
end

local function isFruit(tool)
    if not tool or not tool:IsA("Tool") then return false end
    if tool:GetAttribute("WeaponType") ~= nil then return false end
    if tool:GetAttribute("ConsoleTool") == true then return false end
    if tool:FindFirstChild("EatRemote", true) then return true end
    local orig = tool:GetAttribute("OriginalName")
    if type(orig) == "string" and orig ~= "" and not tool:GetAttribute("WeaponType") then return true end
    if tool:GetAttribute("WaitForHandle") == true or tool:GetAttribute("DroppedAt") ~= nil then return true end
    if tool.Name:match("Fruit") and tool:FindFirstChild("Handle") then return true end
    return false
end

local function fruitSpawnsFolder()
    local out = {}
    for _, v in ipairs(workspace:GetChildren()) do
        if v:IsA("Tool") and isDroppedFruit(v) then
            out[#out + 1] = v
        end
    end
    return out
end

-- ===================== Stored Fruits Registry =====================
local function markStored(tool)
    local rawName = typeof(tool) == "Instance" and tool.Name or tostring(tool)
    local origName = typeof(tool) == "Instance" and tool:GetAttribute("OriginalName") or nil
    local clean = cleanFruitKey(origName or rawName)
    if clean ~= "" then
        Cfg.StoredFruits[clean] = (Cfg.StoredFruits[clean] or 0) + 1
    end
end

local function isStoredAlready(nameOrTool)
    local rawName = typeof(nameOrTool) == "Instance" and nameOrTool.Name or tostring(nameOrTool)
    local origName = typeof(nameOrTool) == "Instance" and nameOrTool:GetAttribute("OriginalName") or nil
    local clean = cleanFruitKey(origName or rawName)
    local maxCap = getMaxFruitCap()
    local cur = Cfg.StoredFruits[clean]
    local curQty = (type(cur) == "number" and cur) or (cur == true and maxCap) or 0
    return curQty >= maxCap
end

local fruitScanLock = false
local found = { model = nil, fname = nil, pos = nil }
local scanState = "none"

local function scanForFruit()
    if fruitScanLock then return end
    fruitScanLock = true
    task.spawn(function()
        setStatus("Scanning map for fruits...")
        local fs = fruitSpawnsFolder()
        local tname
        local bestDist = math.huge
        local got = nil
        local skippedCount = 0

        for _, v in ipairs(fs) do
            local part = fruitPart(v)
            if part then
                local pos = part.Position
                if pos.Magnitude > 1 then
                    if isStoredAlready(v) then
                        skippedCount = skippedCount + 1
                        local sname = fruitDisplayName(v)
                        setStatus("⏭️ " .. sname .. " — already stored, skipping.")
                        DiscordAlerts.skipped(v)
                    else
                        local root = LP.Character and LP.Character:FindFirstChild("HumanoidRootPart")
                        local d = root and (root.Position - pos).Magnitude or math.huge
                        if d < bestDist then
                            bestDist = d
                            tname = fruitDisplayName(v)
                            got = { model = v, fname = tname, pos = pos }
                        end
                    end
                end
            end
        end

        if got then
            found = got
            scanState = "fruit"
            if skippedCount > 0 then
                setStatus("Found fruit: " .. tname .. " (" .. math.floor(bestDist) .. " studs). " .. skippedCount .. " already stored fruit(s) skipped.")
            else
                setStatus("Found fruit: " .. tname .. " (" .. math.floor(bestDist) .. " studs)")
            end
            DiscordAlerts.fruit(got.model, bestDist)
        elseif skippedCount > 0 then
            found = { model = nil, fname = nil, pos = nil }
            scanState = "stored"
            setStatus("All " .. skippedCount .. " fruit(s) on the map are already in storage. Server hop required.")
            DiscordAlerts.skipped(nil, skippedCount)
        else
            found = { model = nil, fname = nil, pos = nil }
            scanState = "none"
            setStatus("No fruits found on the map.")
        end
        fruitScanLock = false
    end)
end

-- ===================== Anti-Rollback Segmented Flight Engine =====================
local tweenConnection = nil
local noClipConnection = nil
local currentTween = nil
local deathConnection = nil
local flightBodyVelocity = nil

local function ensureFlightBV(r)
    if not r then return nil end
    if not flightBodyVelocity or flightBodyVelocity.Parent ~= r then
        local existing = r:FindFirstChild("EffectsSY") or r:FindFirstChild("FruitsHubFlightBV")
        if existing and existing:IsA("BodyVelocity") then
            flightBodyVelocity = existing
        else
            flightBodyVelocity = Instance.new("BodyVelocity")
            flightBodyVelocity.Name = "EffectsSY"
            flightBodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)
            flightBodyVelocity.Velocity = Vector3.zero
            flightBodyVelocity.Parent = r
        end
    end
    flightBodyVelocity.Velocity = Vector3.zero
    return flightBodyVelocity
end

local function removeFlightBV()
    if flightBodyVelocity then
        pcall(function() flightBodyVelocity:Destroy() end)
        flightBodyVelocity = nil
    end
    local r = getRoot()
    if r then
        for _, name in ipairs({"EffectsSY", "FruitsHubFlightBV"}) do
            local existing = r:FindFirstChild(name)
            if existing then
                pcall(function() existing:Destroy() end)
            end
        end
    end
end

stopTween = function()
    if currentTween then
        pcall(function() currentTween:Cancel() end)
        currentTween = nil
    end
    if tweenConnection then
        tweenConnection:Disconnect()
        tweenConnection = nil
    end
    if noClipConnection then
        noClipConnection:Disconnect()
        noClipConnection = nil
    end
    if deathConnection then
        deathConnection:Disconnect()
        deathConnection = nil
    end
    removeFlightBV()
    local hum = getHum()
    if hum then pcall(function() hum.PlatformStand = false end) end
end

local function forceStand()
    local hum = getHum()
    if not hum then return true end
    if not (hum.Sit or hum.SeatPart) then return true end
    setStatus("Standing up from seat...")
    hum.Sit = false
    pcall(function()
        local seat = hum.SeatPart
        if seat and seat:IsA("VehicleSeat") then
            seat:SetAttribute("noStand", nil)
            seat.Occupant = nil
        end
    end)
    local guard = 0
    while (hum.Sit or hum.SeatPart) and guard < 30 do
        task.wait()
        guard = guard + 1
    end
    if hum.Sit or hum.SeatPart then
        pcall(function()
            hum:ChangeState(Enum.HumanoidStateType.GettingUp)
        end)
        task.wait(0.5)
    end
    return not (hum.Sit or hum.SeatPart)
end

-- ===================== Enrutamiento Insular (Arquitectura HoHo Hub) =====================
local function getIslandWaypoints()
    local locsFolder = workspace:FindFirstChild("_WorldOrigin") and workspace._WorldOrigin:FindFirstChild("Locations")
    local wps = {}
    if locsFolder then
        for _, obj in ipairs(locsFolder:GetChildren()) do
            if obj:IsA("BasePart") then
                table.insert(wps, obj.Position)
            elseif obj:IsA("Model") then
                table.insert(wps, obj:GetPivot().Position)
            end
        end
    end
    return wps
end

local function findBestMidWaypoint(startPos, targetPos, waypoints)
    local directDist = (targetPos - startPos).Magnitude
    if directDist < 1800 or #waypoints == 0 then return nil end

    local bestWp = nil
    local bestScore = math.huge

    for _, wp in ipairs(waypoints) do
        local dStart = (wp - startPos).Magnitude
        local dTarget = (targetPos - wp).Magnitude
        if dStart > 300 and dTarget > 300 and (dStart < directDist * 0.85) and (dTarget < directDist * 0.85) then
            local score = dStart + dTarget
            if score < bestScore then
                bestScore = score
                bestWp = wp
            end
        end
    end

    if bestWp and bestScore < (directDist * 1.35) then
        return bestWp
    end
    return nil
end

-- ===================== Motor de Vuelo Continuo Anti-Rollback =====================
-- 1. BodyVelocity 'EffectsSY' (100k MaxForce, 0 vel) mantiene física gravitacional nula.
-- 2. NoClip continuo en Stepped apagando CanCollide (SIN anular AssemblyLinearVelocity que desincronizaba con el servidor).
-- 3. Velocidad fijada a 164 studs/s (límite exacto de HoHo Hub probado bajo el radar del anticheat de Blox Fruits).
-- 4. Interpolación CFrame continua y limpia (TweenService:Create con EasingStyle.Linear, EasingDirection.Out).
-- 5. Puenteo por waypoints insulares en trayectos largos (>1800 studs) para no cruzar el vacío del océano.
-- 6. Neutralización del script local "Fling and Underwater Glitching Fix" desvinculando GlitchCheck.
local function safeFlightTo(targetPos, options)
    options = options or {}
    if typeof(targetPos) == "CFrame" then
        targetPos = targetPos.Position
    elseif typeof(targetPos) ~= "Vector3" then
        return false
    end

    local root = getRoot()
    if not root then return false end
    local hum = getHum()
    if not hum or hum.Health <= 0 then return false end

    local curPos = root.Position
    local totalDist = (targetPos - curPos).Magnitude
    if totalDist < 2 then
        if options.onArrive then options.onArrive(options.fruitTarget) end
        return true
    end

    local speed = math.min(options.speed or Cfg.Speed or 164, 164)
    local interruptCheck = options.interruptCheck
    local runAliveFunc = options.runAliveFunc
    local onArrive = options.onArrive
    local fruitTarget = options.fruitTarget
    local keepBV = options.keepBV

    forceStand()
    stopTween()

    -- Neutralizar detector cliente de fling/glitching
    pcall(function() RunService:UnbindFromRenderStep("GlitchCheck") end)

    -- 1. Anti-Gravedad EffectsSY
    ensureFlightBV(root)

    -- 2. NoClip continuo
    noClipConnection = RunService.Stepped:Connect(function()
        local c = LP.Character
        if not c then return end
        for _, p in ipairs(c:GetDescendants()) do
            if p:IsA("BasePart") and p.CanCollide then
                p.CanCollide = false
            end
        end
    end)

    deathConnection = hum.Died:Connect(function()
        stopTween()
        setStatusErr("Character died during flight.")
    end)

    -- 3. Tramo de vuelo continuo
    local function flyLeg(destVec)
        local curRoot = getRoot()
        if not curRoot then return false end

        -- Altitud segura de crucero sobre el océano (mínimo Y=45 para evitar estado Swimming y oleaje)
        local safeY = math.max(destVec.Y, 45)
        local destPos = Vector3.new(destVec.X, safeY, destVec.Z)

        local pStart = curRoot.Position
        local dist = (destPos - pStart).Magnitude
        if dist < 2 then return true end

        local dur = dist / speed
        local tweenInfo = TweenInfo.new(dur, Enum.EasingStyle.Linear, Enum.EasingDirection.Out)
        local tw = TweenService:Create(curRoot, tweenInfo, { CFrame = CFrame.new(destPos) })
        currentTween = tw

        local completed = false
        local conn = tw.Completed:Connect(function()
            completed = true
        end)
        tw:Play()

        local tLimit = os.clock() + dur + 3.0
        while not completed and os.clock() < tLimit do
            if not isAlive() then
                tw:Cancel()
                conn:Disconnect()
                stopTween()
                return "DEATH_INTERRUPT"
            end
            if (runAliveFunc and not runAliveFunc())
                or (interruptCheck and interruptCheck())
                or (fruitTarget and not fruitTarget.Parent) then
                tw:Cancel()
                conn:Disconnect()
                stopTween()
                return false
            end
            task.wait(0.1)
        end
        conn:Disconnect()
        return true
    end

    -- En distancias inter-islas largas (> 1800 studs), navegar usando waypoints insulares intermedios
    if totalDist > 1800 then
        local waypoints = getIslandWaypoints()
        local midWp = findBestMidWaypoint(curPos, targetPos, waypoints)
        if midWp then
            local midDest = Vector3.new(midWp.X, math.max(midWp.Y, 50), midWp.Z)
            local midRes = flyLeg(midDest)
            if midRes == "DEATH_INTERRUPT" then
                stopTween()
                return "DEATH_INTERRUPT"
            elseif not midRes then
                stopTween()
                return false
            end
        end
    end

    -- Tramo final directo al objetivo
    local finalRes = flyLeg(targetPos)
    if finalRes == "DEATH_INTERRUPT" then
        stopTween()
        return "DEATH_INTERRUPT"
    elseif not finalRes then
        stopTween()
        return false
    end

    -- Si el destino original está por debajo de Y=45 (suelo / cofre / fruta), descender suavemente
    if isAlive() and targetPos.Y < 45 then
        local curRoot = getRoot()
        if curRoot then
            local dropTw = TweenService:Create(curRoot, TweenInfo.new(0.3, Enum.EasingStyle.Linear), { CFrame = CFrame.new(targetPos) })
            currentTween = dropTw
            dropTw:Play()
            task.wait(0.3)
        end
    end

    if not keepBV then
        stopTween()
    else
        if currentTween then
            pcall(function() currentTween:Cancel() end)
            currentTween = nil
        end
        if tweenConnection then
            tweenConnection:Disconnect()
            tweenConnection = nil
        end
    end

    if onArrive then onArrive(fruitTarget) end
    return true
end

local function tweenTo(fruit, onArrive)
    setBotActivity("COLLECT_FRUIT", fruit)
    local prim = fruitPart(fruit)
    if not prim then return false end
    return safeFlightTo(prim.Position, {
        speed = 164,
        fruitTarget = fruit,
        onArrive = onArrive
    })
end

-- ===================== Fruit Collection (Instant Touch) =====================
local function collectFruit(fruit)
    local fname = fruitDisplayName(fruit)
    local origName = fruit:GetAttribute("OriginalName")
    setStatus("Collecting fruit: " .. fname)
    forceStand()

    local prim = fruitPart(fruit)
    local root = getRoot()

    -- 1) Instant pickup via firetouchinterest (0.05s)
    if prim and root and typeof(firetouchinterest) == "function" then
        pcall(function()
            firetouchinterest(root, prim, 0)
            task.wait(0.05)
            firetouchinterest(root, prim, 1)
        end)
        task.wait(0.2)
    end

    -- 2) Drag sweep fallback if fruit remains on ground
    if fruit.Parent then
        local function dragThrough(handleCFrame, axis)
            local r = getRoot()
            if not r then return end
            for i = 0, 11 do
                local t = i / 11
                local off = -1.8 + (3.6 * t)
                local localOff = axis == "x" and Vector3.new(off, 0, 0) or Vector3.new(0, 0, off)
                r.CFrame = handleCFrame * CFrame.new(localOff)
                task.wait(0.05)
                if not fruit.Parent then return end
            end
        end
        local sweeps = {
            { "z", CFrame.new(0, 0, 0) },
            { "x", CFrame.new(0, 0, 0) },
            { "z", CFrame.new(0, -1.5, 0) },
            { "x", CFrame.new(0, -1.5, 0) },
        }
        for _, sw in ipairs(sweeps) do
            local p = fruitPart(fruit)
            if not p then break end
            dragThrough(p.CFrame * sw[2], sw[1])
            if not fruit.Parent then break end
            task.wait(0.1)
        end
    end

    if not fruit.Parent then
        setStatus("Fruit collected: " .. fname .. "! Searching for Tool in inventory...")
        DiscordAlerts.collected(fruit)

        local target = origName
        for _ = 1, 10 do
            local ch = LP.Character
            if ch then
                for _, t in ipairs(ch:GetChildren()) do
                    if isFruit(t) then
                        if not target or t:GetAttribute("OriginalName") == target or t.Name:find(fname, 1, true) then
                            return t
                        end
                    end
                end
            end
            if LP.Backpack then
                for _, t in ipairs(LP.Backpack:GetChildren()) do
                    if isFruit(t) then
                        if not target or t:GetAttribute("OriginalName") == target or t.Name:find(fname, 1, true) then
                            return t
                        end
                    end
                end
            end
            task.wait(0.2)
        end
        if fruit:IsA("Tool") and not fruit.Parent then
            return fruit
        end
        DiscordAlerts.warn("**" .. fname .. "** was collected but its Tool was not found in inventory.", "⚠️ Tool not found")
    end
    setBotActivity("IDLE")
    return nil
end

-- ===================== Store Fruit in Storage =====================
local function storeFruit(tool)
    local display = fruitDisplayName(tool)
    local originalName = tool:GetAttribute("OriginalName")
    if not originalName then
        for _, attrVal in pairs(tool:GetAttributes()) do
            if type(attrVal) == "string" and attrVal:find("-") then
                originalName = attrVal
                break
            end
        end
    end
    if not originalName then
        local raw = tool.Name:gsub("%s*Fruit", ""):gsub("%s*%[.*%]", "")
        local clean = cleanFruitKey(raw)
        local fInfo = getFruitInfo(clean)
        originalName = (fInfo and fInfo.cleanName and (fInfo.cleanName .. "-" .. fInfo.cleanName))
            or (clean .. "-" .. clean)
    end

    -- Ensure tool is equipped or held
    if tool.Parent ~= LP.Character then
        local hum = getHum()
        if hum then
            pcall(function() hum:EquipTool(tool) end)
            task.wait(0.3)
        end
    end

    local ok, res = pcall(function()
        return CommF_:InvokeServer("StoreFruit", originalName, tool)
    end)
    if not ok then
        DiscordAlerts.error("Failed to invoke `StoreFruit` for **" .. display .. "**:\n```" .. tostring(res) .. "```")
        return false, display .. ": error while storing (" .. tostring(res) .. ")."
    end
    if typeof(res) == "number" then
        local raw = tool.Name:gsub("%s*Fruit", ""):gsub("%s*%[.*%]", "")
        local clean = cleanFruitKey(tool:GetAttribute("OriginalName") or raw)
        if clean ~= "" then
            Cfg.StoredFruits[clean] = res
        end
        DiscordAlerts.storageFull(tool, res)
        return res, display .. " NOT stored: already owned (storage capacity " .. res .. " per fruit)."
    end
    if res == true then
        markStored(tool)
        DiscordAlerts.stored(tool)
        return true, display .. " stored in inventory."
    end
    DiscordAlerts.error("Server rejected storing **" .. display .. "** (resp: " .. tostring(res) .. ").")
    return false, display .. ": storage failed (resp " .. tostring(res) .. ")."
end

-- ===================== Global Inventory Detection & Storing =====================
local unstoreableFruits = {} -- [tool] = true

local function getAnyFruitInInventory()
    local ch = LP.Character
    if ch then
        for _, t in ipairs(ch:GetChildren()) do
            if isFruit(t) and not unstoreableFruits[t] then
                return t
            end
        end
    end
    if LP.Backpack then
        for _, t in ipairs(LP.Backpack:GetChildren()) do
            if isFruit(t) and not unstoreableFruits[t] then
                return t
            end
        end
    end
    return nil
end

local function storeAllInventoryFruits()
    local attempts = 0
    while attempts < 5 do
        local fruitTool = getAnyFruitInInventory()
        if not fruitTool then break end

        local fname = fruitDisplayName(fruitTool)
        setStatus("Fruit detected in possession: " .. fname .. ". Storing...")
        local storeOk, resMsg = storeFruit(fruitTool)
        setStatus(resMsg)
        task.wait(1.2)

        if fruitTool.Parent == LP.Character or (LP.Backpack and fruitTool.Parent == LP.Backpack) then
            unstoreableFruits[fruitTool] = true
            local ancConn
            ancConn = fruitTool.AncestryChanged:Connect(function(_, parent)
                if not parent or (parent ~= LP.Backpack and parent ~= LP.Character) then
                    unstoreableFruits[fruitTool] = nil
                    if ancConn then ancConn:Disconnect() end
                end
            end)
        end
        attempts = attempts + 1
    end
end

-- ===================== Auto Close Gacha Spinner / Popup =====================
-- Closes the roulette/spinner window ("SpinnerWindow" and "ModelPopup") left open in PlayerGui
local function closeGachaRoulette()
    -- 1. Try closing via official game controllers if available
    pcall(function()
        local controllers = ReplicatedStorage:FindFirstChild("Controllers")
        local ui = controllers and controllers:FindFirstChild("UI")
        if ui then
            local gachaWinMod = ui:FindFirstChild("GachaWindow")
            if gachaWinMod then
                local GachaWindow = require(gachaWinMod)
                if GachaWindow and typeof(GachaWindow.Close) == "function" then
                    GachaWindow:Close()
                end
            end
            local spinnerMod = ui:FindFirstChild("Spinner")
            if spinnerMod then
                local Spinner = require(spinnerMod)
                if Spinner and typeof(Spinner.Close) == "function" then
                    Spinner:Close()
                end
            end
            local modelPopupMod = ui:FindFirstChild("ModelPopup")
            if modelPopupMod then
                local ModelPopup = require(modelPopupMod)
                if ModelPopup and typeof(ModelPopup.Close) == "function" then
                    ModelPopup:Close()
                end
            end
        end
    end)

    -- 2. Inspect PlayerGui and disable/trigger close buttons
    local PlayerGui = LP:FindFirstChildOfClass("PlayerGui")
    if PlayerGui then
        -- A) GachaWindow UI
        local gachaWin = PlayerGui:FindFirstChild("GachaWindow")
        if gachaWin then
            local closeBtn = gachaWin:FindFirstChild("CloseButton", true) or gachaWin:FindFirstChild("CloseButtonFrame", true) or gachaWin:FindFirstChild("Close", true)
            if closeBtn and closeBtn:IsA("GuiButton") then
                pcall(function()
                    if typeof(firesignal) == "function" then
                        firesignal(closeBtn.Activated)
                        firesignal(closeBtn.MouseButton1Click)
                    end
                end)
            end
            gachaWin.Enabled = false
        end

        -- B) SpinnerWindow (Gacha spin roulette)
        local spinnerWin = PlayerGui:FindFirstChild("SpinnerWindow")
        if spinnerWin then
            local skipBtn = spinnerWin:FindFirstChild("SkipButton", true)
            if skipBtn and skipBtn:IsA("GuiButton") and skipBtn.Visible then
                pcall(function()
                    if typeof(firesignal) == "function" then
                        firesignal(skipBtn.Activated)
                        firesignal(skipBtn.MouseButton1Click)
                    end
                end)
            end

            local closeBtn = spinnerWin:FindFirstChild("CloseButton", true)
            if closeBtn and closeBtn:IsA("GuiButton") then
                pcall(function()
                    if typeof(firesignal) == "function" then
                        firesignal(closeBtn.Activated)
                        firesignal(closeBtn.MouseButton1Click)
                    end
                end)
            end

            spinnerWin.Enabled = false
        end

        -- C) ModelPopup (3D item popup window)
        local modelPopup = PlayerGui:FindFirstChild("ModelPopup")
        if modelPopup then
            local closeBtn = modelPopup:FindFirstChild("CloseButton", true) or modelPopup:FindFirstChild("CloseButtonFrame", true)
            if closeBtn and closeBtn:IsA("GuiButton") then
                pcall(function()
                    if typeof(firesignal) == "function" then
                        firesignal(closeBtn.Activated)
                        firesignal(closeBtn.MouseButton1Click)
                    end
                end)
            end
            modelPopup.Enabled = false
        end
    end
end

-- Helper to parse Blox Fruits cooldown text accurately
local function parseGachaWaitSeconds(rawText)
    if type(rawText) == "number" then return rawText end
    local str = tostring(rawText or "")

    -- Case 1: HH:MM:SS
    local h, m, s = str:match("(%d+):(%d+):(%d+)")
    if h and m and s then
        return tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s)
    end

    -- Case 2: HH:MM (Always Hours:Minutes in Blox Fruits, e.g. "01:05 hours")
    local p1, p2 = str:match("(%d+):(%d+)")
    if p1 and p2 then
        return tonumber(p1) * 3600 + tonumber(p2) * 60
    end

    -- Case 3: "X hours" or "X mins"
    local hrs = str:match("(%d+)%s*h")
    local mins = str:match("(%d+)%s*m")
    if hrs or mins then
        return (tonumber(hrs) or 0) * 3600 + (tonumber(mins) or 0) * 60
    end

    return 0
end

-- ===================== Auto Stat Allocation =====================
autoAssignStats = function()
    if not Cfg.AutoStats then return end
    local data = LP:FindFirstChild("Data")
    if not data then return end
    local pointsVal = data:FindFirstChild("Points")
    if not pointsVal or pointsVal.Value <= 0 then return end

    local statsFolder = data:FindFirstChild("Stats")
    if not statsFolder then return end

    local MAX_STAT_CAP = 2550

    local melee = statsFolder:FindFirstChild("Melee") and statsFolder.Melee:FindFirstChild("Level") and statsFolder.Melee.Level.Value or 0
    local defense = statsFolder:FindFirstChild("Defense") and statsFolder.Defense:FindFirstChild("Level") and statsFolder.Defense.Level.Value or 0
    local fruit = statsFolder:FindFirstChild("Demon Fruit") and statsFolder["Demon Fruit"]:FindFirstChild("Level") and statsFolder["Demon Fruit"].Level.Value or 0

    local availablePoints = pointsVal.Value

    -- 1. Prioridad: Melee hasta max cap (2550)
    if melee < MAX_STAT_CAP and availablePoints > 0 then
        local toAdd = math.min(availablePoints, MAX_STAT_CAP - melee)
        if toAdd > 0 then
            pcall(function()
                CommF_:InvokeServer("AddPoint", "Melee", toAdd)
            end)
            availablePoints = availablePoints - toAdd
        end
    end

    -- 2. Prioridad: Defense hasta max cap (2550)
    if defense < MAX_STAT_CAP and availablePoints > 0 then
        local toAdd = math.min(availablePoints, MAX_STAT_CAP - defense)
        if toAdd > 0 then
            pcall(function()
                CommF_:InvokeServer("AddPoint", "Defense", toAdd)
            end)
            availablePoints = availablePoints - toAdd
        end
    end

    -- 3. Prioridad: Blox Fruit (Demon Fruit) para los puntos restantes
    if fruit < MAX_STAT_CAP and availablePoints > 0 then
        local toAdd = math.min(availablePoints, MAX_STAT_CAP - fruit)
        if toAdd > 0 then
            pcall(function()
                CommF_:InvokeServer("AddPoint", "Demon Fruit", toAdd)
            end)
            availablePoints = availablePoints - toAdd
        end
    end
end

-- Listener reactivo instantáneo cuando se ganan puntos por nivel o combate
task.defer(function()
    pcall(function()
        local data = LP:WaitForChild("Data", 30)
        local pointsObj = data and data:WaitForChild("Points", 30)
        if pointsObj then
            pointsObj:GetPropertyChangedSignal("Value"):Connect(function()
                if Cfg.AutoStats and pointsObj.Value > 0 then
                    autoAssignStats()
                end
            end)
            if pointsObj.Value > 0 then
                autoAssignStats()
            end
        end
    end)
end)

-- ===================== Fruit Roll (Gacha) =====================
local function rollFruit(boxName)
    boxName = boxName or Cfg.RollBox or "ZiolesGacha"
    setStatus("Checking Gacha (" .. boxName .. ")...")

    -- 1. Check Gacha via modern GachaClient if available
    local modernCheckSuccess = false
    local gcOk, GachaClient = pcall(function()
        local gc = require(ReplicatedStorage:WaitForChild("Controllers", 5):WaitForChild("GachaClient", 5))
        if gc and typeof(gc.OnStart) == "function" then
            pcall(gc.OnStart)
        end
        return gc
    end)

    if gcOk and GachaClient and typeof(GachaClient.CheckGachaAsync) == "function" then
        local okCheck, checkRes = pcall(function()
            return GachaClient.CheckGachaAsync(boxName, "Blox Fruit Gacha")
        end)
        if okCheck and type(checkRes) == "table" then
            modernCheckSuccess = true

            -- Level check (requires level 50)
            if checkRes.Level and checkRes.Level.RequirementMet == false then
                local reqLvl = checkRes.Level.Value or 50
                local curLvl = checkRes.Level.Current or 1
                setStatusErr(string.format("Level %d required for Gacha (Current: %d). Proceeding with spawned fruits.", reqLvl, curLvl))
                DiscordAlerts.warn(string.format("Player level %d is below Gacha requirement (Lv. %d). Proceeding with spawned fruits.", curLvl, reqLvl), "⏳ Level Requirement")
                return false
            end

            -- Cooldown check
            if checkRes.Cooldown and checkRes.Cooldown.RequirementMet == false then
                local endsAt = tonumber(checkRes.Cooldown.TimeEnds) or 0
                local secs = endsAt > os.time() and (endsAt - os.time()) or (endsAt > 0 and endsAt or 7200)
                if boxName ~= "MagnetEventGacha26" then
                    DiscordAlerts.setGachaCooldown(secs)
                end
                if checkRes.Price and tonumber(checkRes.Price.Value) then
                    local pCost = tonumber(checkRes.Price.Value)
                    Session.gacha_cost = pCost
                    local pMoney = tonumber(checkRes.Price.Current) or (getPlayerData()) or 0
                    if pMoney < pCost then
                        Session.gacha_no_beli = true
                    end
                end
                local cdStr = formatCountdown(secs)
                setStatusErr("Gacha on cooldown (" .. cdStr .. ").")
                DiscordAlerts.warn("Gacha on cooldown (" .. cdStr .. "). Proceeding with spawned fruits.", "⏳ Gacha on cooldown")
                return false
            end

            -- Price / Balance check
            if checkRes.Price and checkRes.Price.RequirementMet == false then
                local curMoney = tonumber(checkRes.Price.Current) or 0
                local cost = tonumber(checkRes.Price.Value) or 0
                local dispName = checkRes.Price.DisplayName or "Beli"
                if boxName ~= "MagnetEventGacha26" then
                    DiscordAlerts.setGachaNoBeli(curMoney, cost)
                end
                setStatusErr(string.format("Not enough %s ($%s / $%s).", dispName, formatBeli(curMoney), formatBeli(cost)))
                DiscordAlerts.warn(string.format("Not enough %s for roll (Balance: $%s | Cost: $%s).", dispName, formatBeli(curMoney), formatBeli(cost)), "💰 Out of Beli")
                return false
            else
                if boxName ~= "MagnetEventGacha26" then
                    Session.gacha_no_beli = false
                end
            end
        end
    end

    -- Legacy CommF_ fallback check if modern check didn't succeed
    if not modernCheckSuccess then
        -- Cooldown check (CheckTime)
        local okTime, timeRes = pcall(function()
            return CommF_:InvokeServer("Cousin", "CheckTime", boxName)
        end)
        if okTime and timeRes ~= true and timeRes ~= nil then
            local secs = parseGachaWaitSeconds(timeRes)
            if secs > 0 and boxName ~= "MagnetEventGacha26" then
                DiscordAlerts.setGachaCooldown(secs)
            end

            local waitTime = (type(timeRes) == "string" and (timeRes:match("wait ([%d:]+)") or timeRes:match("wait ([%d:]+ to hours)"))) or tostring(timeRes)
            setStatusErr("Gacha on cooldown (" .. tostring(waitTime) .. ").")
            DiscordAlerts.warn("Gacha on cooldown (" .. tostring(waitTime) .. "). Proceeding with spawned fruits.", "⏳ Gacha on cooldown")
            return false
        end

        -- Balance & Cost check (Check)
        local okCheck, checkRes = pcall(function()
            return { CommF_:InvokeServer("Cousin", "Check", boxName) }
        end)
        if okCheck and type(checkRes) == "table" and #checkRes >= 3 then
            local currentBeli = checkRes[1]
            local gachaCost   = checkRes[3]
            if currentBeli < gachaCost then
                DiscordAlerts.setGachaNoBeli(currentBeli, gachaCost)
                setStatusErr(string.format("Not enough Beli ($%s / $%s).", formatBeli(currentBeli), formatBeli(gachaCost)))
                DiscordAlerts.warn(string.format("Not enough Beli for roll (Balance: $%s | Cost: $%s).", formatBeli(currentBeli), formatBeli(gachaCost)), "💰 Out of Beli")
                return false
            else
                Session.gacha_no_beli = false
            end
        end
    end

    -- 2. Baseline inventory tools snapshot
    local baselineTools = {}
    if LP.Backpack then
        for _, t in ipairs(LP.Backpack:GetChildren()) do
            if t:IsA("Tool") then baselineTools[t] = true end
        end
    end
    if LP.Character then
        for _, t in ipairs(LP.Character:GetChildren()) do
            if t:IsA("Tool") then baselineTools[t] = true end
        end
    end

    -- 3. Purchase invocation
    setStatus("Purchasing Gacha roll (" .. boxName .. ")...")
    local purchaseOk = false
    local purchaseRes = nil

    if gcOk and GachaClient and typeof(GachaClient.PurchaseGachaAsync) == "function" then
        local okP, resP, errData = pcall(function()
            return GachaClient.PurchaseGachaAsync(boxName)
        end)
        if okP and resP == true then
            purchaseOk = true
            purchaseRes = 1
        elseif okP and resP == false and errData then
            purchaseRes = (type(errData) == "table" and errData.ErrorMessage) or tostring(errData)
        end
    end

    if not purchaseOk and purchaseRes ~= 1 then
        local okC, resC = pcall(function()
            return CommF_:InvokeServer("Cousin", boxName)
        end)
        if okC then
            if resC == 1 then
                purchaseOk = true
                purchaseRes = 1
            else
                purchaseRes = resC
            end
        elseif not purchaseRes then
            purchaseRes = resC
        end
    end

    if purchaseOk or purchaseRes == 1 then
        setStatus("Roll successful. Closing spinner and waiting for fruit arrival...")
        task.spawn(function()
            for _ = 1, 10 do
                closeGachaRoulette()
                task.wait(0.2)
            end
        end)

        local rolledFruit = nil
        local tWait = 0
        while tWait < 4 and not rolledFruit do
            task.wait(0.1)
            tWait = tWait + 0.1
            if LP.Backpack then
                for _, t in ipairs(LP.Backpack:GetChildren()) do
                    if not baselineTools[t] and isFruit(t) then
                        rolledFruit = t
                        break
                    end
                end
            end
            if not rolledFruit and LP.Character then
                for _, t in ipairs(LP.Character:GetChildren()) do
                    if not baselineTools[t] and isFruit(t) then
                        rolledFruit = t
                        break
                    end
                end
            end
        end

        closeGachaRoulette()

        if rolledFruit then
            local fname = fruitDisplayName(rolledFruit)
            setStatus("Fruit obtained from Gacha: " .. fname .. ". Storing...")
            DiscordAlerts.rolled(rolledFruit, boxName)
            if boxName ~= "MagnetEventGacha26" then
                DiscordAlerts.setGachaCooldown(7200)
            end
            task.wait(0.5)
            local storeOk, storeMsg = storeFruit(rolledFruit)
            setStatus(storeMsg)
            closeGachaRoulette()
            return true
        else
            setStatus("Roll confirmed. Searching inventory for fruit to store...")
            if boxName ~= "MagnetEventGacha26" then
                DiscordAlerts.setGachaCooldown(7200)
            end
            task.wait(1)
            storeAllInventoryFruits()
            closeGachaRoulette()
            return true
        end
    end

    if purchaseRes == "Expired" then
        setStatusErr("Box " .. boxName .. " expired (Expired).")
        DiscordAlerts.warn("Box expired (" .. boxName .. ").", "⏳ Box Expired")
        return false
    end

    if type(purchaseRes) == "string" then
        local secs = parseGachaWaitSeconds(purchaseRes)
        if secs > 0 then
            DiscordAlerts.setGachaCooldown(secs)
            local cleanMsg = purchaseRes:match("wait (.-)%]") or purchaseRes:match("wait (.-)%.") or purchaseRes
            setStatusErr("Roll on cooldown (" .. cleanMsg .. "). Proceeding with spawned fruits.")
            DiscordAlerts.warn("Roll on cooldown (" .. cleanMsg .. ").", "⏳ Roll on cooldown")
            return false
        end
        setStatusErr("Roll returned: " .. tostring(purchaseRes):sub(1, 40))
        return false
    end

    setStatus("Roll responded: " .. tostring(purchaseRes))
    task.wait(1)
    storeAllInventoryFruits()
    return true
end

-- ===================== High-Stability Smart Server Hop =====================

local function extractNativeServers()
    local PlayerGui = LP:FindFirstChild("PlayerGui")
    local sbGui = PlayerGui and PlayerGui:FindFirstChild("ServerBrowser")
    if not sbGui then return nil end

    local scr = sbGui:FindFirstChild("LocalScript")
    if not scr then return nil end

    sbGui.Enabled = true
    local t0 = tick()
    local extracted = {}

    while (tick() - t0) < 3.5 do
        if typeof(getsenv) == "function" and typeof(getupvalues) == "function" then
            local ok, env = pcall(getsenv, scr)
            if ok and env and env.UpdateScroll then
                local okUps, ups = pcall(getupvalues, env.UpdateScroll)
                local u86 = okUps and ups and ups[2]
                if type(u86) == "table" and #u86 > 5 then
                    for _, s in ipairs(u86) do
                        if s.Job and s.Count then
                            extracted[s.Job] = {
                                Count = s.Count,
                                Region = s.Region,
                                Bounty = s.Bounty,
                                __LastUpdate = s.__LastUpdate
                            }
                        end
                    end
                    break
                end
            end
        end
        task.wait(0.2)
    end
    sbGui.Enabled = false

    if next(extracted) then
        return extracted
    end
    return nil
end

local function fetchHttpServers()
    local req = http_request or request
    if not req then return nil end
    local ok, res = pcall(function()
        return req({
            Url = "https://games.roblox.com/v1/games/" .. tostring(game.PlaceId) .. "/servers/Public?sortOrder=Asc&limit=100",
            Method = "GET"
        })
    end)
    if ok and res and res.StatusCode == 200 then
        local okJson, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
        if okJson and data and type(data.data) == "table" then
            local map = {}
            for _, s in ipairs(data.data) do
                if s.id and s.playing and s.maxPlayers then
                    map[s.id] = {
                        Count = s.playing,
                        Region = "Global",
                        Bounty = 0,
                        __LastUpdate = 1e15
                    }
                end
            end
            return map
        end
    end
    return nil
end

local function serverHop()
    if not ServerBrowser then
        setStatusErr("No ServerBrowser found.")
        return false
    end

    -- Guard: Never server hop if the player needs to farm Beli or Level for Gacha
    if Cfg.AutoQuestFarm and AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming() then
        setStatus("Server hop cancelled: Account needs Beli/Level. Prioritizing quest farming.")
        return false
    end

    -- 1. Attempt storing any fruit before hopping
    local holdingFruit = getAnyFruitInInventory()
    if holdingFruit then
        local fName = fruitDisplayName(holdingFruit)
        setStatus("Fruit in inventory (" .. fName .. "). Attempting to store before server hop...")
        task.wait(0.5)
        local storeOk, storeMsg = storeFruit(holdingFruit)
        setStatus(storeMsg)

        if storeOk == true then
            setStatus(fName .. " stored successfully. Continuing server hop...")
            task.wait(1)
        elseif typeof(storeOk) == "number" then
            setStatus("Storage full for " .. fName .. ". Proceeding with server hop as planned...")
            unstoreableFruits[holdingFruit] = true
            task.wait(1.5)
        else
            setStatus("Could not store " .. fName .. ". Continuing server hop...")
            unstoreableFruits[holdingFruit] = true
            task.wait(1)
        end
    end

    -- 2. Wait if player is in combat
    local combatGuard = 0
    while LP.Character and LP.Character:GetAttribute("InCombat") and combatGuard < 8 do
        setStatus("In combat (" .. tostring(combatGuard) .. "/8s); waiting for combat to expire before hopping...")
        task.wait(1)
        combatGuard = combatGuard + 1
    end

    -- 3. Ensure team selection
    if not LP.Team or LP.Team.Name == "None" then
        pcall(function()
            CommF_:InvokeServer("SetTeam", Cfg.Team)
        end)
        task.wait(1)
    end

    local MaxPlayers = game.Players.MaxPlayers

    local myJobId, myJobErr = pcall(function()
        return ServerBrowser:InvokeServer("getjob")
    end)
    if not myJobId or type(myJobId) ~= "string" then
        myJobId = game.JobId
    end

    setStatus("Searching for active servers (fast sweep)...")

    -- 4. Extract servers via native game method
    local collected = extractNativeServers()

    -- 5. Fallback to HTTP API
    if not collected or not next(collected) then
        setStatus("Querying servers via backup API...")
        collected = fetchHttpServers()
    end

    -- 6. Sequential paging fallback (15 pages)
    if not collected or not next(collected) then
        setStatus("Querying server browser pages...")
        collected = {}
        for p = 1, 15 do
            local ok, res = pcall(function()
                return ServerBrowser:InvokeServer(p)
            end)
            if ok and type(res) == "table" then
                for jobKey, srv in pairs(res) do
                    if jobKey ~= myJobId then
                        collected[jobKey] = srv
                    end
                end
            end
            task.wait(0.04)
        end
    end

    if not collected or not next(collected) then
        setStatusErr("Failed to retrieve server list; retrying shortly.")
        DiscordAlerts.warn("Could not retrieve server list; will retry shortly.", "🔁 Scan Failed")
        return false
    end

    -- 7. Filter servers avoiding Error 772 ("Server Full"):
    -- Tier 1: Servers with 2 to 9 players (safe slots).
    -- Tier 2: Servers under MaxPlayers.
    local tier1 = {}
    local tier2 = {}

    for jobKey, srv in pairs(collected) do
        if jobKey ~= myJobId and type(srv) == "table" and type(srv.Count) == "number" then
            local order = (type(srv.__LastUpdate) == "number" and srv.__LastUpdate < 1e12)
                and srv.__LastUpdate
                or (1e15 + (srv.Count / 10))

            local item = { job = jobKey, srv = srv, order = order }

            if srv.Count >= 2 and srv.Count <= 9 then
                tier1[#tier1 + 1] = item
            elseif srv.Count < MaxPlayers then
                tier2[#tier2 + 1] = item
            end
        end
    end

    local candidates = (#tier1 > 0) and tier1 or tier2
    table.sort(candidates, function(a, b) return a.order < b.order end)

    if #candidates == 0 then
        setStatusErr("No joinable servers found.")
        DiscordAlerts.warn("No **joinable servers** available.", "🔁 No Servers Available")
        return false
    end

    setStatus("Found " .. #candidates .. " servers with open slots. Initiating hop...")

    -- 8. Listen to TeleportInitFailed for instant rejection detection
    local teleportError = nil
    local initFailedConn = nil
    pcall(function()
        initFailedConn = TeleportService.TeleportInitFailed:Connect(function(player, result, msg)
            teleportError = tostring(result) .. " (" .. tostring(msg) .. ")"
            warn("[FruitsHub] TeleportInitFailed: " .. tostring(teleportError))
        end)
    end)

    local myJobBefore = tostring(myJobId)

    for i, cand in ipairs(candidates) do
        local srv = cand.srv
        local count = tostring(srv.Count)
        teleportError = nil

        setStatus(string.format("Server hop (#%d/%d): server %s/%d players (%s), hopping...", i, #candidates, count, MaxPlayers, tostring(srv.Region or "Global")))
        local okHop, resHop = pcall(function()
            return ServerBrowser:InvokeServer("teleport", cand.job)
        end)

        local elapsed = 0
        local jumped = false
        while elapsed < 3.5 do
            task.wait(0.3)
            elapsed = elapsed + 0.3

            if teleportError then
                warn("[FruitsHub] Immediate Roblox rejection: " .. tostring(teleportError))
                break
            end

            local myJobAfter
            pcall(function()
                myJobAfter = ServerBrowser:InvokeServer("getjob")
            end)

            if myJobAfter and tostring(myJobAfter) ~= myJobBefore then
                jumped = true
                setStatus("Server hop CONFIRMED: new session " .. tostring(myJobAfter))
                DiscordAlerts.info("Teleported to server with more accumulated fruits.\nNew session: `" .. tostring(myJobAfter) .. "`", "🔁 Server Hop Completed")
                if initFailedConn then initFailedConn:Disconnect() end
                return true
            end
        end

        warn(string.format("[FruitsHub] Server %s did not connect (error=%s). Trying next...", cand.job, tostring(teleportError or "timeout")))
        if i >= 12 then
            break
        end
        task.wait(0.3)
    end

    if initFailedConn then
        pcall(function() initFailedConn:Disconnect() end)
    end

    setStatusErr("Could not hop during this round; retrying shortly.")
    DiscordAlerts.warn("Could not connect to selected servers. Retrying next round.", "❌ Hop Not Executed")
    return false
end

-- ===================== Live Reactive Detection (ChildAdded) =====================
local childAddedConn = nil
local function setupSpawnListener()
    if childAddedConn then
        childAddedConn:Disconnect()
        childAddedConn = nil
    end
    childAddedConn = workspace.ChildAdded:Connect(function(child)
        task.wait(0.2)
        if child:IsA("Tool") and isDroppedFruit(child) then
            if isStoredAlready(child) then
                local fname = fruitDisplayName(child)
                setStatus("⏭️ " .. fname .. " detected but already stored. Skipping.")
                DiscordAlerts.skipped(child)
            else
                local part = fruitPart(child)
                if part and part.Position.Magnitude > 1 then
                    local fname = fruitDisplayName(child)
                    local root = getRoot()
                    local d = root and (root.Position - part.Position).Magnitude or 0
                    setStatus("Spawned fruit detected!: " .. fname .. " (" .. math.floor(d) .. " studs)")
                    found = { model = child, fname = fname, pos = part.Position }
                    scanState = "fruit"
                    DiscordAlerts.fruit(child, d)
                end
            end
        end
    end)
end

-- =========================================================================================
-- PERMANENT COMBAT ENGINE (Blox Fruits HOHO HUB Method RE)
-- =========================================================================================
local _combatOk, _Global          = pcall(function() return require(ReplicatedStorage:WaitForChild("Global")) end)
local _NetFolder                  = ReplicatedStorage:WaitForChild("Modules"):WaitForChild("Net")
local _RegisterAttackRemote       = _NetFolder:WaitForChild("RE/RegisterAttack")
local _combatUtilOk, _CombatUtil  = pcall(function() return require(ReplicatedStorage:WaitForChild("Modules"):WaitForChild("CombatUtil")) end)
local _weaponDataOk, _WeaponData  = pcall(function() return require(ReplicatedStorage:WaitForChild("Modules"):WaitForChild("WeaponData")) end)

-- A) Inflar HitboxMagnitude Melee a 55 studs (rango máximo seguro del servidor)
if _weaponDataOk and type(_WeaponData) == "table" then
    for _, data in pairs(_WeaponData) do
        if type(data) == "table" and data.WeaponType == "Melee" then
            data.HitboxMagnitude = 55
        end
    end
end

-- B) Hook GetWeaponData
if _combatUtilOk and _CombatUtil and type(_CombatUtil.GetWeaponData) == "function" then
    local _rawGetWeaponData = _CombatUtil.GetWeaponData
    _CombatUtil.GetWeaponData = function(self, weaponName)
        local data = _rawGetWeaponData(self, weaponName)
        if data and type(data) == "table" and data.WeaponType == "Melee" then
            data.HitboxMagnitude = 55
        end
        return data
    end
end

-- C) Hook CanAttack — bypasea cooldowns/stun para el jugador local
if _combatUtilOk and _CombatUtil and type(_CombatUtil.CanAttack) == "function" then
    local _rawCanAttack = _CombatUtil.CanAttack
    _CombatUtil.CanAttack = function(self, char, weaponType)
        if char == LP.Character then return true end
        return _rawCanAttack(self, char, weaponType)
    end
end

-- Partes válidas del cuerpo para hit registration
local _COMBAT_LIMBS = { "HumanoidRootPart", "Head", "UpperTorso", "LowerTorso", "LeftHand", "RightHand", "LeftLowerLeg", "RightLowerLeg" }
local function _getHitPart(model)
    for _, limbName in ipairs(_COMBAT_LIMBS) do
        local part = model:FindFirstChild(limbName)
        if part and part:IsA("BasePart") then return part end
    end
    return model:FindFirstChildWhichIsA("BasePart")
end

-- comboIndex cicla 1→4 igual que el juego real
local _comboIndex = 1

-- performFullAttack: idéntico a combat.lua
local function _performFullAttack(primaryPart, hitList)
    if not primaryPart then return end
    _RegisterAttackRemote:FireServer(0.1, _comboIndex)
    _comboIndex = (_comboIndex % 4) + 1
    if _combatOk and _Global and type(_Global.SendHitsToServer) == "function" then
        _Global.SendHitsToServer(primaryPart, hitList or {})
    else
        local ups = debug.getupvalues(_Global.SendHitsToServer)
        if ups and typeof(ups[1]) == "thread" then
            coroutine.resume(ups[1], primaryPart, hitList or {})
        end
    end
end

-- =========================================================================================
-- [[ >>>>>> INICIO TEMPORAL: MAGNET EVENT (ELIMINAR EN 15 DÍAS) <<<<<< ]]
-- =========================================================================================
MagnetEvent = MagnetEvent or {}



-- =========================================================================================
-- SEA DETECTION & ISLAND CONFIG (Universal: Sea 1, Sea 2, Sea 3)
-- =========================================================================================
local CurrentSea = 1
if game.PlaceId == 2753915549 then
    CurrentSea = 1
elseif game.PlaceId == 4442272183 then
    CurrentSea = 2
elseif game.PlaceId == 7449423635 then
    CurrentSea = 3
else
    local locsFolder = workspace:FindFirstChild("_WorldOrigin") and workspace._WorldOrigin:FindFirstChild("Locations")
    if locsFolder then
        if locsFolder:FindFirstChild("Floating Turtle") or locsFolder:FindFirstChild("Sea of Treats") or locsFolder:FindFirstChild("Haunted Castle") then
            CurrentSea = 3
        elseif locsFolder:FindFirstChild("Kingdom of Rose") or locsFolder:FindFirstChild("Green Zone") or locsFolder:FindFirstChild("Forgotten Island") then
            CurrentSea = 2
        else
            CurrentSea = 1
        end
    end
end

local ISLAND_CONFIG = {
    [1] = {
        "Pirate Starter", "Marine Starter", "Jungle", "Pirate Village",
        "Desert", "Frozen Village", "Marine Fortress", "Skylands",
        "Prison", "Colosseum", "Magma Village", "Underwater City",
        "Fountain City", "Middle Town"
    },
    [2] = {
        "Kingdom of Rose", "Green Zone", "Graveyard", "Snow Mountain",
        "Hot and Cold", "Ice Castle", "Forgotten Island"
    },
    [3] = {
        "Floating Turtle", "Sea of Treats", "Haunted Castle"
    }
}

-- Verificación infalible para asegurar que NUNCA sea un jugador real y pertenezca a workspace
local function isRealPlayer(model)
    if not model or not model:IsA("Model") then return false end
    if not model:IsDescendantOf(workspace) then return true end -- Descartar templates en ReplicatedStorage
    if Players:GetPlayerFromCharacter(model) ~= nil then return true end
    if Players:FindFirstChild(model.Name) ~= nil then return true end
    for _, p in ipairs(Players:GetPlayers()) do
        if p.Character == model or p.Name == model.Name or (p.DisplayName and p.DisplayName == model.Name) then
            return true
        end
    end
    local enemiesFolder = workspace:FindFirstChild("Enemies")
    if enemiesFolder and model.Parent == enemiesFolder then
        return false
    end
    if CollectionService:HasTag(model, "Magnet Event") and model:IsDescendantOf(workspace) then
        return false
    end
    return true
end

-- Identificación y balance de Magnet Tokens (ItemId 1146 / 1574)
function MagnetEvent.getTokenBalance()
    local ok, count = pcall(function()
        local IRService = require(ReplicatedStorage:WaitForChild("ItemReplicationService", 5))
        local KEYS = require(ReplicatedStorage:WaitForChild("ItemReplicationService"):WaitForChild("KEYS", 5))
        if not IRService or not KEYS or not KEYS.QUANTITY then return 0 end
        local quantities = IRService:GetItems(KEYS.QUANTITY) or {}
        for _, q in ipairs(quantities) do
            if q.ItemId == 1146 or q.ItemId == 1574 then
                return q.Value or 0
            end
        end
        return 0
    end)
    return (ok and count) or 0
end

-- Detección y recolección de drops de Magnet Event (Scraps y Tokens)
function MagnetEvent.getDrops()
    local wo = workspace:FindFirstChild("_WorldOrigin")
    if not wo then return {} end
    local ie = wo:FindFirstChild("InteractiveEffects")
    if not ie then return {} end

    local drops = {}
    local root = getRoot()
    local myPos = root and root.Position or Vector3.zero

    -- 1. Scraps magnéticos (comunes para todos los jugadores)
    local scraps = ie:FindFirstChild("MagnetFruitScraps")
    if scraps then
        for _, item in ipairs(scraps:GetChildren()) do
            local p = item:IsA("BasePart") and item or (item:FindFirstChildWhichIsA("BasePart") or item.PrimaryPart)
            if p and p.Position.Magnitude > 1 then
                table.insert(drops, {
                    instance = item,
                    part = p,
                    pos = p.Position,
                    dist = (p.Position - myPos).Magnitude,
                    kind = "Scrap"
                })
            end
        end
    end

    -- 2. Tokens del jugador (bajo carpeta con su nombre o general)
    local tokensFolder = ie:FindFirstChild("MagnetEventTokens")
    if tokensFolder then
        local myFolder = tokensFolder:FindFirstChild(LP.Name)
        local targetFolder = myFolder or tokensFolder
        for _, item in ipairs(targetFolder:GetChildren()) do
            if not item:IsA("Folder") then
                local p = item:IsA("BasePart") and item or (item:FindFirstChildWhichIsA("BasePart") or item.PrimaryPart)
                if p and p.Position.Magnitude > 1 then
                    table.insert(drops, {
                        instance = item,
                        part = p,
                        pos = p.Position,
                        dist = (p.Position - myPos).Magnitude,
                        kind = "Token"
                    })
                end
            end
        end
    end

    table.sort(drops, function(a, b) return a.dist < b.dist end)
    return drops
end

function MagnetEvent.hasDrops()
    return #MagnetEvent.getDrops() > 0
end

-- Generación de waypoints de patrulla agrupados en celdas (100x100) según el mar actual
function MagnetEvent.buildRoamWaypoints()
    local validIslands = ISLAND_CONFIG[CurrentSea] or ISLAND_CONFIG[1]
    local waypoints = {}
    local seenGrid = {}

    local locationsFolder = workspace:FindFirstChild("_WorldOrigin") and workspace._WorldOrigin:FindFirstChild("Locations")
    if locationsFolder then
        for _, loc in ipairs(locationsFolder:GetChildren()) do
            local isMatch = false
            for _, allowed in ipairs(validIslands) do
                if loc.Name:lower():find(allowed:lower(), 1, true) then
                    isMatch = true
                    break
                end
            end
            if isMatch and loc:IsA("BasePart") then
                local pos = loc.Position
                -- Filtrar coordenadas fuera del mapa jugable (> 25000 studs, ej: portales submarinos)
                if math.abs(pos.X) < 25000 and math.abs(pos.Z) < 25000 then
                    local gridKey = math.floor(pos.X / 100) .. "_" .. math.floor(pos.Z / 100)
                    if not seenGrid[gridKey] then
                        seenGrid[gridKey] = true
                        table.insert(waypoints, {
                            name = loc.Name,
                            position = pos + Vector3.new(0, 60, 0)
                        })
                    end
                end
            end
        end
    end

    -- Fallback Sea 3 si las ubicaciones no cargaron a tiempo
    if #waypoints == 0 and CurrentSea == 3 then
        table.insert(waypoints, { name = "Floating Turtle", position = Vector3.new(-12463, 434, -7551) })
        table.insert(waypoints, { name = "Sea of Treats", position = Vector3.new(-2086, 133, -12075) })
        table.insert(waypoints, { name = "Haunted Castle", position = Vector3.new(-5414, 108, -793) })
    end

    return waypoints
end

-- Detección real y estricta del evento Magnet (Enemigos, Drops, Atmósfera o Cielo)
function MagnetEvent.isActive()
    -- 1. Presencia de enemigos magnetizados vivos en CollectionService (solo en workspace)
    local tagged = CollectionService:GetTagged("Magnet Event")
    if #tagged > 0 then
        for _, e in ipairs(tagged) do
            if e:IsA("Model") and e:IsDescendantOf(workspace) and not isRealPlayer(e) then
                local hum = e:FindFirstChildOfClass("Humanoid")
                if hum and hum.Health > 0 then
                    return true
                end
            end
        end
    end

    -- 2. Presencia física de NPCs enemigos magnetizados vivos en workspace.Enemies
    local enemiesFolder = workspace:FindFirstChild("Enemies")
    if enemiesFolder then
        for _, e in ipairs(enemiesFolder:GetChildren()) do
            if e:IsA("Model") and e:IsDescendantOf(workspace) and not isRealPlayer(e) and (e:GetAttribute("MagnetEnemy") == true or e:GetAttribute("Magnetized") == true or e:FindFirstChild("MagnetArms") or e:FindFirstChild("MagnetAura")) then
                local hum = e:FindFirstChildOfClass("Humanoid")
                if hum and hum.Health > 0 then
                    return true
                end
            end
        end
    end

    -- 3. Drops activos en _WorldOrigin (Scraps o Tokens)
    if MagnetEvent.hasDrops() then
        return true
    end

    -- 4. Capa de atmósfera activa de la tormenta en LightingLayers
    local Lighting = game:GetService("Lighting")
    local layers = Lighting:FindFirstChild("LightingLayers")
    local matm = layers and layers:FindFirstChild("MagnetStormAtmosphere")
    if matm then
        local intVal = matm:FindFirstChild("Intensity")
        local intensity = (intVal and intVal.Value) or matm:GetAttribute("Intensity")
        if intensity == nil or (type(intensity) == "number" and intensity > 0.05) then
            return true
        end
    end

    -- 5. Escombros magnéticos activos en _WorldOrigin
    local wo = workspace:FindFirstChild("_WorldOrigin")
    if wo and wo:FindFirstChild("InteractiveEffects") then
        local env = wo.InteractiveEffects:FindFirstChild("MagnetEventEnvironment")
        if env and #env:GetChildren() > 0 then
            return true
        end
    end

    -- 6. Skybox oficial de la tormenta magnética
    local sky = Lighting:FindFirstChildOfClass("Sky")
    if sky and sky.SkyboxBk == "rbxassetid://115775067579169" then
        return true
    end

    return false
end

-- Comprobar si el Gacha de Magnet está disponible para tirada
function MagnetEvent.canRoll()
    if MagnetEvent.getTokenBalance() < 500 then
        return false
    end
    local gcOk, GachaClient = pcall(function()
        return require(ReplicatedStorage:WaitForChild("Controllers", 5):WaitForChild("GachaClient", 5))
    end)
    if gcOk and GachaClient and typeof(GachaClient.CheckGachaAsync) == "function" then
        local okCheck, checkRes = pcall(function()
            return GachaClient.CheckGachaAsync("MagnetEventGacha26", "Blox Fruit Gacha")
        end)
        if okCheck and type(checkRes) == "table" then
            if checkRes.Cooldown and checkRes.Cooldown.RequirementMet == false then
                return false
            end
            if checkRes.Price and checkRes.Price.RequirementMet == false then
                return false
            end
            return true
        end
    end
    return true
end

-- Realizar tirada en el Magnet Gacha
function MagnetEvent.rollGacha()
    setStatus("Rolling Magnet Gacha (500 tokens)...")
    DiscordAlerts.info("Rolling Magnet Gacha (500 Magnet Tokens)...", "Magnet Gacha Roll")
    local success = rollFruit("MagnetEventGacha26")
    task.wait(1)
    closeGachaRoulette()
    storeAllInventoryFruits()
    return success
end

-- Equipar estilo de lucha Melee (Godhuman o cualquier Melee)
function MagnetEvent.equipMelee()
    local char = LP.Character
    if not char then return nil end
    local hum = char:FindFirstChildOfClass("Humanoid")
    if not hum or hum.Health <= 0 then return nil end

    for _, t in ipairs(char:GetChildren()) do
        if t:IsA("Tool") and (t.ToolTip == "Melee" or t.Name == "Godhuman") then
            return t
        end
    end

    if LP.Backpack then
        local godhuman = LP.Backpack:FindFirstChild("Godhuman")
        if godhuman and godhuman:IsA("Tool") then
            hum:EquipTool(godhuman)
            return godhuman
        end

        for _, t in ipairs(LP.Backpack:GetChildren()) do
            if t:IsA("Tool") and t.ToolTip == "Melee" then
                hum:EquipTool(t)
                return t
            end
        end

        for _, t in ipairs(LP.Backpack:GetChildren()) do
            if t:IsA("Tool") and t.ToolTip == "Sword" then
                hum:EquipTool(t)
                return t
            end
        end
    end
    return nil
end

-- Vuelo seguro autónomo a una posición de coordenadas (con soporte para interrupción reactiva si aparecen enemigos)
local function magnetFlightTo(targetPos, interruptCheck, runAliveFunc)
    return safeFlightTo(targetPos, {
        speed = 164,
        interruptCheck = interruptCheck,
        runAliveFunc = runAliveFunc
    })
end

-- Obtener todos los enemigos Magnet ordenados por distancia al jugador
function MagnetEvent.getMagnetEnemies()
    local list = {}
    local seen = {}
    local root = getRoot()
    local myPos = root and root.Position or Vector3.zero

    -- 1. Buscar enemigos en CollectionService ("Magnet Event") (estrictamente en workspace)
    local tagged = CollectionService:GetTagged("Magnet Event")
    for _, e in ipairs(tagged) do
        if e:IsA("Model") and e:IsDescendantOf(workspace) and not isRealPlayer(e) and not seen[e] then
            seen[e] = true
            local hum = e:FindFirstChildOfClass("Humanoid")
            local eRoot = e:FindFirstChild("HumanoidRootPart") or e:FindFirstChildWhichIsA("BasePart")
            local ePos = (eRoot and eRoot.Position) or (e.GetPivot and e:GetPivot().Position)
            if hum and hum.Health > 0 and ePos then
                local dist = (ePos - myPos).Magnitude
                table.insert(list, { model = e, rootPos = ePos, dist = dist })
            end
        end
    end

    -- 2. Buscar en workspace.Enemies
    local enemiesFolder = workspace:FindFirstChild("Enemies")
    if enemiesFolder then
        for _, e in ipairs(enemiesFolder:GetChildren()) do
            if e:IsA("Model") and e:IsDescendantOf(workspace) and not isRealPlayer(e) and not seen[e] then
                local isMagnet = (e:GetAttribute("MagnetEnemy") == true)
                    or (e:GetAttribute("Magnetized") == true)
                    or (e:FindFirstChild("MagnetArms") ~= nil)
                    or (e:FindFirstChild("MagnetAura") ~= nil)
                    or (e.Name:find("Magnet") ~= nil)
                if isMagnet then
                    seen[e] = true
                    local hum = e:FindFirstChildOfClass("Humanoid")
                    local eRoot = e:FindFirstChild("HumanoidRootPart") or e:FindFirstChildWhichIsA("BasePart")
                    local ePos = (eRoot and eRoot.Position) or (e.GetPivot and e:GetPivot().Position)
                    if hum and hum.Health > 0 and ePos then
                        local dist = (ePos - myPos).Magnitude
                        table.insert(list, { model = e, rootPos = ePos, dist = dist })
                    end
                end
            end
        end
    end

    table.sort(list, function(a, b) return a.dist < b.dist end)

    local res = {}
    for _, item in ipairs(list) do
        table.insert(res, item.model)
    end
    return res
end

-- Recolectar drops de magnet event (Scraps y Tokens)
function MagnetEvent.collectDrops(runAliveFunc)
    local drops = MagnetEvent.getDrops()
    if #drops == 0 then return false end

    local collectedAny = false
    for _, drop in ipairs(drops) do
        if runAliveFunc and not runAliveFunc() then break end
        if not drop.part or not drop.part.Parent or not drop.part:IsDescendantOf(workspace) then continue end

        -- Si aparece un enemigo mientras recogemos drops, ceder prioridad al combate inmediatamente
        if #MagnetEvent.getMagnetEnemies() > 0 then
            return collectedAny
        end

        setStatus(string.format("Collecting Magnet %s (%.0f studs)...", drop.kind, drop.dist))
        local targetPos = drop.pos + Vector3.new(0, 3, 0)
        magnetFlightTo(targetPos, nil, runAliveFunc)

        local r = getRoot()
        if r and drop.part.Parent and typeof(firetouchinterest) == "function" then
            pcall(function()
                firetouchinterest(r, drop.part, 0)
                task.wait(0.05)
                firetouchinterest(r, drop.part, 1)
            end)
        end
        collectedAny = true
        task.wait(0.1)
    end
    return collectedAny
end

-- Matar enemigo desde el aire con Tween suave a 30 studs overhead
-- Método verificado: tween a overhead + RegisterAttack + SendHitsToServer (Hitbox 55 studs)
local function killMagnetEnemy(npc, runAliveFunc)
    if not npc or not npc:IsDescendantOf(workspace) or isRealPlayer(npc) then return false end
    local hum = npc:FindFirstChildOfClass("Humanoid")
    if not hum or hum.Health <= 0 then return false end

    local enemyRoot = npc:FindFirstChild("HumanoidRootPart") or npc:FindFirstChildWhichIsA("BasePart")
    local enemyPos = (enemyRoot and enemyRoot.Position) or (npc.GetPivot and npc:GetPivot().Position)
    if not enemyPos then return false end

    local overheadH = Cfg.MagnetOverheadHeight or 30
    local approachPos = enemyPos + Vector3.new(0, overheadH, 0)
    safeFlightTo(approachPos, { speed = 164, keepBV = true, runAliveFunc = runAliveFunc })

    local root = getRoot()
    local myHum = getHum()
    if not root or not myHum or myHum.Health <= 0 then
        stopTween()
        return false
    end

    ensureFlightBV(root)
    MagnetEvent.equipMelee()

    local timeout = tick() + 45
    local lastAttack = 0
    local enemyDied = false

    while tick() < timeout do
        if runAliveFunc and not runAliveFunc() then break end
        if not npc.Parent or not npc:IsDescendantOf(workspace) then
            enemyDied = true
            break
        end
        if isRealPlayer(npc) then break end
        local liveHum = npc:FindFirstChildOfClass("Humanoid")
        if not liveHum or liveHum.Health <= 0 then
            enemyDied = true
            break
        end
        if myHum.Health <= 0 then break end

        MagnetEvent.equipMelee()

        -- NoClip limpio sin tocar AssemblyLinearVelocity (evita desincronizaciones)
        local char = LP.Character
        if char then
            for _, p in ipairs(char:GetDescendants()) do
                if p:IsA("BasePart") and p.CanCollide then
                    p.CanCollide = false
                end
            end
        end
        ensureFlightBV(root)

        -- Micro-seguimiento overhead
        local liveRoot = npc:FindFirstChild("HumanoidRootPart") or npc:FindFirstChildWhichIsA("BasePart")
        local currentPos = (liveRoot and liveRoot.Position) or (npc.GetPivot and npc:GetPivot().Position)
        if currentPos and root then
            local desiredPos = currentPos + Vector3.new(0, overheadH, 0)
            local offsetDist = (desiredPos - root.Position).Magnitude
            if offsetDist > 50 then
                safeFlightTo(desiredPos, { speed = 164, keepBV = true, runAliveFunc = runAliveFunc })
                ensureFlightBV(root)
            elseif offsetDist > 3 then
                local microDur = math.max(0.04, offsetDist / 164)
                pcall(function()
                    local tw = TweenService:Create(root, TweenInfo.new(microDur, Enum.EasingStyle.Linear), { CFrame = CFrame.new(desiredPos) })
                    tw:Play()
                end)
            end
        end

        if tick() - lastAttack >= 0.12 then
            lastAttack = tick()
            local primaryPart = (liveRoot and _getHitPart(npc)) or liveRoot
            if primaryPart then
                _performFullAttack(primaryPart, {})
            end
        end

        task.wait(0.04)
    end

    stopTween()
    task.wait(0.1)
    return enemyDied
end

-- Ciclo completo de ejecución del Magnet Farm con jerarquía de 3 prioridades:
-- Prioridad 1: Eliminar enemigos Magnet (Melee overhead 30 studs + RegisterAttack / SendHitsToServer)
-- Prioridad 2: Recolectar Drops (Scraps y Tokens en _WorldOrigin.InteractiveEffects)
-- Prioridad 3: Fast Server Hop inmediato (StreamingEnabled = false: todos los enemigos/drops del mapa están replicados; si no hay, patrullar es inútil)
function MagnetEvent.runCycle(runAliveFunc)
    setBotActivity("MAGNET_EVENT")
    setStatus("Magnet Storm Active: Starting aerial token hunt...")
    local totalKills = 0
    local idleStart = nil

    while runAliveFunc() and MagnetEvent.isActive() do
        if not isAlive() then
            setStatus("Magnet Event: Character died during event. Waiting for respawn...")
            if not ensureAlive(35) then break end
            setStatus("Magnet Event: Respawned! Resuming magnet event...")
            MagnetEvent.equipMelee()
            pcall(autoAssignStats)
            task.wait(0.5)
        end

        local enemies = MagnetEvent.getMagnetEnemies()

        -- PRIORIDAD 1: Enemigos magnetizados
        if #enemies > 0 then
            idleStart = nil
            for _, enemy in ipairs(enemies) do
                if not runAliveFunc() or not MagnetEvent.isActive() then break end
                local eName = enemy.Name
                setStatus(string.format("Eliminating %s (Kills: %d | Tokens: %d)", eName, totalKills, MagnetEvent.getTokenBalance()))
                local dead = killMagnetEnemy(enemy, runAliveFunc)
                if dead then
                    totalKills = totalKills + 1
                    -- Recolección inmediata de los tokens/scraps soltados por este enemigo
                    task.wait(0.2)
                    MagnetEvent.collectDrops(runAliveFunc)
                    if Cfg.MagnetGacha and MagnetEvent.canRoll() then
                        MagnetEvent.rollGacha()
                    end
                end
                task.wait(0.1)
            end

        -- PRIORIDAD 2: Drops en el suelo (Scraps o Tokens)
        elseif MagnetEvent.hasDrops() then
            idleStart = nil
            setStatus(string.format("Collecting Magnet Drops (Tokens: %d)...", MagnetEvent.getTokenBalance()))
            MagnetEvent.collectDrops(runAliveFunc)
            if Cfg.MagnetGacha and MagnetEvent.canRoll() then
                MagnetEvent.rollGacha()
            end

        -- PRIORIDAD 3: Fast Server Hop
        -- Con StreamingEnabled = false, los mobs y drops de todo el mapa están replicados en el cliente.
        -- Si no hay enemigos ni drops activos, patrullar 45s volando es tiempo perdido: hop rápido tras breve gracia.
        else
            -- Si el jugador necesita farmear Beli/Level, salir de MagnetEvent inmediatamente para hacer misiones
            if Cfg.AutoQuestFarm and AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming() then
                setStatus("Magnet Event: No targets found. Account needs Beli/Level, switching to AutoQuest...")
                break
            end

            if not idleStart then
                idleStart = tick()
            end

            -- Si la tormenta terminó mientras estábamos inactivos, salir inmediatamente
            if not MagnetEvent.isActive() then
                break
            end

            local idleElapsed = tick() - idleStart
            local GRACE_PERIOD = 3.5

            if idleElapsed < GRACE_PERIOD then
                local remaining = math.max(0, GRACE_PERIOD - idleElapsed)
                setStatus(string.format("No active Magnet targets. Verifying spawns (%.1fs)...", remaining))
                task.wait(0.5)
            else
                if Cfg.MagnetGacha and MagnetEvent.canRoll() then
                    MagnetEvent.rollGacha()
                end
                if Cfg.AutoQuestFarm and AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming() then
                    setStatus("No Magnet mobs. Prioritizing AutoQuest over server hop...")
                    break
                end
                setStatus("No Magnet mobs/drops in server. Fast hopping to new server...")
                DiscordAlerts.info("No active Magnet mobs/drops found in storm. Fast server hopping...", "⚡ Magnet Fast Hop")
                local hopped = serverHop()
                if hopped then
                    break
                else
                    idleStart = tick()
                    task.wait(2)
                end
            end
        end

        task.wait(0.2)
    end

    setStatus(string.format("Magnet Event completed (Total Kills: %d | Tokens: %d)", totalKills, MagnetEvent.getTokenBalance()))
    if Cfg.MagnetGacha and MagnetEvent.canRoll() then
        MagnetEvent.rollGacha()
    end
    setBotActivity("IDLE")
end
-- =========================================================================================
-- [[ >>>>>> FIN TEMPORAL: MAGNET EVENT <<<<<< ]]
-- =========================================================================================

-- =========================================================================================
-- AUTO QUEST & BELI FARMING MODULE (Permanent)
-- =========================================================================================
AutoQuestFarm = {}
AutoQuestFarm.Status = {
    active = false,
    currentQuest = "",
    currentStep = "Idle",
    currentKills = 0,
    targetKills = 0,
}

local GuideModule = nil
pcall(function()
    GuideModule = require(ReplicatedStorage:WaitForChild("GuideModule", 10))
end)

local Quests = nil
pcall(function()
    Quests = require(ReplicatedStorage:WaitForChild("Quests", 10))
end)

local lastGachaPriceCheck = 0
local cachedGachaPrice = nil

function AutoQuestFarm.getGachaPrice()
    local curBeli, curLvl = getPlayerData()
    curLvl = curLvl or 1

    -- 1. Use memory cache if queried within last 60 seconds
    if cachedGachaPrice and cachedGachaPrice > 0 and (tick() - lastGachaPriceCheck < 60) then
        return cachedGachaPrice
    end

    -- 2. Use Session.gacha_cost if valid
    if Session.gacha_cost and Session.gacha_cost > 0 and (tick() - lastGachaPriceCheck < 60) then
        cachedGachaPrice = Session.gacha_cost
        lastGachaPriceCheck = tick()
        return cachedGachaPrice
    end

    -- 3. Non-blocking fast check via GachaClient
    local gcOk, GachaClient = pcall(function()
        return require(ReplicatedStorage:WaitForChild("Controllers", 1):WaitForChild("GachaClient", 1))
    end)
    if gcOk and GachaClient and typeof(GachaClient.CheckGachaAsync) == "function" then
        local okCheck, checkRes = pcall(function()
            return GachaClient.CheckGachaAsync("ZiolesGacha", "Blox Fruit Gacha")
        end)
        if okCheck and type(checkRes) == "table" and checkRes.Price and tonumber(checkRes.Price.Value) then
            local pVal = tonumber(checkRes.Price.Value)
            if pVal and pVal > 0 then
                Session.gacha_cost = pVal
                cachedGachaPrice = pVal
                lastGachaPriceCheck = tick()
                return cachedGachaPrice
            end
        end
    end

    -- 4. Exact Blox Fruits Zioles formula: math.floor(curLvl * 262.5 + 14837.5) (exact at Lv. 85=$37,150, Lv. 89=$38,200)
    local formulaCost = math.max(25000, math.floor(curLvl * 262.5 + 14837.5))
    Session.gacha_cost = formulaCost
    cachedGachaPrice = formulaCost
    lastGachaPriceCheck = tick()
    return formulaCost
end

function AutoQuestFarm.needsFarming()
    if not Cfg.AutoQuestFarm then return false end
    local curBeli, curLvl = getPlayerData()
    curLvl = curLvl or 1
    curBeli = curBeli or 0

    if curLvl < 50 then
        return true
    end

    local cost = AutoQuestFarm.getGachaPrice()
    if curBeli < cost then
        return true
    end

    return false
end

function AutoQuestFarm.hasStorableGroundFruit()
    local fs = fruitSpawnsFolder()
    for _, v in ipairs(fs) do
        local part = fruitPart(v)
        if part and part.Position.Magnitude > 1 then
            if not isStoredAlready(v) then
                return true
            end
        end
    end
    return false
end

function AutoQuestFarm.resolveBestQuest(playerLevel)
    if not GuideModule or not Quests then
        pcall(function()
            GuideModule = require(ReplicatedStorage:WaitForChild("GuideModule", 5))
            Quests = require(ReplicatedStorage:WaitForChild("Quests", 5))
        end)
    end
    if not GuideModule or not Quests or not GuideModule.Data or not GuideModule.Data.NPCList then
        return nil
    end

    local bestLevel = -1
    local bestQuestEntry = nil
    local bestNpc = nil
    local bestSubIndex = 1

    for _, npcData in pairs(GuideModule.Data.NPCList) do
        local qDefs = Quests[npcData.InternalQuestName]
        if qDefs then
            for idx, def in ipairs(qDefs) do
                local req = def.LevelReq or 0
                local taskCounts = 0
                for _, count in pairs(def.Task or {}) do
                    taskCounts = taskCounts + count
                end
                -- Regla estricta: sólo misiones con cantidad > 1 (enemigos normales, nunca jefes individuales)
                if taskCounts > 1 and req <= playerLevel and req > bestLevel then
                    bestLevel = req
                    bestQuestEntry = def
                    bestNpc = npcData
                    bestSubIndex = idx
                end
            end
        end
    end

    local mobName = nil
    local mobCount = 0
    if bestQuestEntry and bestQuestEntry.Task then
        for mName, count in pairs(bestQuestEntry.Task) do
            mobName = mName
            mobCount = count
            break
        end
    end

    return {
        questName = bestNpc and bestNpc.InternalQuestName,
        npcName = bestNpc and bestNpc.NPCName,
        npcPos = bestNpc and bestNpc.Position,
        subIndex = bestSubIndex,
        targetMob = mobName,
        targetCount = mobCount,
        levelReq = bestLevel
    }
end

function AutoQuestFarm.getMobSpawnPos(mobName)
    if not mobName then return nil end
    local wo = workspace:FindFirstChild("_WorldOrigin")
    local es = wo and wo:FindFirstChild("EnemySpawns")
    if es then
        for _, s in ipairs(es:GetChildren()) do
            if s:IsA("BasePart") and (s.Name:find("^" .. mobName) or s.Name:find(mobName)) then
                return s.Position
            end
        end
    end
    return nil
end

function AutoQuestFarm.getActiveQuestInfo()
    local tq = LP.PlayerGui:FindFirstChild("TrackedQuestFrame")
    if not tq or not tq.Enabled then return nil end
    local frame = tq:FindFirstChild("Frame")
    if not frame or not frame.Visible then return nil end

    local descLabel = frame:FindFirstChild("description")
    local progLabel = frame:FindFirstChild("progress")
    local desc = descLabel and descLabel.Text or ""
    local prog = progLabel and progLabel.Text or ""

    local curKills, reqKills = prog:match("(%d+)/(%d+)")
    return {
        active = true,
        description = desc,
        progress = prog,
        curKills = tonumber(curKills) or 0,
        reqKills = tonumber(reqKills) or 0
    }
end

function AutoQuestFarm.equipMelee()
    local char = LP.Character
    if not char then return end
    for _, t in ipairs(char:GetChildren()) do
        if t:IsA("Tool") and (t.ToolTip == "Melee" or t.Name == "Combat") then return end
    end
    if LP.Backpack then
        for _, t in ipairs(LP.Backpack:GetChildren()) do
            if t:IsA("Tool") and (t.ToolTip == "Melee" or t.Name == "Combat") then
                t.Parent = char
                break
            end
        end
    end
end

local questCurrentBV = nil
setQuestHoverBV = function(enabled)
    local char = LP.Character
    local root = char and char:FindFirstChild("HumanoidRootPart")
    if not root then return end

    if enabled then
        if not questCurrentBV or questCurrentBV.Parent ~= root then
            local existing = root:FindFirstChild("EffectsSY")
            if existing and existing:IsA("BodyVelocity") then
                questCurrentBV = existing
            else
                questCurrentBV = Instance.new("BodyVelocity")
                questCurrentBV.Name = "EffectsSY"
                questCurrentBV.MaxForce = Vector3.new(100000, 100000, 100000)
                questCurrentBV.Parent = root
            end
        end
        questCurrentBV.Velocity = Vector3.zero
    else
        if questCurrentBV then
            pcall(function() questCurrentBV:Destroy() end)
            questCurrentBV = nil
        end
        local existing = root:FindFirstChild("EffectsSY")
        if existing then pcall(function() existing:Destroy() end) end
    end
end

local questCurrentTween = nil
stopQuestTween = function()
    if questCurrentTween then
        pcall(function() questCurrentTween:Cancel() end)
        questCurrentTween = nil
    end
end

function AutoQuestFarm.flightTo(destPos, speed, runAliveFunc)
    speed = speed or Cfg.QuestSpeed or 135
    if not isAlive() then
        stopQuestTween()
        return "DEATH_INTERRUPT"
    end

    local char = LP.Character
    local root = char and char:FindFirstChild("HumanoidRootPart")
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    if not root or not hum or hum.Health <= 0 then
        stopQuestTween()
        return "DEATH_INTERRUPT"
    end

    setQuestHoverBV(false)
    stopQuestTween()

    local startPos = root.Position
    local totalDist = (destPos - startPos).Magnitude
    if totalDist < 2 then
        setQuestHoverBV(true)
        return true
    end

    -- Altitud de crucero segura si la distancia supera 50 studs (evita agua y desincronización)
    if totalDist > 50 then
        local safeY = math.max(destPos.Y, 45)
        local midPos = Vector3.new(destPos.X, safeY, destPos.Z)
        local durMid = (midPos - startPos).Magnitude / speed
        local twMid = TweenService:Create(root, TweenInfo.new(durMid, Enum.EasingStyle.Linear), { CFrame = CFrame.new(midPos) })
        questCurrentTween = twMid
        twMid:Play()
        local limit = os.clock() + durMid + 3.0
        while twMid.PlaybackState == Enum.PlaybackState.Playing and os.clock() < limit do
            if not isAlive() then stopQuestTween(); return "DEATH_INTERRUPT" end
            if runAliveFunc and not runAliveFunc() then stopQuestTween(); return false end
            if AutoQuestFarm.hasStorableGroundFruit() then
                stopQuestTween()
                return "FRUIT_INTERRUPT"
            end
            task.wait(0.05)
        end
        stopQuestTween()
    end

    if not isAlive() then return "DEATH_INTERRUPT" end
    local curPos = root.Position
    local remDist = (destPos - curPos).Magnitude
    if remDist > 1 then
        local dur = remDist / speed
        local tw = TweenService:Create(root, TweenInfo.new(dur, Enum.EasingStyle.Linear), { CFrame = CFrame.new(destPos) })
        questCurrentTween = tw
        tw:Play()
        local limit = os.clock() + dur + 3.0
        while tw.PlaybackState == Enum.PlaybackState.Playing and os.clock() < limit do
            if not isAlive() then stopQuestTween(); return "DEATH_INTERRUPT" end
            if runAliveFunc and not runAliveFunc() then stopQuestTween(); return false end
            if AutoQuestFarm.hasStorableGroundFruit() then
                stopQuestTween()
                return "FRUIT_INTERRUPT"
            end
            task.wait(0.05)
        end
        stopQuestTween()
    end

    if not isAlive() then return "DEATH_INTERRUPT" end
    setQuestHoverBV(true)
    return true
end

function AutoQuestFarm.runCycle(runAliveFunc)
    if not AutoQuestFarm.needsFarming() then return true end

    -- Si hay fruta almacenable en el mapa, ceder inmediatamente
    if AutoQuestFarm.hasStorableGroundFruit() then
        return "FRUIT_INTERRUPT"
    end

    local curLvl = LP.Data and LP.Data.Level and LP.Data.Level.Value or 1
    local qInfo = AutoQuestFarm.resolveBestQuest(curLvl)
    if not qInfo or not qInfo.questName then
        setStatusErr("AutoQuest: Could not resolve quest for Level " .. tostring(curLvl))
        return false
    end

    -- Activar noclip continuo durante la sesión de farmeo de misiones
    local noclipActive = true
    local noclipConn = RunService.Stepped:Connect(function()
        if not noclipActive then return end
        local c = LP.Character
        if c then
            for _, p in ipairs(c:GetDescendants()) do
                if p:IsA("BasePart") and p.CanCollide then
                    p.CanCollide = false
                end
            end
        end
    end)

    local function cleanupNoclip()
        noclipActive = false
        if noclipConn then
            noclipConn:Disconnect()
            noclipConn = nil
        end
        setQuestHoverBV(false)
        stopQuestTween()
    end

    AutoQuestFarm.Status.active = true
    AutoQuestFarm.Status.currentQuest = string.format("%s (%s x%d)", qInfo.questName, qInfo.targetMob, qInfo.targetCount)
    AutoQuestFarm.Status.targetKills = qInfo.targetCount
    setBotActivity("AUTO_QUEST", qInfo)

    -- PASO 1: Aceptar la misión en el NPC dador
    local questState = AutoQuestFarm.getActiveQuestInfo()
    if not questState then
        setStatus(string.format("AutoQuest: Flying to NPC %s...", qInfo.npcName))
        local flyRes = AutoQuestFarm.flightTo(qInfo.npcPos + Vector3.new(0, 4, 0), Cfg.QuestSpeed or 135, runAliveFunc)
        if flyRes == "FRUIT_INTERRUPT" then
            cleanupNoclip()
            return "FRUIT_INTERRUPT"
        elseif flyRes == "DEATH_INTERRUPT" then
            cleanupNoclip()
            if not ensureAlive(35) then return false end
            return AutoQuestFarm.runCycle(runAliveFunc)
        end
        task.wait(0.5)

        setStatus("AutoQuest: Accepting quest " .. qInfo.questName)
        CommF_:InvokeServer("StartQuest", qInfo.questName, qInfo.subIndex)
        task.wait(0.5)

        questState = AutoQuestFarm.getActiveQuestInfo()
        if not questState then
            local retryFly = AutoQuestFarm.flightTo(qInfo.npcPos + Vector3.new(0, 2, 0), Cfg.QuestSpeed or 135, runAliveFunc)
            if retryFly == "DEATH_INTERRUPT" then
                cleanupNoclip()
                if not ensureAlive(35) then return false end
                return AutoQuestFarm.runCycle(runAliveFunc)
            end
            task.wait(0.5)
            CommF_:InvokeServer("StartQuest", qInfo.questName, qInfo.subIndex)
            task.wait(0.5)
            questState = AutoQuestFarm.getActiveQuestInfo()
        end
    end

    if not questState then
        setStatus("AutoQuest: Retrying quest acceptance...")
        cleanupNoclip()
        return false
    end

    setStatus(string.format("AutoQuest: %s (%s) — Hunting enemies...", questState.description, questState.progress))

    -- PASO 2: Eliminar mobs requeridos
    while questState and (runAliveFunc == nil or runAliveFunc()) and AutoQuestFarm.needsFarming() do
        -- Verificación y recuperación si el personaje murió
        if not isAlive() then
            setStatus("AutoQuest: Character died during quest. Waiting for respawn...")
            cleanupNoclip()
            if not ensureAlive(35) then
                return false
            end
            setStatus("AutoQuest: Respawned! Resuming quest: " .. tostring(questState.description or qInfo.questName))
            noclipActive = true
            noclipConn = RunService.Stepped:Connect(function()
                if not noclipActive then return end
                local c = LP.Character
                if c then
                    for _, p in ipairs(c:GetDescendants()) do
                        if p:IsA("BasePart") and p.CanCollide then
                            p.CanCollide = false
                        end
                    end
                end
            end)
            AutoQuestFarm.equipMelee()
            pcall(autoAssignStats)
            task.wait(0.5)
            questState = AutoQuestFarm.getActiveQuestInfo() or questState
        end

        -- Interrupción de máxima prioridad: si spawnea una fruta almacenable
        if AutoQuestFarm.hasStorableGroundFruit() then
            setStatus("AutoQuest paused: Storable fruit detected on map!")
            cleanupNoclip()
            return "FRUIT_INTERRUPT"
        end

        local targetEnemy = nil
        local enemyHum = nil
        local enemyPart = nil
        local bestDist = math.huge

        local char = LP.Character
        local root = char and char:FindFirstChild("HumanoidRootPart")

        if workspace:FindFirstChild("Enemies") and root then
            for _, enemy in ipairs(workspace.Enemies:GetChildren()) do
                if enemy.Name == qInfo.targetMob then
                    local hum = enemy:FindFirstChildOfClass("Humanoid")
                    local ePart = enemy:FindFirstChild("HumanoidRootPart") or enemy:FindFirstChild("Head") or enemy.PrimaryPart
                    if hum and hum.Health > 0 and ePart then
                        local d = (ePart.Position - root.Position).Magnitude
                        if d < bestDist then
                            bestDist = d
                            targetEnemy = enemy
                            enemyHum = hum
                            enemyPart = ePart
                        end
                    end
                end
            end
        end

        if targetEnemy and enemyPart and enemyHum and enemyHum.Health > 0 then
            setStatus(string.format("AutoQuest: Attacking %s (%s)", qInfo.targetMob, questState.progress))
            local overheadH = Cfg.QuestOverheadHeight or 30
            local overheadPos = enemyPart.Position + Vector3.new(0, overheadH, 0)
            local flyRes = AutoQuestFarm.flightTo(overheadPos, Cfg.QuestSpeed or 135, runAliveFunc)
            if flyRes == "FRUIT_INTERRUPT" then
                cleanupNoclip()
                return "FRUIT_INTERRUPT"
            elseif flyRes == "DEATH_INTERRUPT" then
                -- outer loop will catch death and respawn
            end
            setQuestHoverBV(true)
            AutoQuestFarm.equipMelee()

            local attackTimeout = tick() + 30
            local lastAttackTime = 0

            while tick() < attackTimeout and (runAliveFunc == nil or runAliveFunc()) do
                if not isAlive() then break end

                if AutoQuestFarm.hasStorableGroundFruit() then
                    cleanupNoclip()
                    return "FRUIT_INTERRUPT"
                end

                if not targetEnemy.Parent or not targetEnemy:IsDescendantOf(workspace) then break end
                if not enemyHum or enemyHum.Health <= 0 then break end

                local curRoot = LP.Character and LP.Character:FindFirstChild("HumanoidRootPart")
                if not curRoot then break end

                local curEnemyPos = enemyPart.Position
                local desiredPos = curEnemyPos + Vector3.new(0, overheadH, 0)
                local offset = (desiredPos - curRoot.Position).Magnitude

                if offset > 12 then
                    AutoQuestFarm.flightTo(desiredPos, Cfg.QuestSpeed or 135, runAliveFunc)
                    setQuestHoverBV(true)
                end

                AutoQuestFarm.equipMelee()

                if tick() - lastAttackTime >= 0.12 then
                    lastAttackTime = tick()
                    local hitLimb = _getHitPart(targetEnemy) or targetEnemy:FindFirstChild("Head") or enemyPart
                    _performFullAttack(hitLimb)
                end

                task.wait(0.04)

                local updatedQ = AutoQuestFarm.getActiveQuestInfo()
                if not updatedQ then
                    questState = nil
                    break
                else
                    questState = updatedQ
                    AutoQuestFarm.Status.currentKills = updatedQ.curKills
                end
            end
        else
            setStatus("AutoQuest: Moving to spawn zone for " .. qInfo.targetMob)
            local spawnPos = AutoQuestFarm.getMobSpawnPos(qInfo.targetMob) or (qInfo.npcPos + Vector3.new(100, 0, 0))
            local flyRes = AutoQuestFarm.flightTo(spawnPos + Vector3.new(0, 30, 0), Cfg.QuestSpeed or 135, runAliveFunc)
            if flyRes == "FRUIT_INTERRUPT" then
                cleanupNoclip()
                return "FRUIT_INTERRUPT"
            elseif flyRes == "DEATH_INTERRUPT" then
                -- outer loop will catch death
            end
            task.wait(1.5)
        end

        questState = AutoQuestFarm.getActiveQuestInfo()
        task.wait(0.1)
    end

    cleanupNoclip()
    AutoQuestFarm.Status.active = false
    setBotActivity("IDLE")

    -- Si la misión terminó (questState es nil)
    if not questState then
        Session.quest_completed = (Session.quest_completed or 0) + 1
        local curBeli, curLvl = getPlayerData()
        local cost = AutoQuestFarm.getGachaPrice()
        setStatus(string.format("AutoQuest complete! Beli: $%s / $%s (Quests done: %d)", formatBeli(curBeli), formatBeli(cost), Session.quest_completed))
        pcall(autoAssignStats)
        task.wait(1)
    end

    return true
end

-- ===================== Main Autonomous Execution Loop =====================
getgenv().FruitsHubRun = getgenv().FruitsHubRun or {}
local Run = getgenv().FruitsHubRun
Run.gen = (Run.gen or 0) + 1
local myRunGen = Run.gen
Run.active = true

local function runAlive()
    return getgenv().FruitsHubRun == Run and Run.active and Run.gen == myRunGen
end

local function mainLoopHost()
    task.spawn(function()
        setupCharacterLifecycle()
        setupSpawnListener()

        -- 1) Join Marines
        local dataT = 0
        while not LP:FindFirstChild("DataLoaded") and dataT < 45 do
            task.wait(0.5)
            dataT = dataT + 0.5
        end

        local teamT = 0
        while not (LP.Team and LP.Team.Name == Cfg.Team) and teamT < 60 do
            Cfg.JoinTeam(Cfg.Team)
            task.wait(3)
            teamT = teamT + 3
        end

        waitForChar(45)

        local storageWait = 0
        while not Cfg.StorageLoaded and storageWait < 30 do
            task.wait(0.5)
            storageWait = storageWait + 0.5
        end

        storeAllInventoryFruits()
        pcall(autoAssignStats)

        local rolled = false
        local noFruitStreak = 0
        while runAlive() do
            if not isAlive() then
                setStatus("Character waiting for respawn...")
                ensureAlive(35)
            end
            pcall(autoAssignStats)
            -- [TEMPORARY: MAGNET EVENT HOOK - ELIMINAR EN 15 DÍAS]
            -- Si el jugador necesita farmear Beli o Nivel para el Gacha, AutoQuest tiene máxima prioridad sobre eventos temporales
            if Cfg.MagnetFarm and MagnetEvent and MagnetEvent.isActive() and not (Cfg.AutoQuestFarm and AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming()) then
                DiscordAlerts.info("Magnet Storm active! Starting aerial token hunt.", "Magnet Event")
                local cycleOk, cycleErr = pcall(function()
                    MagnetEvent.runCycle(runAlive)
                end)
                if not cycleOk then
                    warn("[FruitsHub] MagnetEvent.runCycle error: " .. tostring(cycleErr))
                    stopTween()
                end
                task.wait(1)
            end

            -- PRIORIDAD 1: Magnet Gacha si tenemos 500+ tokens (prioridad absoluta sobre Zioles)
            while Cfg.MagnetGacha and MagnetEvent and MagnetEvent.canRoll() and runAlive() do
                MagnetEvent.rollGacha()
                task.wait(1.5)
            end
            -- [END TEMPORARY HOOK]

            -- PRIORIDAD 2: Zioles Gacha (en arranque o tras enfriamiento si Magnet no tiene tiradas pendientes)
            local now = os.time()
            local ziolesReady = (Session.gacha_cooldown_end <= now) and not Session.gacha_no_beli
            if not rolled or ziolesReady then
                if not (Cfg.MagnetGacha and MagnetEvent and MagnetEvent.canRoll()) then
                    rollFruit("ZiolesGacha")
                    rolled = true
                    task.wait(1.5)
                    closeGachaRoulette()
                    storeAllInventoryFruits()
                end
            end

            closeGachaRoulette()
            storeAllInventoryFruits()

            -- 3) Scan map for fruits
            scanForFruit()
            local scanWait = 0
            while fruitScanLock and scanWait < 2.5 do
                task.wait(0.2)
                scanWait = scanWait + 0.2
            end
            task.wait(0.5)

            if found and found.model and found.model.Parent then
                noFruitStreak = 0
                local fname = found.fname or found.model.Name
                setStatus("Moving towards: " .. fname)
                if tweenTo(found.model) then
                    local startDist = getRoot() and (getRoot().Position - found.pos).Magnitude or 0
                    local budget = math.min(600, math.floor((startDist / Cfg.Speed) * 2.5) + 20)
                    local tries = 0
                    local lastDist = startDist
                    local stall = 0

                    while runAlive() and found.model.Parent and tries < budget do
                        task.wait(0.5)
                        tries = tries + 1

                        if not isAlive() then
                            setStatus("Character died during fruit retrieval. Waiting for respawn...")
                            stopTween()
                            if not ensureAlive(35) then break end
                            if found and found.model and found.model.Parent then
                                setStatus("Respawned! Resuming flight towards: " .. tostring(found.fname or found.model.Name))
                                task.wait(0.5)
                                tweenTo(found.model)
                            else
                                break
                            end
                        end
                        local root = getRoot()
                        local prim = fruitPart(found.model)
                        if prim then
                            found.pos = prim.Position
                        end
                        if root and found.pos then
                            local d = (root.Position - found.pos).Magnitude
                            if d < 25 then
                                local tool = collectFruit(found.model)
                                if tool then
                                    task.wait(0.4)
                                    local storeOk, storeMsg = storeFruit(tool)
                                    setStatus(storeMsg)
                                    task.wait(1.5)
                                else
                                    task.wait(0.5)
                                    storeAllInventoryFruits()
                                end
                                break
                            end

                            if d >= lastDist - 1 then
                                stall = stall + 1
                                forceStand()
                                if stall % 3 == 0 then
                                    stopTween()
                                    task.wait()
                                    tweenTo(found.model)
                                end
                            else
                                stall = 0
                            end
                            lastDist = d
                        end
                    end
                    stopTween()
                end
            elseif scanState == "none" or scanState == "stored" then
                if Cfg.AutoQuestFarm and AutoQuestFarm and AutoQuestFarm.needsFarming() then
                    noFruitStreak = 0
                    local qCycleOk, qCycleErr = pcall(function()
                        AutoQuestFarm.runCycle(runAlive)
                    end)
                    if not qCycleOk then
                        warn("[FruitsHub] AutoQuestFarm.runCycle error: " .. tostring(qCycleErr))
                        stopQuestTween()
                    end

                    -- Check if farming completed and Gacha can be rolled now
                    if not AutoQuestFarm.needsFarming() then
                        now = os.time()
                        local cdEnd = tonumber(Session.gacha_cooldown_end) or 0
                        if cdEnd <= now then
                            rollFruit("ZiolesGacha")
                            closeGachaRoulette()
                            storeAllInventoryFruits()
                        end
                    end
                else
                    if scanState == "none" then
                        noFruitStreak = noFruitStreak + 1
                        if noFruitStreak >= Cfg.HopAfterEmptyScans then
                            setStatus("No fruits in " .. noFruitStreak .. " scans. Initiating server hop...")
                            serverHop()
                            task.wait(2)
                            noFruitStreak = 0
                        end
                    elseif scanState == "stored" then
                        setStatus("All fruits on the map are already stored. Immediate server hop.")
                        DiscordAlerts.info("All server fruits are already in storage. Changing server...", "🔄 Hop: Storage Full")
                        noFruitStreak = 0
                        serverHop()
                        task.wait(2)
                    end
                end
            end

            task.wait(1)
        end
    end)
end

-- ===================== Real-Time ESP & Distance Rendering =====================
getgenv().FruitsHubEsp = getgenv().FruitsHubEsp or {}
local ESP = getgenv().FruitsHubEsp

if ESP.line then ESP.line:Remove() end
if ESP.text then ESP.text:Remove() end

ESP.line = Drawing.new("Line")
ESP.text = Drawing.new("Text")

ESP.line.Color = Color3.fromRGB(59, 130, 246)
ESP.line.Thickness = 2
ESP.line.Transparency = 1
ESP.text.Color = Color3.fromRGB(96, 205, 255)
ESP.text.Size = 16
ESP.text.Center = true
ESP.text.Outline = true
ESP.text.OutlineColor = Color3.fromRGB(0, 0, 0)

local function espRender()
    local target = found
    if not (target and target.model and target.model.Parent) then
        ESP.line.Visible = false
        ESP.text.Visible = false
        return
    end
    local cam = workspace.CurrentCamera
    local root = getRoot()
    local prim = target.model and fruitPart(target.model)
    if not (cam and root and prim) then
        ESP.line.Visible = false
        ESP.text.Visible = false
        return
    end
    local pos = prim.Position
    local screen, onScreen = cam:WorldToViewportPoint(pos)

    if not onScreen then
        ESP.line.Visible = false
        ESP.text.Visible = false
        return
    end

    local rootScreen = cam:WorldToViewportPoint(root.Position)
    local dist = (root.Position - pos).Magnitude

    ESP.line.From = Vector2.new(rootScreen.X, rootScreen.Y)
    ESP.line.To = Vector2.new(screen.X, screen.Y)
    ESP.line.Visible = true

    ESP.text.Position = Vector2.new(screen.X, screen.Y - 22)
    ESP.text.Text = (target.fname or (target.model and target.model.Name)) .. "\n" .. tostring(math.floor(dist)) .. " studs"
    ESP.text.Visible = true

    if statusBaseMsg:find("Moving towards", 1, true) then
        local stLbl = LP:FindFirstChildOfClass("PlayerGui") and
            LP.PlayerGui:FindFirstChild("FruitsHub", false) and
            LP.PlayerGui.FruitsHub:FindFirstChild("StatusText", true)
        if stLbl then
            stLbl.Text = statusBaseMsg .. " | " .. tostring(math.floor(dist)) .. " studs"
        end
    end
end

if ESP._conn then ESP._conn:Disconnect() end
ESP._conn = RunService.RenderStepped:Connect(espRender)

-- Live reload cleanup
if STATE and typeof(STATE.onCleanup) == "function" then
    STATE.onCleanup(function()
        if ESP.line then ESP.line:Remove() end
        if ESP.text then ESP.text:Remove() end
        if ESP._conn then ESP._conn:Disconnect() end
        if childAddedConn then childAddedConn:Disconnect() end
        stopTween()
        if Run then Run.active = false end
    end)
end

-- ===================== Fullscreen Dashboard GUI & 3D Render Controls =====================
local function buildStatusUI()
    local PlayerGui = LP:FindFirstChildOfClass("PlayerGui") or LP:WaitForChild("PlayerGui", 10)
    if not PlayerGui then return end

    local old = PlayerGui:FindFirstChild("FruitsHub") or PlayerGui:FindFirstChild("MuyEstableHub")
    if old then pcall(function() old:Destroy() end) end

    local gui = Instance.new("ScreenGui")
    gui.Name = "FruitsHub"
    gui.ResetOnSpawn = false
    gui.IgnoreGuiInset = false
    gui.DisplayOrder = 999
    gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
    gui.Parent = PlayerGui

    -- Fullscreen Background Overlay (covers 3D world when rendering is off)
    local overlay = Instance.new("Frame")
    overlay.Name = "Overlay"
    overlay.Size = UDim2.new(1, 0, 1, 100)
    overlay.Position = UDim2.new(0, 0, 0, -100)
    overlay.BackgroundColor3 = Color3.fromRGB(11, 14, 20)
    overlay.BorderSizePixel = 0
    overlay.ZIndex = 1
    overlay.Parent = gui

    -- 3D Rendering & FPS control
    local is3dEnabled = not (Cfg.Disable3D == true)

    local function applyRenderState()
        pcall(function()
            RunService:Set3dRenderingEnabled(is3dEnabled)
        end)
        if not is3dEnabled then
            overlay.BackgroundTransparency = 0
        else
            overlay.BackgroundTransparency = 0.55
        end
    end

    applyRenderState()

    if typeof(setfpscap) == "function" and Cfg.TargetFPS then
        pcall(function() setfpscap(Cfg.TargetFPS) end)
    end

    -- Hide default Roblox Backpack hotbar (removes "[1 Combat]" at bottom)
    pcall(function()
        game:GetService("StarterGui"):SetCoreGuiEnabled(Enum.CoreGuiType.Backpack, false)
    end)

    -- Main Fullscreen Container (Dashboard Shell)
    local shell = Instance.new("Frame")
    shell.Name = "Main"
    shell.AnchorPoint = Vector2.new(0, 0)
    shell.Position = UDim2.new(0, 0, 0, 0)
    shell.BackgroundColor3 = Color3.fromRGB(11, 14, 20)
    shell.BorderSizePixel = 0
    shell.ZIndex = 2
    shell.Parent = gui

    local uiScale = Instance.new("UIScale")
    uiScale.Name = "DashboardScale"
    uiScale.Parent = shell

    local function updateScale()
        pcall(function()
            if not gui or not gui.Parent or not shell or not uiScale then return end
            local absSize = gui.AbsoluteSize
            local cam = workspace.CurrentCamera
            local w, h = absSize.X, absSize.Y
            if w < 100 or h < 100 then
                if cam and cam.ViewportSize.X >= 100 and cam.ViewportSize.Y >= 100 then
                    w, h = cam.ViewportSize.X, cam.ViewportSize.Y
                else
                    return
                end
            end

            -- Responsive baseline: 620 x 310
            local scaleX = w / 620
            local scaleY = h / 310
            local s = math.clamp(math.min(scaleX, scaleY), 0.7, 3.0)

            uiScale.Scale = s
            shell.Size = UDim2.new(1 / s, 0, 1 / s, 0)
        end)
    end

    gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(updateScale)
    local cam = workspace.CurrentCamera
    if cam then
        cam:GetPropertyChangedSignal("ViewportSize"):Connect(updateScale)
    end
    updateScale()

    local shellPadding = Instance.new("UIPadding")
    shellPadding.PaddingTop = UDim.new(0, 6)
    shellPadding.PaddingBottom = UDim.new(0, 6)
    shellPadding.PaddingLeft = UDim.new(0, 8)
    shellPadding.PaddingRight = UDim.new(0, 8)
    shellPadding.Parent = shell

    local shellLayout = Instance.new("UIListLayout")
    shellLayout.FillDirection = Enum.FillDirection.Vertical
    shellLayout.SortOrder = Enum.SortOrder.LayoutOrder
    shellLayout.Padding = UDim.new(0, 6)
    shellLayout.Parent = shell

    -- ---------- 1. Header Bar ----------
    local header = Instance.new("Frame")
    header.Name = "Header"
    header.LayoutOrder = 1
    header.Size = UDim2.new(1, 0, 0, 30)
    header.BackgroundTransparency = 1
    header.ZIndex = 3
    header.Parent = shell

    local titleContainer = Instance.new("Frame")
    titleContainer.Name = "TitleContainer"
    titleContainer.Size = UDim2.new(1, -210, 1, 0)
    titleContainer.BackgroundTransparency = 1
    titleContainer.ZIndex = 3
    titleContainer.Parent = header

    -- ===== Logo Loading: Download → Cache → getcustomasset =====
    -- Logo is hosted on Catbox CDN. Downloaded on first run and cached in
    -- the executor's workspace so all users get it without any local setup.
    local LOGO_CDN_URL   = "https://files.catbox.moe/kgq50j.png"
    local LOGO_LOCAL_PATH = "FruitsHub/logo.png"
    local LOGO_FALLBACK  = "rbxthumb://type=Asset&id=94904197752233&w=150&h=150"

    -- Resolve the content URI synchronously if already cached
    local function resolveLogoUri()
        local hasFile  = typeof(isfile)  == "function"
        local hasGet   = typeof(getcustomasset) == "function"
        local hasSyn   = typeof(getsynasset)    == "function"
        if hasFile and isfile(LOGO_LOCAL_PATH) then
            if hasGet then
                local ok, uri = pcall(getcustomasset, LOGO_LOCAL_PATH)
                if ok and uri and uri ~= "" then return uri end
            end
            if hasSyn then
                local ok, uri = pcall(getsynasset, LOGO_LOCAL_PATH)
                if ok and uri and uri ~= "" then return uri end
            end
        end
        return nil
    end

    local logoIcon = Instance.new("ImageLabel")
    logoIcon.Name = "LogoIcon"
    logoIcon.BackgroundTransparency = 1
    logoIcon.ImageColor3 = Color3.new(1, 1, 1)
    logoIcon.ImageTransparency = 0
    logoIcon.ScaleType = Enum.ScaleType.Fit
    logoIcon.Size = UDim2.fromOffset(24, 24)
    logoIcon.Position = UDim2.new(0, 0, 0.5, -12)
    logoIcon.ZIndex = 10
    logoIcon.Parent = titleContainer

    -- Set initial image (cached or fallback), then attempt download in background
    local cachedUri = resolveLogoUri()
    logoIcon.Image = cachedUri or LOGO_FALLBACK
    Cfg.LogoAsset = logoIcon.Image

    task.spawn(function()
        -- If not cached yet, download from CDN and save to workspace
        if not cachedUri then
            pcall(function()
                local req = httpRequest or (http and http.request)
                if not req then return end
                local res = req({ Url = LOGO_CDN_URL, Method = "GET" })
                if res and (res.StatusCode == 200 or res.status == 200) then
                    local body = res.Body or res.body
                    if body and #body > 100 then
                        if not isfile("FruitsHub") then
                            pcall(makefolder, "FruitsHub")
                        end
                        pcall(writefile, LOGO_LOCAL_PATH, body)
                        -- Apply newly downloaded logo
                        local uri = resolveLogoUri()
                        if uri then
                            logoIcon.Image = ""
                            task.wait()
                            logoIcon.Image = uri
                            Cfg.LogoAsset = uri
                            -- Also update miniBar logo if visible
                            if miniLogo and miniLogo.Parent then
                                miniLogo.Image = ""
                                task.wait()
                                miniLogo.Image = uri
                            end
                        end
                    end
                end
            end)
        end
        -- ContentProvider preload as safety net
        pcall(function()
            game:GetService("ContentProvider"):PreloadAsync({ logoIcon })
        end)
    end)

    local brandLabel = Instance.new("TextLabel")
    brandLabel.Name = "Brand"
    brandLabel.Text = "FRUITSHUB"
    brandLabel.Font = Enum.Font.GothamBold
    brandLabel.TextSize = 13
    brandLabel.TextColor3 = Color3.fromRGB(56, 189, 248)
    brandLabel.TextXAlignment = Enum.TextXAlignment.Left
    brandLabel.BackgroundTransparency = 1
    brandLabel.ZIndex = 10
    brandLabel.Position = UDim2.new(0, 30, 0, 0)
    brandLabel.Size = UDim2.new(0, 88, 1, 0)
    brandLabel.Parent = titleContainer

    local userTitle = Instance.new("TextLabel")
    userTitle.Name = "UserTitle"
    userTitle.Font = Enum.Font.GothamMedium
    userTitle.TextSize = 11
    userTitle.TextColor3 = Color3.fromRGB(203, 213, 225)
    userTitle.TextXAlignment = Enum.TextXAlignment.Left
    userTitle.TextTruncate = Enum.TextTruncate.AtEnd
    userTitle.BackgroundTransparency = 1
    userTitle.ZIndex = 10
    userTitle.Position = UDim2.new(0, 122, 0, 0)
    userTitle.Size = UDim2.new(1, -122, 1, 0)
    userTitle.Text = tostring(LP and LP.Name or "Player")
    userTitle.Parent = titleContainer

    local rightControls = Instance.new("Frame")
    rightControls.Name = "RightControls"
    rightControls.Size = UDim2.new(0, 200, 1, 0)
    rightControls.Position = UDim2.new(1, -200, 0, 0)
    rightControls.BackgroundTransparency = 1
    rightControls.ZIndex = 3
    rightControls.Parent = header

    local btnList = Instance.new("UIListLayout")
    btnList.FillDirection = Enum.FillDirection.Horizontal
    btnList.HorizontalAlignment = Enum.HorizontalAlignment.Right
    btnList.VerticalAlignment = Enum.VerticalAlignment.Center
    btnList.Padding = UDim.new(0, 5)
    btnList.Parent = rightControls

    -- Status Pill Badge
    local statusBadge = Instance.new("TextLabel")
    statusBadge.Name = "StatusBadge"
    statusBadge.Text = "● Online"
    statusBadge.Font = Enum.Font.GothamBold
    statusBadge.TextSize = 10
    statusBadge.TextColor3 = Color3.fromRGB(255, 255, 255)
    statusBadge.BackgroundColor3 = Color3.fromRGB(16, 185, 129)
    statusBadge.BorderSizePixel = 0
    statusBadge.ZIndex = 4
    statusBadge.Size = UDim2.fromOffset(72, 22)
    statusBadge.Parent = rightControls

    local badgeCorner = Instance.new("UICorner")
    badgeCorner.CornerRadius = UDim.new(0, 11)
    badgeCorner.Parent = statusBadge

    -- Toggle 3D Render Button
    local btn3d = Instance.new("TextButton")
    btn3d.Name = "Toggle3D"
    btn3d.Size = UDim2.fromOffset(72, 22)
    btn3d.Font = Enum.Font.GothamBold
    btn3d.TextSize = 10
    btn3d.BorderSizePixel = 0
    btn3d.AutoButtonColor = true
    btn3d.ZIndex = 4
    btn3d.Parent = rightControls

    local btn3dCorner = Instance.new("UICorner")
    btn3dCorner.CornerRadius = UDim.new(0, 5)
    btn3dCorner.Parent = btn3d

    local btn3dStroke = Instance.new("UIStroke")
    btn3dStroke.Thickness = 1
    btn3dStroke.Parent = btn3d

    local function refresh3dBtn()
        if is3dEnabled then
            btn3d.Text = "3D: ON"
            btn3d.TextColor3 = Color3.fromRGB(34, 197, 94)
            btn3d.BackgroundColor3 = Color3.fromRGB(20, 36, 26)
            btn3dStroke.Color = Color3.fromRGB(34, 197, 94)
        else
            btn3d.Text = "3D: OFF"
            btn3d.TextColor3 = Color3.fromRGB(239, 68, 68)
            btn3d.BackgroundColor3 = Color3.fromRGB(38, 20, 24)
            btn3dStroke.Color = Color3.fromRGB(239, 68, 68)
        end
    end
    refresh3dBtn()

    btn3d.MouseButton1Click:Connect(function()
        is3dEnabled = not is3dEnabled
        refresh3dBtn()
        applyRenderState()
    end)

    -- Minimize Button
    local btnMin = Instance.new("TextButton")
    btnMin.Name = "BtnMin"
    btnMin.Text = "—"
    btnMin.Font = Enum.Font.GothamBold
    btnMin.TextSize = 11
    btnMin.TextColor3 = Color3.fromRGB(203, 213, 225)
    btnMin.BackgroundColor3 = Color3.fromRGB(25, 31, 44)
    btnMin.Size = UDim2.fromOffset(22, 22)
    btnMin.BorderSizePixel = 0
    btnMin.ZIndex = 4
    btnMin.Parent = rightControls

    local minCorner = Instance.new("UICorner")
    minCorner.CornerRadius = UDim.new(0, 5)
    minCorner.Parent = btnMin

    -- Floating Mini Bar (when minimized)
    local miniBar = Instance.new("Frame")
    miniBar.Name = "MiniBar"
    miniBar.Size = UDim2.fromOffset(205, 30)
    miniBar.Position = UDim2.new(0, 14, 1, -14)
    miniBar.AnchorPoint = Vector2.new(0, 1)
    miniBar.BackgroundColor3 = Color3.fromRGB(15, 18, 26)
    miniBar.BorderSizePixel = 0
    miniBar.ZIndex = 10
    miniBar.Visible = false
    miniBar.Parent = gui

    local miniCorner = Instance.new("UICorner")
    miniCorner.CornerRadius = UDim.new(0, 6)
    miniCorner.Parent = miniBar

    local miniStroke = Instance.new("UIStroke")
    miniStroke.Color = Color3.fromRGB(56, 189, 248)
    miniStroke.Thickness = 1
    miniStroke.Parent = miniBar

    local miniLogo = Instance.new("ImageLabel")
    miniLogo.Name = "MiniLogo"
    miniLogo.Image = cachedUri or LOGO_FALLBACK
    miniLogo.BackgroundTransparency = 1
    miniLogo.ImageColor3 = Color3.new(1, 1, 1)
    miniLogo.ImageTransparency = 0
    miniLogo.ScaleType = Enum.ScaleType.Fit
    miniLogo.Size = UDim2.fromOffset(18, 18)
    miniLogo.Position = UDim2.new(0, 6, 0.5, -9)
    miniLogo.ZIndex = 12
    miniLogo.Parent = miniBar

    local miniText = Instance.new("TextLabel")
    miniText.Text = "FruitsHub · Active"
    miniText.Font = Enum.Font.GothamBold
    miniText.TextSize = 10
    miniText.TextColor3 = Color3.fromRGB(241, 245, 249)
    miniText.BackgroundTransparency = 1
    miniText.ZIndex = 11
    miniText.Position = UDim2.new(0, 28, 0, 0)
    miniText.Size = UDim2.new(0, 115, 1, 0)
    miniText.TextXAlignment = Enum.TextXAlignment.Left
    miniText.Parent = miniBar

    local miniExpand = Instance.new("TextButton")
    miniExpand.Text = "Open"
    miniExpand.Font = Enum.Font.GothamBold
    miniExpand.TextSize = 10
    miniExpand.TextColor3 = Color3.fromRGB(255, 255, 255)
    miniExpand.BackgroundColor3 = Color3.fromRGB(56, 189, 248)
    miniExpand.Size = UDim2.fromOffset(48, 20)
    miniExpand.Position = UDim2.new(1, -54, 0.5, -10)
    miniExpand.BorderSizePixel = 0
    miniExpand.ZIndex = 11
    miniExpand.Parent = miniBar

    local expCorner = Instance.new("UICorner")
    expCorner.CornerRadius = UDim.new(0, 4)
    expCorner.Parent = miniExpand

    btnMin.MouseButton1Click:Connect(function()
        shell.Visible = false
        miniBar.Visible = true
        if is3dEnabled then overlay.BackgroundTransparency = 1 end
    end)

    miniExpand.MouseButton1Click:Connect(function()
        miniBar.Visible = false
        shell.Visible = true
        applyRenderState()
    end)

    -- F1 Shortcut
    if UserInputService then
        pcall(function()
            UserInputService.InputBegan:Connect(function(input, gProcessed)
                if not gProcessed and input.KeyCode == Enum.KeyCode.F1 then
                    is3dEnabled = not is3dEnabled
                    refresh3dBtn()
                    applyRenderState()
                end
            end)
        end)
    end

    -- ---------- 2. Row: 4 Metric Cards Across ----------
    local statsRow = Instance.new("Frame")
    statsRow.Name = "StatsRow"
    statsRow.LayoutOrder = 2
    statsRow.Size = UDim2.new(1, 0, 0, 48)
    statsRow.BackgroundTransparency = 1
    statsRow.ZIndex = 3
    statsRow.Parent = shell

    local statsLayout = Instance.new("UIListLayout")
    statsLayout.FillDirection = Enum.FillDirection.Horizontal
    statsLayout.Padding = UDim.new(0, 6)
    statsLayout.Parent = statsRow

    local function createStatCard(titleText, defaultVal, valColor)
        local card = Instance.new("Frame")
        card.Size = UDim2.new(0.25, -5, 1, 0)
        card.BackgroundColor3 = Color3.fromRGB(18, 22, 32)
        card.BorderSizePixel = 0
        card.ZIndex = 3
        card.Parent = statsRow

        local cCorner = Instance.new("UICorner")
        cCorner.CornerRadius = UDim.new(0, 5)
        cCorner.Parent = card

        local cStroke = Instance.new("UIStroke")
        cStroke.Color = Color3.fromRGB(30, 38, 54)
        cStroke.Thickness = 1
        cStroke.Parent = card

        local tLbl = Instance.new("TextLabel")
        tLbl.Text = titleText
        tLbl.Font = Enum.Font.GothamBold
        tLbl.TextSize = 8
        tLbl.TextColor3 = Color3.fromRGB(148, 163, 184)
        tLbl.TextXAlignment = Enum.TextXAlignment.Left
        tLbl.BackgroundTransparency = 1
        tLbl.ZIndex = 4
        tLbl.Position = UDim2.new(0, 8, 0, 4)
        tLbl.Size = UDim2.new(1, -16, 0, 11)
        tLbl.Parent = card

        local vLbl = Instance.new("TextLabel")
        vLbl.Text = defaultVal
        vLbl.Font = Enum.Font.GothamBold
        vLbl.TextSize = 13
        vLbl.TextColor3 = valColor or Color3.fromRGB(241, 245, 249)
        vLbl.TextXAlignment = Enum.TextXAlignment.Left
        vLbl.TextTruncate = Enum.TextTruncate.AtEnd
        vLbl.BackgroundTransparency = 1
        vLbl.ZIndex = 4
        vLbl.Position = UDim2.new(0, 8, 0, 16)
        vLbl.Size = UDim2.new(1, -16, 0, 17)
        vLbl.Parent = card

        local sLbl = Instance.new("TextLabel")
        sLbl.Text = "—"
        sLbl.Font = Enum.Font.GothamMedium
        sLbl.TextSize = 9
        sLbl.TextColor3 = Color3.fromRGB(120, 136, 160)
        sLbl.TextXAlignment = Enum.TextXAlignment.Left
        sLbl.TextTruncate = Enum.TextTruncate.AtEnd
        sLbl.BackgroundTransparency = 1
        sLbl.ZIndex = 4
        sLbl.Position = UDim2.new(0, 8, 0, 33)
        sLbl.Size = UDim2.new(1, -16, 0, 11)
        sLbl.Parent = card

        return vLbl, sLbl
    end

    local beliVal, beliSub = createStatCard("💰 CURRENT BELI", "$0", Color3.fromRGB(34, 197, 94))
    local gachaVal, gachaSub = createStatCard("⏳ GACHA ROLL", "🟢 AVAILABLE", Color3.fromRGB(245, 158, 11))
    local fruitVal, fruitSub = createStatCard("📦 FRUITS STORED", "0 stored", Color3.fromRGB(56, 189, 248))
    local serverVal, serverSub = createStatCard("🌐 SERVER & SESSION", "Hop #1", Color3.fromRGB(168, 85, 247))

    -- ---------- 3. Row: Live Activity Banner ----------
    local actBanner = Instance.new("Frame")
    actBanner.Name = "ActivityBanner"
    actBanner.LayoutOrder = 3
    actBanner.Size = UDim2.new(1, 0, 0, 32)
    actBanner.BackgroundColor3 = Color3.fromRGB(18, 22, 32)
    actBanner.BorderSizePixel = 0
    actBanner.ZIndex = 3
    actBanner.Parent = shell

    local actCorner = Instance.new("UICorner")
    actCorner.CornerRadius = UDim.new(0, 5)
    actCorner.Parent = actBanner

    local actStroke = Instance.new("UIStroke")
    actStroke.Color = Color3.fromRGB(30, 38, 54)
    actStroke.Thickness = 1
    actStroke.Parent = actBanner

    local actAccent = Instance.new("Frame")
    actAccent.Size = UDim2.new(0, 3, 1, -8)
    actAccent.Position = UDim2.new(0, 6, 0, 4)
    actAccent.BackgroundColor3 = Color3.fromRGB(56, 189, 248)
    actAccent.BorderSizePixel = 0
    actAccent.ZIndex = 4
    actAccent.Parent = actBanner

    local accentCorner = Instance.new("UICorner")
    accentCorner.CornerRadius = UDim.new(0, 2)
    accentCorner.Parent = actAccent

    local statusText = Instance.new("TextLabel")
    statusText.Name = "StatusText"
    statusText.Text = "Initializing system..."
    statusText.Font = Enum.Font.GothamMedium
    statusText.TextSize = 11
    statusText.TextColor3 = Color3.fromRGB(241, 245, 249)
    statusText.TextXAlignment = Enum.TextXAlignment.Left
    statusText.TextTruncate = Enum.TextTruncate.AtEnd
    statusText.BackgroundTransparency = 1
    statusText.ZIndex = 4
    statusText.Position = UDim2.new(0, 16, 0, 2)
    statusText.Size = UDim2.new(0.65, -16, 1, -4)
    statusText.Parent = actBanner

    local actMeta = Instance.new("TextLabel")
    actMeta.Name = "ActMeta"
    actMeta.Text = "Server #1 · Uptime: 00:00:00"
    actMeta.Font = Enum.Font.Gotham
    actMeta.TextSize = 9
    actMeta.TextColor3 = Color3.fromRGB(120, 136, 160)
    actMeta.TextXAlignment = Enum.TextXAlignment.Right
    actMeta.TextTruncate = Enum.TextTruncate.AtEnd
    actMeta.BackgroundTransparency = 1
    actMeta.ZIndex = 4
    actMeta.Position = UDim2.new(0.65, 0, 0, 2)
    actMeta.Size = UDim2.new(0.35, -10, 1, -4)
    actMeta.Parent = actBanner

    -- ---------- 4. Content Area: Dual-Panel (Left: Fruits / Right: Session) ----------
    local mainContent = Instance.new("Frame")
    mainContent.Name = "MainContent"
    mainContent.LayoutOrder = 4
    mainContent.Size = UDim2.new(1, 0, 1, -128)
    mainContent.BackgroundTransparency = 1
    mainContent.BorderSizePixel = 0
    mainContent.ZIndex = 3
    mainContent.Parent = shell

    local contentLayout = Instance.new("UIListLayout")
    contentLayout.FillDirection = Enum.FillDirection.Horizontal
    contentLayout.Padding = UDim.new(0, 6)
    contentLayout.Parent = mainContent

    -- ===== Left Panel: Fruit Storage (63% width) =====
    local leftPanel = Instance.new("Frame")
    leftPanel.Name = "FruitPanel"
    leftPanel.Size = UDim2.new(0.63, -3, 1, 0)
    leftPanel.BackgroundColor3 = Color3.fromRGB(18, 22, 32)
    leftPanel.BorderSizePixel = 0
    leftPanel.ZIndex = 3
    leftPanel.Parent = mainContent

    local lpCorner = Instance.new("UICorner")
    lpCorner.CornerRadius = UDim.new(0, 6)
    lpCorner.Parent = leftPanel

    local lpStroke = Instance.new("UIStroke")
    lpStroke.Color = Color3.fromRGB(30, 38, 54)
    lpStroke.Thickness = 1
    lpStroke.Parent = leftPanel

    local invHeaderRow = Instance.new("Frame")
    invHeaderRow.Name = "InvHeaderRow"
    invHeaderRow.Size = UDim2.new(1, -16, 0, 20)
    invHeaderRow.Position = UDim2.new(0, 8, 0, 5)
    invHeaderRow.BackgroundTransparency = 1
    invHeaderRow.ZIndex = 4
    invHeaderRow.Parent = leftPanel

    local invHeader = Instance.new("TextLabel")
    invHeader.Name = "InvHeader"
    invHeader.Text = "📦 FRUIT STORAGE (0 stored)"
    invHeader.Font = Enum.Font.GothamBold
    invHeader.TextSize = 10
    invHeader.TextColor3 = Color3.fromRGB(226, 232, 240)
    invHeader.TextXAlignment = Enum.TextXAlignment.Left
    invHeader.TextTruncate = Enum.TextTruncate.AtEnd
    invHeader.BackgroundTransparency = 1
    invHeader.ZIndex = 4
    invHeader.Size = UDim2.new(0.65, 0, 1, 0)
    invHeader.Parent = invHeaderRow

    local invLatest = Instance.new("TextLabel")
    invLatest.Name = "InvLatest"
    invLatest.Text = ""
    invLatest.Font = Enum.Font.GothamMedium
    invLatest.TextSize = 9
    invLatest.TextColor3 = Color3.fromRGB(56, 189, 248)
    invLatest.TextXAlignment = Enum.TextXAlignment.Right
    invLatest.TextTruncate = Enum.TextTruncate.AtEnd
    invLatest.BackgroundTransparency = 1
    invLatest.ZIndex = 4
    invLatest.Position = UDim2.new(0.65, 0, 0, 0)
    invLatest.Size = UDim2.new(0.35, 0, 1, 0)
    invLatest.Parent = invHeaderRow

    local fruitScroll = Instance.new("ScrollingFrame")
    fruitScroll.Name = "FruitScroll"
    fruitScroll.Size = UDim2.new(1, -12, 1, -30)
    fruitScroll.Position = UDim2.new(0, 6, 0, 26)
    fruitScroll.BackgroundTransparency = 1
    fruitScroll.BorderSizePixel = 0
    fruitScroll.ZIndex = 4
    fruitScroll.ScrollBarThickness = 3
    fruitScroll.ScrollBarImageColor3 = Color3.fromRGB(71, 85, 105)
    fruitScroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
    fruitScroll.CanvasSize = UDim2.new(0, 0, 0, 0)
    fruitScroll.Parent = leftPanel

    local fruitListLayout = Instance.new("UIListLayout")
    fruitListLayout.FillDirection = Enum.FillDirection.Vertical
    fruitListLayout.Padding = UDim.new(0, 4)
    fruitListLayout.Parent = fruitScroll

    local function createRarityRow(categoryName, accentColor, hexColor)
        local row = Instance.new("Frame")
        row.Size = UDim2.new(1, -4, 0, 0)
        row.AutomaticSize = Enum.AutomaticSize.Y
        row.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
        row.BorderSizePixel = 0
        row.ZIndex = 4
        row.Parent = fruitScroll

        local rowCorner = Instance.new("UICorner")
        rowCorner.CornerRadius = UDim.new(0, 4)
        rowCorner.Parent = row

        local rowStroke = Instance.new("UIStroke")
        rowStroke.Color = Color3.fromRGB(24, 30, 42)
        rowStroke.Thickness = 1
        rowStroke.Parent = row

        local rowPadding = Instance.new("UIPadding")
        rowPadding.PaddingTop = UDim.new(0, 3)
        rowPadding.PaddingBottom = UDim.new(0, 4)
        rowPadding.PaddingLeft = UDim.new(0, 6)
        rowPadding.PaddingRight = UDim.new(0, 6)
        rowPadding.Parent = row

        local rowLayout = Instance.new("UIListLayout")
        rowLayout.FillDirection = Enum.FillDirection.Vertical
        rowLayout.Padding = UDim.new(0, 2)
        rowLayout.Parent = row

        local titleRow = Instance.new("Frame")
        titleRow.Size = UDim2.new(1, 0, 0, 14)
        titleRow.BackgroundTransparency = 1
        titleRow.ZIndex = 5
        titleRow.Parent = row

        local tLabel = Instance.new("TextLabel")
        tLabel.Text = categoryName
        tLabel.Font = Enum.Font.GothamBold
        tLabel.TextSize = 9
        tLabel.TextColor3 = accentColor
        tLabel.TextXAlignment = Enum.TextXAlignment.Left
        tLabel.BackgroundTransparency = 1
        tLabel.ZIndex = 5
        tLabel.Size = UDim2.new(1, -30, 1, 0)
        tLabel.Parent = titleRow

        local bLabel = Instance.new("TextLabel")
        bLabel.Text = "0"
        bLabel.Font = Enum.Font.GothamBold
        bLabel.TextSize = 9
        bLabel.TextColor3 = Color3.fromRGB(255, 255, 255)
        bLabel.BackgroundColor3 = accentColor
        bLabel.BackgroundTransparency = 0.3
        bLabel.BorderSizePixel = 0
        bLabel.ZIndex = 5
        bLabel.Size = UDim2.new(0, 22, 0, 13)
        bLabel.Position = UDim2.new(1, -22, 0.5, -6)
        bLabel.Parent = titleRow

        local bCorner = Instance.new("UICorner")
        bCorner.CornerRadius = UDim.new(0, 6)
        bCorner.Parent = bLabel

        local cText = Instance.new("TextLabel")
        cText.Text = "<font color=\"#64748b\"><i>None stored</i></font>"
        cText.RichText = true
        cText.Font = Enum.Font.Gotham
        cText.TextSize = 9
        cText.TextColor3 = Color3.fromRGB(226, 232, 240)
        cText.TextXAlignment = Enum.TextXAlignment.Left
        cText.TextYAlignment = Enum.TextYAlignment.Top
        cText.TextWrapped = true
        cText.AutomaticSize = Enum.AutomaticSize.Y
        cText.Size = UDim2.new(1, 0, 0, 0)
        cText.BackgroundTransparency = 1
        cText.ZIndex = 5
        cText.Parent = row

        return bLabel, cText, hexColor
    end

    local mythBadge, mythText = createRarityRow("🟣 MYTHICAL", Color3.fromRGB(192, 132, 252), "#c084fc")
    local legBadge, legText = createRarityRow("🟡 LEGENDARY", Color3.fromRGB(250, 204, 21), "#facc15")
    local rareBadge, rareText = createRarityRow("🔵 RARE", Color3.fromRGB(96, 165, 250), "#60a5fa")
    local comBadge, comText = createRarityRow("⚪ COMMON / UNCOMMON", Color3.fromRGB(203, 213, 225), "#cbd5e1")

    -- ===== Right Panel: Session & Activity Intelligence (37% width) =====
    local rightPanel = Instance.new("Frame")
    rightPanel.Name = "SessionPanel"
    rightPanel.Size = UDim2.new(0.37, -3, 1, 0)
    rightPanel.BackgroundColor3 = Color3.fromRGB(18, 22, 32)
    rightPanel.BorderSizePixel = 0
    rightPanel.ZIndex = 3
    rightPanel.Parent = mainContent

    local rpCorner = Instance.new("UICorner")
    rpCorner.CornerRadius = UDim.new(0, 6)
    rpCorner.Parent = rightPanel

    local rpStroke = Instance.new("UIStroke")
    rpStroke.Color = Color3.fromRGB(30, 38, 54)
    rpStroke.Thickness = 1
    rpStroke.Parent = rightPanel

    local rpHeader = Instance.new("TextLabel")
    rpHeader.Text = "📊 SESSION STATS & ACTIVITY"
    rpHeader.Font = Enum.Font.GothamBold
    rpHeader.TextSize = 10
    rpHeader.TextColor3 = Color3.fromRGB(203, 213, 225)
    rpHeader.TextXAlignment = Enum.TextXAlignment.Left
    rpHeader.BackgroundTransparency = 1
    rpHeader.ZIndex = 4
    rpHeader.Position = UDim2.new(0, 8, 0, 5)
    rpHeader.Size = UDim2.new(1, -16, 0, 20)
    rpHeader.Parent = rightPanel

    local rpContainer = Instance.new("Frame")
    rpContainer.Size = UDim2.new(1, -16, 1, -30)
    rpContainer.Position = UDim2.new(0, 8, 0, 26)
    rpContainer.BackgroundTransparency = 1
    rpContainer.ZIndex = 4
    rpContainer.Parent = rightPanel

    local rpLayout = Instance.new("UIListLayout")
    rpLayout.FillDirection = Enum.FillDirection.Vertical
    rpLayout.Padding = UDim.new(0, 4)
    rpLayout.Parent = rpContainer

    local function createSessionRow(iconAndLabel, defaultVal)
        local f = Instance.new("Frame")
        f.Size = UDim2.new(1, 0, 0, 16)
        f.BackgroundColor3 = Color3.fromRGB(14, 17, 24)
        f.BorderSizePixel = 0
        f.ZIndex = 4
        f.Parent = rpContainer

        local fCorner = Instance.new("UICorner")
        fCorner.CornerRadius = UDim.new(0, 4)
        fCorner.Parent = f

        local lbl = Instance.new("TextLabel")
        lbl.Text = iconAndLabel
        lbl.Font = Enum.Font.Gotham
        lbl.TextSize = 9
        lbl.TextColor3 = Color3.fromRGB(148, 163, 184)
        lbl.TextXAlignment = Enum.TextXAlignment.Left
        lbl.BackgroundTransparency = 1
        lbl.ZIndex = 5
        lbl.Position = UDim2.new(0, 6, 0, 0)
        lbl.Size = UDim2.new(0.55, -6, 1, 0)
        lbl.Parent = f

        local val = Instance.new("TextLabel")
        val.Text = defaultVal
        val.Font = Enum.Font.GothamBold
        val.TextSize = 9
        val.TextColor3 = Color3.fromRGB(241, 245, 249)
        val.TextXAlignment = Enum.TextXAlignment.Right
        val.TextTruncate = Enum.TextTruncate.AtEnd
        val.BackgroundTransparency = 1
        val.ZIndex = 5
        val.Position = UDim2.new(0.55, 0, 0, 0)
        val.Size = UDim2.new(0.45, -6, 1, 0)
        val.Parent = f

        return val
    end

    local sessUptimeVal = createSessionRow("⏱️ Farming Uptime", "00:00:00")
    local sessHopsVal = createSessionRow("🔄 Servers Visited", "0 hops")
    local sessFoundVal = createSessionRow("🍎 Found This Session", "+0 fruits")
    local sessRollsVal = createSessionRow("🎲 Gacha Rolls", "0 rolls")
    local sessBeliDiffVal = createSessionRow("💵 Session Beli Gain", "$0")
    local sessLastFruitVal = createSessionRow("🎯 Last Fruit Found", "None")

    -- ---------- Data Update Logic ----------
    updateDashboardUI = function()
        pcall(function()
            if not gui or not gui.Parent then return end

            -- Always verify scale on update
            updateScale()

            local curBeli, curLevel = getPlayerData()
            curBeli = tonumber(curBeli) or 0
            curLevel = tonumber(curLevel) or 1

            -- 1. Header
            userTitle.Text = string.format("·  Lv. %s  ·  %s  ·  %s",
                tostring(curLevel),
                getSeaName(),
                tostring((LP and LP.Team and LP.Team.Name) or Cfg.Team or "Marines"))

            local st = tostring(Session.status_state or "normal")
            if st == "storage_full" then
                statusBadge.Text = "● Full"
                statusBadge.BackgroundColor3 = Color3.fromRGB(249, 115, 22)
            elseif st == "gacha_ready" then
                statusBadge.Text = "● Gacha"
                statusBadge.BackgroundColor3 = Color3.fromRGB(245, 158, 11)
            elseif st == "error" then
                statusBadge.Text = "● Error"
                statusBadge.BackgroundColor3 = Color3.fromRGB(239, 68, 68)
            else
                statusBadge.Text = "● Online"
                statusBadge.BackgroundColor3 = Color3.fromRGB(16, 185, 129)
            end

            -- 2. Beli Card
            beliVal.Text = "$" .. formatBeli(curBeli)
            local initB = tonumber(Session.initial_beli) or curBeli
            local bDiff = curBeli - initB
            if bDiff > 0 then
                beliSub.Text = "+$" .. formatBeli(bDiff) .. " session"
                beliSub.TextColor3 = Color3.fromRGB(34, 197, 94)
                sessBeliDiffVal.Text = "+$" .. formatBeli(bDiff)
                sessBeliDiffVal.TextColor3 = Color3.fromRGB(34, 197, 94)
            elseif bDiff < 0 then
                beliSub.Text = "-$" .. formatBeli(math.abs(bDiff)) .. " session"
                beliSub.TextColor3 = Color3.fromRGB(239, 68, 68)
                sessBeliDiffVal.Text = "-$" .. formatBeli(math.abs(bDiff))
                sessBeliDiffVal.TextColor3 = Color3.fromRGB(239, 68, 68)
            else
                beliSub.Text = "No change"
                beliSub.TextColor3 = Color3.fromRGB(120, 136, 160)
                sessBeliDiffVal.Text = "$0"
                sessBeliDiffVal.TextColor3 = Color3.fromRGB(148, 163, 184)
            end

            -- 3. Gacha Card
            local now = os.time()
            local cdEnd = tonumber(Session.gacha_cooldown_end) or 0

            -- [TEMPORARY: MAGNET EVENT UI ADAPTER - ELIMINAR EN 15 DÍAS]
            local magTokens = (Cfg.MagnetGacha and MagnetEvent and MagnetEvent.getTokenBalance and MagnetEvent.getTokenBalance()) or 0
            local magReady = (Cfg.MagnetGacha and MagnetEvent and MagnetEvent.canRoll and MagnetEvent.canRoll())
            -- [END TEMPORARY: MAGNET EVENT UI ADAPTER]

            if AutoQuestFarm and AutoQuestFarm.needsFarming and AutoQuestFarm.needsFarming() then
                local cost = (Session.gacha_cost and Session.gacha_cost > 0 and Session.gacha_cost) or (AutoQuestFarm.getGachaPrice and AutoQuestFarm.getGachaPrice()) or 0
                if curLevel < 50 then
                    gachaVal.Text = string.format("⚔️ LVL %d/50", curLevel)
                    gachaVal.TextColor3 = Color3.fromRGB(251, 191, 36)
                    gachaSub.Text = "AutoQuest Farming Lvl"
                else
                    gachaVal.Text = string.format("⚔️ $%s / $%s", formatBeli(curBeli), formatBeli(cost))
                    gachaVal.TextColor3 = Color3.fromRGB(251, 191, 36)
                    if cdEnd > now then
                        gachaSub.Text = string.format("Farm Beli · CD: %s", formatCountdown(cdEnd - now))
                    else
                        gachaSub.Text = string.format("AutoQuest Farm (Done: %d)", Session.quest_completed or 0)
                    end
                end
            elseif magReady then
                gachaVal.Text = "⚡ MAGNET READY"
                gachaVal.TextColor3 = Color3.fromRGB(168, 85, 247)
                gachaSub.Text = string.format("Magnet Gacha (%d Tokens)", magTokens)
            elseif cdEnd > now then
                local rem = cdEnd - now
                gachaVal.Text = "⏳ " .. formatCountdown(rem)
                gachaVal.TextColor3 = Color3.fromRGB(245, 158, 11)
                if Cfg.MagnetGacha then
                    gachaSub.Text = string.format("Tokens: %d/500 · Zioles CD", magTokens)
                else
                    gachaSub.Text = tostring(Cfg.RollBox or "ZiolesGacha")
                end
            elseif Session.gacha_no_beli then
                gachaVal.Text = "Out of Beli"
                gachaVal.TextColor3 = Color3.fromRGB(239, 68, 68)
                if Cfg.MagnetGacha then
                    gachaSub.Text = string.format("Tokens: %d/500 · Zioles", magTokens)
                else
                    gachaSub.Text = tostring(Cfg.RollBox or "ZiolesGacha")
                end
            else
                gachaVal.Text = "🟢 AVAILABLE"
                gachaVal.TextColor3 = Color3.fromRGB(34, 197, 94)
                if Cfg.MagnetGacha then
                    gachaSub.Text = string.format("Zioles (Magnet: %d/500)", magTokens)
                else
                    local gCost = tonumber(Session.gacha_cost) or 0
                    if gCost > 0 then
                        gachaSub.Text = "Cost: $" .. formatBeli(gCost)
                    else
                        gachaSub.Text = tostring(Cfg.RollBox or "ZiolesGacha")
                    end
                end
            end

            -- 4. Fruit Card
            local counts = { Mythical = {}, Legendary = {}, Rare = {}, Common = {} }
            local totalFruits = 0
            if type(Cfg.StoredFruits) == "table" then
                for fruitKey, storedVal in pairs(Cfg.StoredFruits) do
                    local qty = (type(storedVal) == "number" and storedVal) or 1
                    local fInfo = getFruitInfo(fruitKey)
                    local r = (fInfo and fInfo.rarity) or "Common"
                    local cat = "Common"
                    if r == "Mythical" then cat = "Mythical"
                    elseif r == "Legendary" then cat = "Legendary"
                    elseif r == "Rare" then cat = "Rare"
                    end
                    local cName = (fInfo and fInfo.name and fInfo.name ~= "" and fInfo.name) or tostring(fruitKey)
                    counts[cat][cName] = (counts[cat][cName] or 0) + qty
                    totalFruits = totalFruits + qty
                end
            end

            local maxCap = getMaxFruitCap()
            fruitVal.Text = tostring(totalFruits) .. " stored"
            local fs = tonumber(Session.fruits_stored) or 0
            if fs > 0 then
                fruitSub.Text = "+" .. tostring(fs) .. " this session"
                fruitSub.TextColor3 = Color3.fromRGB(56, 189, 248)
                sessFoundVal.Text = "+" .. tostring(fs) .. " fruits"
                sessFoundVal.TextColor3 = Color3.fromRGB(56, 189, 248)
            else
                fruitSub.Text = tostring(Session.gacha_rolls or 0) .. " rolls done"
                fruitSub.TextColor3 = Color3.fromRGB(120, 136, 160)
                sessFoundVal.Text = "+0 fruits"
                sessFoundVal.TextColor3 = Color3.fromRGB(148, 163, 184)
            end

            -- 5. Server & Session Card + Activity Meta
            local sHops = tonumber(Session.server_hops) or 1
            serverVal.Text = "Hop #" .. tostring(sHops)
            local sStart = tonumber(Session.session_start) or os.time()
            local uptime = formatDuration(os.time() - sStart)
            serverSub.Text = uptime .. " · " .. string.sub(tostring(game.JobId or "local"), 1, 8)
            actMeta.Text = string.format("Server #%s  ·  Job: %s", tostring(sHops), string.sub(tostring(game.JobId or "local"), 1, 8))

            -- Update right session panel
            sessUptimeVal.Text = uptime
            sessHopsVal.Text = tostring(sHops) .. " hops"
            sessRollsVal.Text = tostring(Session.gacha_rolls or 0) .. " rolls"

            -- 6. Fruit Storage Update
            if Session.recent_fruits and #Session.recent_fruits > 0 then
                local lf = Session.recent_fruits[#Session.recent_fruits]
                local lfName = tostring(lf.name or "Fruit"):gsub("%s*%b()", ""):gsub("^%s+", ""):gsub("%s+$", "")
                local lfSrc = tostring(lf.source or ""):gsub("%s*%b()", ""):gsub("^%s+", ""):gsub("%s+$", "")
                if lfSrc:lower() == "suelo" then
                    lfSrc = "Ground"
                end
                invLatest.Text = "Latest: " .. lfName
                sessLastFruitVal.Text = lfName .. (lfSrc ~= "" and (" · " .. lfSrc) or "")
                sessLastFruitVal.TextColor3 = Color3.fromRGB(56, 189, 248)
            else
                invLatest.Text = ""
                sessLastFruitVal.Text = "None"
                sessLastFruitVal.TextColor3 = Color3.fromRGB(148, 163, 184)
            end

            invHeader.Text = string.format("📦 FRUIT STORAGE (%d stored · Cap: %d/fruit)", totalFruits, maxCap)

            local function formatCategoryList(catMap)
                local names = {}
                local catTotal = 0
                for name, qty in pairs(catMap) do
                    if name and name ~= "" then
                        catTotal = catTotal + (qty or 1)
                        local qtyStr = (qty > 1) and string.format(" <font color=\"#38bdf8\"><b>(%d)</b></font>", qty) or ""
                        names[#names + 1] = string.format("<b>%s</b>%s", tostring(name), qtyStr)
                    end
                end
                if #names == 0 then
                    return 0, "<font color=\"#64748b\"><i>None stored</i></font>"
                end
                table.sort(names)
                return catTotal, table.concat(names, ", ")
            end

            local mTotal, mStr = formatCategoryList(counts.Mythical)
            mythBadge.Text = tostring(mTotal)
            mythText.Text = mStr

            local lTotal, lStr = formatCategoryList(counts.Legendary)
            legBadge.Text = tostring(lTotal)
            legText.Text = lStr

            local rTotal, rStr = formatCategoryList(counts.Rare)
            rareBadge.Text = tostring(rTotal)
            rareText.Text = rStr

            local cTotal, cStr = formatCategoryList(counts.Common)
            comBadge.Text = tostring(cTotal)
            comText.Text = cStr
        end)
    end

    onStatusCallback = function(msg)
        if statusText and statusText.Parent then
            statusText.Text = tostring(msg or "")
        end
    end

    updateDashboardUI()

    -- 1-second background loop for timers & uptime
    task.spawn(function()
        while gui and gui.Parent do
            task.wait(1)
            pcall(updateDashboardUI)
        end
    end)

    setStatus("FruitsHub loaded. Player: " .. tostring(LP and LP.Name or "Player") .. " | Team: " .. tostring(LP and LP.Team and LP.Team.Name or Cfg.Team))
end

-- ===================== Startup =====================
task.spawn(function()
    local t = 0
    while (not game:IsLoaded() or not LP) and t < 30 do
        task.wait(0.5)
        t = t + 0.5
    end

    local okUi, errUi = pcall(buildStatusUI)
    if not okUi then
        warn("[FruitsHub] Error in buildStatusUI: " .. tostring(errUi))
    end

    mainLoopHost()
end)
