--[[
    FruitsHub — Universal Execution Loader
    Gateway: https://fruitshub.onrender.com
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

local Gateway = getgenv().FruitsHubGateway or "https://fruitshub.onrender.com"
local Key = tostring(getgenv().Key or getgenv().FruitsHubKey or ""):gsub("%s+", "")
local HWID = getClientHWID()
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

local requestUrl = string.format(
    "%s/load?key=%s&hwid=%s&cv=%s",
    Gateway,
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

-- Check if server validated key and confirmed cached version is active (Smart Cache Hit: 19 bytes)
if scriptContent:find("%-%-%[%[FH_CACHE_VALID%]%]") and localCached then
    local okRead, cachedCode = pcall(readfile, CachePath)
    if okRead and cachedCode and cachedCode ~= "" then
        return loadstring(cachedCode)()
    end
end

-- If response is an error/kick response, run it immediately to show message and copy URL
if scriptContent:find("FruitsHub:") and scriptContent:find("p:Kick") then
    return loadstring(scriptContent)()
end

-- Full script update: persist in local executor cache for subsequent hops
if hasFs then
    pcall(function()
        if makefolder and not isfolder("FruitsHub") then
            makefolder("FruitsHub")
        end
        writefile(CachePath, scriptContent)
        local verMatch = scriptContent:match("%-%-%[%[FH_VERSION:([%w%.]+)%]%]") or "v1.1.0"
        writefile(VerPath, verMatch)
    end)
end

loadstring(scriptContent)()
