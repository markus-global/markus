/**
 * quota-lua.ts — Embedded Lua script string for atomic CU deduction.
 *
 * The actual Lua source lives in `quota.lua`. This module re-export it
 * as a TypeScript string constant so it can be loaded into the Worker
 * bundle (Cloudflare Workers bundle .ts files, not .lua files).
 *
 * Data Model (Redis Hash):
 *   Key:   "cu:{userId}"
 *   Fields:
 *     - usage    (integer): Cumulative CU consumed
 *     - limit    (integer): Maximum CU allowed per cycle
 *     - reset_at (integer): Unix timestamp when the quota resets
 *
 * KEYS[1]: Redis key (e.g., "cu:user_abc123")
 * ARGV[1]: Amount of CU to deduct (integer)
 * ARGV[2]: CU limit to set if the key does not yet exist (integer)
 * ARGV[3]: Reset timestamp (integer) — set on first init
 *
 * Returns JSON: { remaining: number, usage: number, limit: number }
 *   - remaining === -1 means quota exceeded (deduction rolled back)
 */

export const QUOTA_DEDUCTION_SCRIPT = `
local key = KEYS[1]
local deduct = tonumber(ARGV[1])
local default_limit = tonumber(ARGV[2])
local reset_ts = tonumber(ARGV[3])

if not deduct or deduct <= 0 then
    return cjson.encode({ error = "invalid_deduct_amount", remaining = 0, usage = 0, limit = 0 })
end

if not default_limit or default_limit <= 0 then
    return cjson.encode({ error = "invalid_limit", remaining = 0, usage = 0, limit = 0 })
end

local exists = redis.call("EXISTS", key)
if exists == 0 then
    redis.call("HSET", key, "usage", 0, "limit", default_limit, "reset_at", reset_ts)
end

local stored_limit = redis.call("HGET", key, "limit")
local limit
if stored_limit then
    limit = tonumber(stored_limit)
else
    limit = default_limit
end

local new_usage = redis.call("HINCRBY", key, "usage", deduct)

if new_usage > limit then
    redis.call("HINCRBY", key, "usage", -deduct)
    return cjson.encode({
        remaining = -1,
        usage = new_usage - deduct,
        limit = limit
    })
end

local remaining = limit - new_usage
return cjson.encode({
    remaining = remaining,
    usage = new_usage,
    limit = limit
})
`.trim();
