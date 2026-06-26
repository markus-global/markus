--[[
    quota.lua — Atomic CU (Compute Unit) Quota Deduction

    This script performs an atomic quota check and deduction on a Redis Hash.
    It uses HINCRBY to increment usage, checks against the limit, and
    automatically rolls back if the quota would be exceeded.

    Data Model:
        Key:   "cu:{userId}"        (Redis Hash)
        Fields:
          - usage    (integer): Cumulative CU consumed
          - limit    (integer): Maximum CU allowed per cycle
          - reset_at (integer): Unix timestamp when the quota resets

    Input:
        KEYS[1]: Redis key (e.g., "cu:user_abc123")
        ARGV[1]: Amount of CU to deduct (integer)
        ARGV[2]: CU limit to set if the key does not yet exist (integer)
        ARGV[3]: Reset timestamp (integer) — set on first init

    Output:
        A JSON object:
          {
            "remaining": <number>,  -- Remaining CU (-1 if quota exceeded)
            "usage": <number>,      -- Total CU used (after deduction, or before rollback)
            "limit": <number>       -- CU quota limit
          }

        When remaining === -1, the deduction was already rolled back, and
        "usage" reflects the usage before the attempted deduction.

    Idempotency:
        The script is idempotent for the same arguments only if called once.
        It does NOT gate by idempotency key — that should be handled at a
        higher layer (e.g., a request idempotency key stored separately).

    Error States:
        - Non-numeric ARGV: Redis HINCRBY returns an error automatically.
        - Missing limit: defaults to ARGV[2] (set on first init).
--]]

local key = KEYS[1]
local deduct = tonumber(ARGV[1])
local default_limit = tonumber(ARGV[2])
local reset_ts = tonumber(ARGV[3])

-- Validate inputs
if not deduct or deduct <= 0 then
    return cjson.encode({ error = "invalid_deduct_amount", remaining = 0, usage = 0, limit = 0 })
end

if not default_limit or default_limit <= 0 then
    return cjson.encode({ error = "invalid_limit", remaining = 0, usage = 0, limit = 0 })
end

-- Initialize key if it doesn't exist
local exists = redis.call("EXISTS", key)
if exists == 0 then
    redis.call("HSET", key, "usage", 0, "limit", default_limit, "reset_at", reset_ts)
end

-- Get current limit from stored value (may differ from default if set externally)
local stored_limit = redis.call("HGET", key, "limit")
local limit
if stored_limit then
    limit = tonumber(stored_limit)
else
    limit = default_limit
end

-- Atomically deduct CU
local new_usage = redis.call("HINCRBY", key, "usage", deduct)

-- Check if quota exceeded
if new_usage > limit then
    -- Rollback the deduction
    redis.call("HINCRBY", key, "usage", -deduct)
    return cjson.encode({
        remaining = -1,
        usage = new_usage - deduct,
        limit = limit
    })
end

-- Success: return remaining quota
local remaining = limit - new_usage
return cjson.encode({
    remaining = remaining,
    usage = new_usage,
    limit = limit
})
