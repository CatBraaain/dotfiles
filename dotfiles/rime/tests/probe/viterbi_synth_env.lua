-- Shared synthetic environment for the contextual bunsetsu probes. Builds the
-- mem/matrix objects the upstream kagiroi_viterbi expects, from plain Lua
-- tables, so the probes run the real upstream viterbi unmodified under lua5.4.
--
-- Dictionary rows: { surface, candidate, left_id, right_id, cost }
-- Userdict rows:   { surface, candidate, left_id, right_id, commit_count }
--                  (left_id nil models the id-less learned entries)
-- Matrix:          map["rid lid"] = cost (missing key = math.huge)

local M = {}

local function dict_entry_text(row)
    return row.candidate .. "|" .. row.left_id .. " " .. row.right_id
end

function M.new_env(dictionary, userdict, matrix)
    userdict = userdict or {}
    local mem = {}
    local dict_entries, dict_index
    local user_entries, user_index

    function mem:dict_lookup(input, _, _)
        dict_entries, dict_index = {}, 0
        for _, row in ipairs(dictionary) do
            if row.surface == input then
                dict_entries[#dict_entries + 1] = {
                    text = dict_entry_text(row),
                    weight = math.log(row.cost / 1e8),
                }
            end
        end
    end

    function mem:iter_dict()
        return function()
            dict_index = dict_index + 1
            return dict_entries[dict_index]
        end, self
    end

    function mem:user_lookup(code, _)
        local surface = code:gsub(" \t$", "")
        user_entries, user_index = {}, 0
        for _, row in ipairs(userdict) do
            if row.surface == surface then
                user_entries[#user_entries + 1] = {
                    text = row.left_id and dict_entry_text(row) or row.candidate,
                    custom_code = surface .. " ",
                    commit_count = row.commit_count or 1,
                }
            end
        end
    end

    function mem:iter_user()
        return function()
            user_index = user_index + 1
            return user_entries[user_index]
        end, self
    end

    local reverse_lookup = {}
    function reverse_lookup:lookup(key)
        local cost = matrix[key]
        if cost == nil then return nil end
        return tostring(cost)
    end

    local env = { mem = mem, matrix_lookup = function() return reverse_lookup end }

    function env.matrix_cost(right_id, left_id)
        local cost = matrix[right_id .. " " .. left_id]
        return cost or math.huge
    end

    return env
end

function M.hira2kata(text)
    local out = {}
    for _, codepoint in utf8.codes(text) do
        if codepoint >= 0x3041 and codepoint <= 0x3096 then
            codepoint = codepoint + 0x60
        end
        out[#out + 1] = utf8.char(codepoint)
    end
    return table.concat(out)
end

-- Minimal Opencc/log stand-ins so the upstream module loads outside librime.
function M.install_globals()
    _G.Opencc = function(_)
        return { convert = function(_, text) return M.hira2kata(text) end }
    end
    _G.log = { info = function() end, warning = function() end, error = function() end }
end

return M
