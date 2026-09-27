local filter = dofile(arg[1])
local context = { options = {} }
function context:get_option(name)
    return self.options[name] or false
end
function context:set_option(name, value)
    self.options[name] = value
end
local env = { engine = { context = context } }

local function candidate(text, genuines)
    return {
        text = text,
        get_genuines = function() return genuines end,
    }
end
local function genuine(type_name, dynamic_type)
    return { type = type_name, get_dynamic_type = function() return dynamic_type end }
end
local custom = candidate("仮名", { genuine("user_phrase", "Phrase") })
local kanji = candidate("佳奈", { genuine("kagiroi", "Phrase") })
local katakana = candidate("カナ", { genuine("kagiroi", "Simple") })
local duplicate = candidate("カナ", { genuine("user_phrase", "Phrase"), genuine("kagiroi", "Simple") })

local function translation(candidates)
    local index = 0
    return {
        iter = function()
            return function()
                index = index + 1
                return candidates[index]
            end
        end,
    }
end

local function filter_candidates(candidates)
    local output = {}
    _G.yield = function(item) output[#output + 1] = item end
    filter.func(translation(candidates), env)
    return output
end

local normal = filter_candidates({ custom, kanji, katakana })
assert(normal[1] == custom and normal[2] == kanji and normal[3] == katakana,
    "without Henkan the merged menu order must remain unchanged")
context:set_option("_rime_henkan", true)
local promoted = filter_candidates({ custom, kanji, katakana })
assert(promoted[1].text == "カナ" and promoted[2] == custom and promoted[3] == kanji,
    "Henkan must put full-width katakana ahead of the custom phrase")
local uniquified = filter_candidates({ custom, duplicate, kanji })
assert(uniquified[1] == duplicate and uniquified[2] == custom and uniquified[3] == kanji,
    "Henkan must find katakana inside a merged duplicate candidate")
local missing = filter_candidates({ custom, kanji })
assert(missing[1] == custom and missing[2] == kanji,
    "a menu without katakana must keep all original candidates")
context:set_option("_rime_henkan", false)
local restored = filter_candidates({ custom, kanji, katakana })
assert(restored[1] == custom and restored[2] == kanji and restored[3] == katakana,
    "the next input must restore the original candidate order")

print("Rime Henkan filter tests passed")
