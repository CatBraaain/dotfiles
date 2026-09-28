local kAccepted = 1
local kNoop = 2
local calls = 0
local conversions_resolved = 0
package.preload["kagiroi/kagiroi_n_kana_speller"] = function()
    return {
        init = function(env)
            env.alphabet = "abcdefghijklmnopqrstuvwxyz-;"
        end,
        fini = function() end,
        func = function()
            calls = calls + 1
            return kNoop
        end,
        resolve_conversion = function()
            conversions_resolved = conversions_resolved + 1
        end,
    }
end

-- Hiragana to katakana by shifting every kana codepoint into the katakana
-- block, mirroring the kagiroi_h2k Opencc conversion used by the processor.
local function to_katakana(text)
    return (text:gsub("[%z\1-\127\194-\244][\128-\191]*", function(character)
        local codepoint = utf8.codepoint(character)
        if codepoint >= 0x3041 and codepoint <= 0x3096 then
            return utf8.char(codepoint + 0x60)
        end
        return character
    end))
end
_G.Opencc = function()
    return { convert = function(_, text) return to_katakana(text) end }
end

local processor = dofile(arg[1])

local function new_environment(candidates)
    local segment = { selected_index = 0, menu = { candidates = candidates or { "かな", "仮名", "カナ" } } }
    function segment.menu:candidate_count()
        return math.min(#self.candidates, 2)
    end
    function segment:get_candidate_at(index)
        return self.menu.candidates[index + 1]
    end
    local context = { input = "", options = {}, commits = {} }
    context.composition = { back = function() return segment end }
    -- Mirrors the gate filter: while _kagiroi_hide_candidates is on the menu
    -- is empty, and a commit then falls back to the raw input.
    function context:has_menu()
        return self.input ~= "" and not self.options._kagiroi_hide_candidates
            and #segment.menu.candidates > 0
    end
    function context:get_option(name)
        return self.options[name] or false
    end
    function context:set_option(name, value)
        self.options[name] = value
    end
    function context:highlight(index)
        if segment:get_candidate_at(index) then
            segment.selected_index = index
        end
    end
    function context:push_input(text)
        self.input = self.input .. text
    end
    function context:commit()
        local text
        if self:has_menu() then
            text = segment:get_candidate_at(segment.selected_index)
        else
            text = self.input
        end
        table.insert(self.commits, text)
        rawset(self, "input", "")
    end
    setmetatable(context, {
        __newindex = function(table, key, value)
            rawset(table, key, value)
            if key == "input" then
                rawset(table, "caret_pos", #value)
            end
        end,
    })
    local env = { engine = { context = context } }
    processor.init(env)
    return env, context, segment
end

local function press(env, keycode, modifiers)
    modifiers = modifiers or {}
    return processor.func({
        keycode = keycode,
        release = function() return modifiers.release or false end,
        ctrl = function() return modifiers.ctrl or false end,
        alt = function() return modifiers.alt or false end,
        super = function() return modifiers.super or false end,
        shift = function() return modifiers.shift or false end,
    }, env)
end

-- Typing hides the candidate list until Space reveals it, and Space cycles.
local env, context, segment = new_environment()
press(env, string.byte("k"))
assert(context:get_option("_kagiroi_hide_candidates"), "typing must hide candidates")
context.input = "か"
local first_space = press(env, 0x20)
assert(first_space == kAccepted, "first Space must be consumed")
assert(not context:get_option("_kagiroi_hide_candidates"), "first Space must reveal candidates")
assert(segment.selected_index == 0, "first Space must select the first candidate")
local before_selection = calls
press(env, 0x20)
assert(segment.selected_index == 1, "second Space must highlight the next candidate")
assert(#context.commits == 0 and context.input == "か", "Space must leave composition uncommitted")
press(env, 0x20)
assert(segment.selected_index == 2, "Space must reach candidates beyond the prepared page")
press(env, 0x20)
assert(segment.selected_index == 0, "Space must wrap from the final candidate to the first")
press(env, 0x20)
assert(segment.selected_index == 1, "Space must advance after wrapping")
assert(calls == before_selection, "candidate cycling must bypass the kana speller")
local enter = press(env, 0xff0d)
assert(enter == kAccepted, "Enter must not reach the raw-script editor binding")
assert(context.commits[1] == "仮名", "Enter must commit the highlighted candidate")
assert(context.input == "", "Enter must end composition")
press(env, string.byte("k"))
assert(context:get_option("_kagiroi_hide_candidates"), "the next input must start with candidates hidden")

-- The same Space cycle without the highlight API (Windows rime.dll).
env, context, segment = new_environment()
context.highlight = nil
press(env, string.byte("k"))
context.input = "か"
assert(press(env, 0x20) == kAccepted, "first Space must be consumed without the highlight API")
assert(segment.selected_index == 0, "the default first candidate must stay selected")
press(env, 0x20)
assert(segment.selected_index == 1, "subsequent Space must move the selection via selected_index")
press(env, 0x20)
assert(segment.selected_index == 2, "Space must reach the last candidate via selected_index")
press(env, 0x20)
assert(segment.selected_index == 0, "Space must wrap to the first candidate via selected_index")
press(env, 0x20)
assert(segment.selected_index == 1, "Space must advance again after wrapping via selected_index")
local windows_enter = press(env, 0xff0d)
assert(windows_enter == kAccepted, "Enter must be consumed without the highlight API")
assert(context.commits[1] == "仮名", "Enter must commit the candidate selected via selected_index")

-- A single candidate stays highlighted without committing.
env, context, segment = new_environment({ "かな" })
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 0 and #context.commits == 0, "a single candidate must stay highlighted without committing")

-- Enter outside a composition passes through to the speller chain.
local before_empty_enter = calls
env, context = new_environment()
assert(press(env, 0xff0d) == kNoop, "Enter outside composition must pass through")
assert(calls == before_empty_enter + 1, "Enter without a menu must reach the kana speller")

-- Enter before the first Space keeps the standard binding.
env, context = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff0d) == kNoop, "Enter before Space must retain the standard binding")
assert(#context.commits == 0, "Enter before Space must not use candidate commit")

-- Space without a candidate menu reaches the standard processors.
env, context = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
function context:has_menu() return false end
assert(press(env, 0x20) == kNoop, "Space without candidates must reach standard processors")
assert(context:get_option("_kagiroi_hide_candidates"), "Space without candidates must not reveal a menu")

-- Space on a candidate-less input stays hidden for later keys.
env, context, segment = new_environment({})
context.input = "k"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kNoop, "Space on a candidate-less input must reach standard processors")
assert(context:get_option("_kagiroi_hide_candidates"), "a candidate-less input must stay hidden for later Spaces")

-- Henkan: unconfirmed, first candidate as katakana, list stays hidden.
env, context, segment = new_environment()
context.input = "かな"
local before_henkan = calls
local henkan = press(env, 0xff23)
assert(henkan == kAccepted, "Henkan must be consumed without committing")
assert(calls == before_henkan, "Henkan must bypass the kana speller func")
assert(conversions_resolved > 0, "Henkan must resolve the conversion reading")
assert(context.input == "カナ", "Henkan must rewrite the input to katakana")
assert(context:get_option("katakana"), "Henkan must enable the katakana option")
assert(context:get_option("_kagiroi_hide_candidates"), "Henkan must keep the candidate list hidden")
assert(#context.commits == 0, "Henkan must not commit")
assert(env.henkan_reading == "かな", "Henkan must remember the hiragana reading")

-- Repeated Henkan stays idempotent.
press(env, 0xff23)
assert(context.input == "カナ" and env.henkan_reading == "かな", "repeated Henkan must stay idempotent")

-- Esc after Henkan restores the hiragana reading with the list hidden.
local esc = press(env, 0xff1b)
assert(esc == kAccepted, "Esc after Henkan must be consumed")
assert(context.input == "かな", "Esc after Henkan must restore the hiragana reading")
assert(not context:get_option("katakana"), "Esc after Henkan must restore the kana mode")
assert(context:get_option("_kagiroi_hide_candidates"), "Esc after Henkan must keep the list hidden")
assert(#context.commits == 0, "Esc after Henkan must not commit")

-- Backspace after Henkan behaves like Esc.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
local backspace = press(env, 0xff08)
assert(backspace == kAccepted, "Backspace after Henkan must be consumed")
assert(context.input == "かな", "Backspace after Henkan must restore the hiragana reading")
assert(context:get_option("_kagiroi_hide_candidates"), "Backspace after Henkan must keep the list hidden")
assert(#context.commits == 0, "Backspace after Henkan must not commit")

-- Enter after Henkan commits the katakana first candidate.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
local henkan_enter = press(env, 0xff0d)
assert(henkan_enter == kAccepted, "Enter after Henkan must be consumed")
assert(context.commits[1] == "カナ", "Enter after Henkan must commit the katakana input")
assert(context.input == "", "Enter after Henkan must end composition")
assert(not context:get_option("katakana"), "Enter after Henkan must restore the kana mode")
assert(env.henkan_reading == nil, "Enter after Henkan must end the Henkan state")

-- Henkan then Space reveals the menu with the katakana first candidate.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
press(env, 0x20)
assert(not context:get_option("_kagiroi_hide_candidates"), "Space after Henkan must reveal candidates")
assert(context:has_menu(), "Space after Henkan must build a menu")
assert(segment.selected_index == 0, "Space after Henkan must select the first candidate")
local henkan_space_enter = press(env, 0xff0d)
assert(henkan_space_enter == kAccepted, "Enter after Henkan and Space must be consumed")
assert(context.commits[1] == "かな", "Enter must commit the highlighted candidate after Henkan")
assert(not context:get_option("katakana"), "the commit must restore the kana mode")

-- Henkan with half-width katakana enabled restores the prior mode.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("hw_katakana", true)
press(env, 0xff23)
assert(context:get_option("katakana") and not context:get_option("hw_katakana"),
    "Henkan must use full-width katakana")
context.input = ""
press(env, string.byte("k"))
assert(context:get_option("hw_katakana") and not context:get_option("katakana"),
    "the next input must restore the prior kana mode")

-- Backspace with the menu visible returns to the reading without deleting.
env, context, segment = new_environment()
context.input = "かんな"
press(env, 0x20)
local revert = press(env, 0xff08)
assert(revert == kAccepted, "Backspace with the menu visible must be consumed")
assert(context.input == "かんな", "Backspace must not delete a character while converting")
assert(context:get_option("_kagiroi_hide_candidates"), "Backspace must hide the list")
assert(#context.commits == 0, "Backspace must not commit")
-- While typing, Backspace keeps the stock delete-previous-character.
local typing_backspace = press(env, 0xff08)
assert(typing_backspace == kNoop, "Backspace while typing must reach standard processors")

-- Esc keeps the hiragana reading, both while typing and while converting.
env, context, segment = new_environment()
context.input = "かな"
local typing_esc = press(env, 0xff1b)
assert(typing_esc == kAccepted, "Esc while typing must be consumed")
assert(context.input == "かな", "Esc must keep the reading while typing")
assert(#context.commits == 0, "Esc must not commit while typing")
press(env, 0x20)
local converting_esc = press(env, 0xff1b)
assert(converting_esc == kAccepted, "Esc while converting must be consumed")
assert(context.input == "かな", "Esc must keep the reading while converting")
assert(context:get_option("_kagiroi_hide_candidates"), "Esc must hide the list")
assert(#context.commits == 0, "Esc must not commit while converting")

-- A letter key with the menu visible commits the selection and restarts.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local before_restart = calls
local typing_key = press(env, string.byte("k"))
assert(typing_key == kNoop, "the restarted key must reach the speller chain")
assert(context.commits[1] == "かな", "a typing key must commit the selected candidate")
assert(context:get_option("_kagiroi_hide_candidates"), "the next input must start hidden")
assert(calls == before_restart + 1, "the restarted key must be processed by the kana speller")

-- Henkan followed by a letter or digit commits katakana and starts a new input.
for _, key in ipairs({ "k", "1" }) do
    env, context = new_environment()
    context.input = "かな"
    press(env, 0xff23)
    local before_henkan_key = calls
    local result = press(env, string.byte(key))
    assert(context.commits[1] == "カナ", "Henkan then " .. key .. " must commit katakana")
    assert(not context:get_option("katakana") and env.henkan_reading == nil,
        "Henkan then " .. key .. " must restore the original mode")
    assert(context:get_option("_kagiroi_hide_candidates"),
        "Henkan then " .. key .. " must hide candidates for the next input")
    if key == "1" then
        assert(result == kAccepted and context.input == "1",
            "Henkan then digit must start the next reading")
        assert(calls == before_henkan_key, "the inserted digit must bypass the speller")
    else
        assert(result == kNoop and context.input == "",
            "Henkan then letter must pass the key to standard input")
        assert(calls == before_henkan_key + 1, "the letter must reach the speller")
    end
end

-- A digit key commits the highlighted candidate instead of selecting by number.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "cycling must select the second candidate")
local digit = press(env, string.byte("1"))
assert(digit == kAccepted, "a digit must start the next input without selecting by number")
assert(context.commits[1] == "仮名", "a digit must commit the highlighted candidate, not candidate one")
assert(digit == kAccepted and context.input == "1", "a digit must start the next reading")
assert(context:get_option("_kagiroi_hide_candidates"), "the digit must keep the next menu hidden")

-- Ascii mode and modifier combinations pass through.
env, context, segment = new_environment()
context:set_option("ascii_mode", true)
context.input = "かな"
assert(press(env, 0xff23) == kNoop, "Henkan in ascii mode must pass through")
assert(press(env, 0x20) == kNoop, "Space in ascii mode must pass through")
assert(press(env, 0xff0d) == kNoop, "Enter in ascii mode must pass through")
assert(press(env, 0xff1b) == kNoop, "Esc in ascii mode must pass through")
assert(press(env, 0x20, { ctrl = true }) == kNoop, "modified Space must pass through")
assert(press(env, 0xff23, { shift = true }) == kNoop, "modified Henkan must pass through")
assert(#context.commits == 0 and context.input == "かな", "ascii mode must leave the composition alone")

print("Rime candidate visibility, Henkan and revert tests passed")
