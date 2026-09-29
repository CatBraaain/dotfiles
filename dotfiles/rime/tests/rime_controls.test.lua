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
        func = function(key_event, env)
            calls = calls + 1
            if key_event.keycode == 0xff08 and env.engine.context.input ~= "" then
                local context = env.engine.context
                context.input = context.input:sub(1, utf8.offset(context.input, -1) - 1)
            end
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
        local text = self.menu.candidates[index + 1]
        return text and { text = text } or nil
    end
    function segment:has_tag(tag)
        return tag == "kagiroi"
    end
    local context = { input = "", options = {}, commits = {}, commit_slots = {} }
    context.commit_notifier = {
        connect = function(_, handler)
            table.insert(context.commit_slots, handler)
            return { disconnect = function() end }
        end,
    }
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
    function context:refresh_non_confirmed_composition()
        segment.selected_index = 0
        self.refreshed = true
    end
    function context:push_input(text)
        self.input = self.input .. text
    end
    function context:commit()
        local text
        if self:has_menu() then
            text = segment:get_candidate_at(segment.selected_index).text
        else
            text = self.input
        end
        table.insert(self.commits, text)
        rawset(self, "input", "")
        for _, handler in ipairs(self.commit_slots) do
            handler()
        end
    end
    setmetatable(context, {
        __newindex = function(table, key, value)
            rawset(table, key, value)
            if key == "input" then
                rawset(table, "caret_pos", #value)
            end
        end,
    })
    local engine = { context = context }
    function engine:commit_text(text)
        table.insert(context.commits, text)
    end
    local env = { engine = engine }
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

-- The first Space converts to the first candidate with the list hidden, the
-- second Space reveals the list at the second candidate, later Spaces cycle.
local env, context, segment = new_environment()
press(env, string.byte("k"))
context.input = "か"
local first_space = press(env, 0x20)
assert(first_space == kAccepted, "first Space must be consumed")
assert(context:get_option("_kagiroi_hide_candidates"), "first Space must keep the list hidden")
assert(context.input == "かな", "first Space must convert to the first candidate")
assert(env.conversion and env.conversion.reading == "か", "first Space must remember the reading")
local second_space = press(env, 0x20)
assert(second_space == kAccepted, "second Space must be consumed")
assert(not context:get_option("_kagiroi_hide_candidates"), "second Space must reveal candidates")
assert(context.input == "か", "second Space must restore the reading for the menu")
assert(segment.selected_index == 1, "second Space must highlight the second candidate")
local before_selection = calls
press(env, 0x20)
assert(segment.selected_index == 2, "third Space must reach candidates beyond the prepared page")
press(env, 0x20)
assert(segment.selected_index == 0, "Space must wrap from the final candidate to the first")
press(env, 0x20)
assert(segment.selected_index == 1, "Space must advance after wrapping")
assert(calls == before_selection, "candidate cycling must bypass the kana speller")
assert(#context.commits == 0 and context.input == "か", "Space must leave composition uncommitted")
local enter = press(env, 0xff0d)
assert(enter == kAccepted, "Enter must not reach the raw-script editor binding")
assert(context.commits[1] == "仮名", "Enter must commit the highlighted candidate")
assert(context.input == "", "Enter must end composition")
press(env, string.byte("k"))
assert(context:get_option("_kagiroi_hide_candidates"), "the next input must start with candidates hidden")

-- Tab expands without moving the selection, then the stock selector handles
-- later Tab and Shift+Tab without mutating the schema labels.
local many_candidates = {}
for index = 1, 65 do many_candidates[index] = "candidate " .. index end
env, context, segment = new_environment(many_candidates)
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff09) == kNoop, "Tab while the list is hidden must pass through")
press(env, 0x20)
assert(press(env, 0xff09) == kNoop, "Tab after the first Space must not expand")
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must select candidate two")
assert(press(env, 0xff09) == kAccepted, "the first visible Tab must be consumed")
assert(context:get_option("_kagiroi_expand_candidates") and context.refreshed,
    "the first visible Tab must refresh the expanded translation")
assert(segment.selected_index == 1, "expansion must preserve the selected candidate")
assert(press(env, 0xff09) == kNoop, "later Tab must reach the stock selector")
assert(press(env, 0xff09, { shift = true }) == kNoop,
    "Shift+Tab must reach the stock selector")
context:highlight(32)
assert(segment.selected_index == 32, "selection must reach the next page without changing labels")
context:highlight(0)
assert(segment.selected_index == 0, "selection must return to the first page")
press(env, 0xff08)
assert(not context:get_option("_kagiroi_expand_candidates"), "Backspace must collapse the next list")
press(env, 0x20)
press(env, 0x20)
assert(press(env, 0xff09) == kAccepted, "the next conversion must expand anew")
press(env, string.byte("1"))
assert(not context:get_option("_kagiroi_expand_candidates"), "digit commit must reset expansion")

-- The same Space cycle without the highlight API (Windows rime.dll).
env, context, segment = new_environment()
context.highlight = nil
press(env, string.byte("k"))
context.input = "か"
assert(press(env, 0x20) == kAccepted, "first Space must be consumed without the highlight API")
assert(context.input == "かな", "the conversion must work without the highlight API")
press(env, 0x20)
assert(segment.selected_index == 1, "second Space must move the selection via selected_index")
press(env, 0x20)
assert(segment.selected_index == 2, "Space must reach the last candidate via selected_index")
press(env, 0x20)
assert(segment.selected_index == 0, "Space must wrap to the first candidate via selected_index")
assert(press(env, 0xff09) == kAccepted, "Tab must expand without context.highlight")
assert(segment.selected_index == 0, "Tab must keep selection without context.highlight")
local windows_enter = press(env, 0xff0d)
assert(windows_enter == kAccepted, "Enter must be consumed without the highlight API")
assert(context.commits[1] == "かな", "Enter must commit the candidate selected via selected_index")

-- Arrows cycle within the visible ten until Tab expands the full list.
local long_candidates = {}
for index = 1, 33 do
    long_candidates[index] = "candidate " .. index
end
env, context, segment = new_environment(long_candidates)
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must select the second candidate")
assert(press(env, 0xff52) == kAccepted and segment.selected_index == 0,
    "Up must select the previous candidate")
assert(press(env, 0xff52) == kAccepted and segment.selected_index == 9,
    "Up before expansion must wrap to the tenth candidate")
assert(press(env, 0xff54) == kAccepted and segment.selected_index == 0,
    "Down before expansion must wrap to the first candidate")
for _ = 1, 9 do press(env, 0xff54) end
assert(segment.selected_index == 9, "Down before expansion must reach the tenth candidate")
assert(press(env, 0xff54) == kAccepted and segment.selected_index == 0,
    "Down before expansion must not select a hidden candidate")
press(env, 0xff09)
assert(segment.selected_index == 0, "Tab expansion must keep the arrow selection")
assert(press(env, 0xff52) == kAccepted and segment.selected_index == 32,
    "Up after expansion must wrap to the last page")
assert(press(env, 0xff54) == kAccepted and segment.selected_index == 0,
    "Down after expansion must wrap to the first page")
for _ = 1, 29 do press(env, 0xff54) end
assert(segment.selected_index == 29, "Down must reach the last candidate of a full page")
assert(press(env, 0xff54) == kAccepted and segment.selected_index == 30,
    "Down must cross from the first page to the second")
assert(press(env, 0xff52) == kAccepted and segment.selected_index == 29,
    "Up must cross from the second page to the first")
assert(#context.commits == 0, "arrow navigation must not commit")
assert(press(env, 0xff55) == kNoop and press(env, 0xff56) == kNoop,
    "PageUp and PageDown must reach the stock selector")
assert(press(env, string.byte("y"), { ctrl = true }) == kNoop and
    press(env, string.byte("v"), { ctrl = true }) == kNoop and
    press(env, string.byte("v"), { alt = true }) == kNoop,
    "modified keys must not navigate in the controls processor")
assert(segment.selected_index == 29, "other navigation keys must not change the selection")

-- Arrow selection also works without context.highlight on Windows.
env, context, segment = new_environment(long_candidates)
context.highlight = nil
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
press(env, 0xff52)
press(env, 0xff52)
assert(segment.selected_index == 9, "Up before expansion must wrap without the highlight API")
press(env, 0xff54)
press(env, 0xff09)
press(env, 0xff52)
assert(segment.selected_index == 32, "Up after expansion must wrap without the highlight API")
press(env, 0xff54)
assert(segment.selected_index == 0, "Down must wrap without the highlight API")

-- A single candidate stays highlighted without committing.
env, context, segment = new_environment({ "かな" })
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
press(env, 0xff52)
press(env, 0xff54)
assert(segment.selected_index == 0 and #context.commits == 0, "a single candidate must stay highlighted without committing")

-- Enter outside a composition passes through to the speller chain.
local before_empty_enter = calls
env, context = new_environment()
assert(press(env, 0xff0d) == kNoop, "Enter outside composition must pass through")
assert(calls == before_empty_enter + 1, "Enter without a menu must reach the kana speller")

-- Enter while typing commits the raw reading; the n-run correction
-- belongs to conversion only (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "かn"
context:set_option("_kagiroi_hide_candidates", true)
local before_typing_enter = conversions_resolved
local typing_enter = press(env, 0xff0d)
assert(typing_enter == kAccepted, "Enter while typing must be consumed")
assert(context.commits[1] == "かn", "Enter while typing must commit the raw reading")
assert(context.input == "", "Enter while typing must end the composition")
assert(conversions_resolved == before_typing_enter, "Enter must not resolve the n run")

-- Space without a candidate menu reaches the standard processors.
env, context, segment = new_environment()
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
assert(env.conversion.reading == "かな", "Henkan must remember the hiragana reading")

-- Repeated Henkan stays idempotent.
press(env, 0xff23)
assert(context.input == "カナ" and env.conversion.reading == "かな", "repeated Henkan must stay idempotent")

-- Esc after Henkan restores the hiragana reading with the list hidden.
local esc = press(env, 0xff1b)
assert(esc == kAccepted, "Esc after Henkan must be consumed")
assert(context.input == "かな", "Esc after Henkan must restore the hiragana reading")
assert(not context:get_option("katakana"), "Esc after Henkan must restore the kana mode")
assert(context:get_option("_kagiroi_hide_candidates"), "Esc after Henkan must keep the list hidden")
assert(#context.commits == 0, "Esc after Henkan must not commit")

-- Backspace after Henkan deletes from the katakana candidate, not the reading.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
local backspace = press(env, 0xff08)
assert(backspace == kAccepted, "Backspace after Henkan must be consumed")
assert(context.input == "カ", "Backspace after Henkan must remove one katakana character")
assert(env.conversion == nil and not context:get_option("katakana"),
    "Backspace after Henkan must end conversion and restore the kana mode")
assert(context:get_option("_kagiroi_hide_candidates"), "Backspace after Henkan must keep the list hidden")
assert(#context.commits == 0, "Backspace after Henkan must not commit")
press(env, 0xff1b)
assert(context.input == "", "Esc after Backspace must clear the remaining katakana")

-- Enter after Henkan commits the katakana first candidate.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
local henkan_enter = press(env, 0xff0d)
assert(henkan_enter == kAccepted, "Enter after Henkan must be consumed")
assert(context.commits[1] == "カナ", "Enter after Henkan must commit the katakana input")
assert(context.input == "", "Enter after Henkan must end composition")
assert(not context:get_option("katakana"), "Enter after Henkan must restore the kana mode")
assert(env.conversion == nil, "Enter after Henkan must end the Henkan state")

-- Henkan then Space reveals the menu with the first candidate selected.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
press(env, 0x20)
assert(not context:get_option("_kagiroi_hide_candidates"), "Space after Henkan must reveal candidates")
assert(context:has_menu(), "Space after Henkan must build a menu")
assert(context.input == "カナ", "Space after Henkan must keep the katakana input")
assert(segment.selected_index == 0, "Space after Henkan must keep the first candidate selected")
local henkan_space_enter = press(env, 0xff0d)
assert(henkan_space_enter == kAccepted, "Enter after Henkan and Space must be consumed")
assert(context.commits[1] == "かな", "Enter must commit the highlighted candidate after Henkan")
assert(not context:get_option("katakana"), "the commit must restore the kana mode")

-- Henkan from the first-candidate conversion converts the reading, not the
-- displayed candidate.
env, context, segment = new_environment({ "感", "カン", "かん" })
context.input = "かん"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(context.input == "感", "the first Space must convert to the first candidate")
local converted_henkan = press(env, 0xff23)
assert(converted_henkan == kAccepted, "Henkan after the first Space must be consumed")
assert(context.input == "カン", "Henkan must convert the reading, not the displayed candidate")
assert(env.conversion.reading == "かん", "Henkan must keep the hiragana reading")

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

-- Backspace with the menu visible deletes from the selected candidate.
env, context, segment = new_environment()
context.input = "かんな"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must select the second candidate")
local shortened_selection = press(env, 0xff08)
assert(shortened_selection == kAccepted, "Backspace with the menu visible must be consumed")
assert(context.input == "仮", "Backspace must delete from the selected candidate")
assert(env.conversion == nil, "Backspace must leave conversion mode")
assert(context:get_option("_kagiroi_hide_candidates"), "Backspace must hide the list")
assert(#context.commits == 0, "Backspace must not commit")
local typing_backspace = press(env, 0xff08)
assert(typing_backspace == kNoop and context.input == "", "a later Backspace must delete the remaining character")

-- Esc clears the composition while typing, and returns to the reading while
-- converting (the second Esc after a conversion clears it).
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
local typing_esc = press(env, 0xff1b)
assert(typing_esc == kAccepted, "Esc while typing must be consumed")
assert(context.input == "", "Esc must clear the composition while typing")
assert(#context.commits == 0, "Esc must not commit while typing")
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local converting_esc = press(env, 0xff1b)
assert(converting_esc == kAccepted, "Esc while converting must be consumed")
assert(context.input == "かな", "Esc must keep the reading while converting")
assert(context:get_option("_kagiroi_hide_candidates"), "Esc must hide the list")
assert(#context.commits == 0, "Esc must not commit while converting")
local second_esc = press(env, 0xff1b)
assert(second_esc == kAccepted, "the second Esc must be consumed")
assert(context.input == "", "the second Esc must clear the composition")
assert(#context.commits == 0, "the second Esc must not commit")

-- Enter after the first Space commits the first candidate shown inline.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local converted_enter = press(env, 0xff0d)
assert(converted_enter == kAccepted, "Enter after the first Space must be consumed")
assert(context.commits[1] == "かな", "Enter must commit the first candidate shown inline")
assert(env.conversion == nil, "the commit must end the conversion state")

-- Backspace after the first Space shortens the inline candidate, then
-- Space converts the remaining text anew rather than revealing the old menu.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local converted_backspace = press(env, 0xff08)
assert(converted_backspace == kAccepted, "Backspace after the first Space must be consumed")
assert(context.input == "か", "Backspace after the first Space must delete from the inline candidate")
assert(env.conversion == nil, "Backspace must leave the inline conversion")
assert(context:get_option("_kagiroi_hide_candidates"), "Backspace must hide the list")
assert(#context.commits == 0, "Backspace after the first Space must not commit")
press(env, 0x20)
assert(context.input == "かな" and env.conversion.reading == "か",
    "Space after Backspace must convert the remaining text anew")
assert(context:get_option("_kagiroi_hide_candidates"), "the new conversion must keep the list hidden")

-- Deleting the only character of an inline conversion empties the composition.
env, context = new_environment({ "字" })
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0xff08)
assert(context.input == "" and env.conversion == nil, "Backspace must remove the last character")
assert(#context.commits == 0, "deleting the last character must not commit")

-- A letter key with the first candidate shown commits it and restarts.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local before_restart = calls
local typing_key = press(env, string.byte("k"))
assert(typing_key == kNoop, "the restarted key must reach the speller chain")
assert(context.commits[1] == "かな", "a typing key must commit the first candidate")
assert(context:get_option("_kagiroi_hide_candidates"), "the next input must start hidden")
assert(calls == before_restart + 1, "the restarted key must be processed by the kana speller")

-- Idle Space commits a full-width space in Japanese mode.
env, context, segment = new_environment()
assert(press(env, 0x20) == kAccepted, "idle Space must be consumed")
assert(context.commits[1] == "　" and context.input == "", "idle Space must commit full-width space")

-- Main-row digits commit full-width text; keypad digits stay half-width.
for _, case in ipairs({
    { key = string.byte("0"), expected = "０" },
    { key = string.byte("1"), expected = "１" },
    { key = string.byte("9"), expected = "９" },
    { key = 0xffb0, expected = "0" },
    { key = 0xffb1, expected = "1" },
    { key = 0xffb9, expected = "9" },
    { key = 0xffae, expected = "．" },
}) do
    env, context, segment = new_environment()
    assert(press(env, case.key) == kAccepted, "idle digit/decimal must be consumed")
    assert(context.commits[1] == case.expected and context.input == "", "idle digit/decimal must commit its width")
end

-- A digit while typing commits the reading and the new full-width digit.
env, context, segment = new_environment()
context.input = "かんな"
context:set_option("_kagiroi_hide_candidates", true)
local digit = press(env, string.byte("1"))
assert(digit == kAccepted, "a digit while typing must be consumed")
assert(context.commits[1] == "かんな", "a digit while typing must commit the reading")
assert(context.commits[2] == "１", "the main-row digit must commit full-width")
assert(context.input == "", "the digit must leave no composition")

-- A digit while typing commits the raw reading without the n correction.
env, context, segment = new_environment()
context.input = "かn"
context:set_option("_kagiroi_hide_candidates", true)
local raw_digit = press(env, string.byte("2"))
assert(raw_digit == kAccepted, "a digit on a pending n must be consumed")
assert(context.commits[1] == "かn", "a digit must commit the raw reading without the n correction")
assert(context.commits[2] == "２" and context.input == "", "the digit must commit full-width directly")

-- Keypad digits, decimal and Enter preserve their distinct behavior.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xffb1)
assert(context.commits[1] == "か" and context.commits[2] == "1" and context.input == "", "KP_1 must commit half-width")
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xffae)
assert(context.commits[1] == "か" and context.commits[2] == "．" and context.input == "", "KP_Decimal must commit full-width period")
env, context, segment = new_environment()
context.input = "かんな"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xff8b)
assert(context.commits[1] == "かんな" and context.input == "", "KP_Enter must commit like Enter")

-- A digit with the menu visible commits the highlighted candidate instead
-- of selecting by number.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must highlight the second candidate")
local menu_digit = press(env, string.byte("1"))
assert(menu_digit == kAccepted, "a digit must commit without selecting by number")
assert(context.commits[1] == "仮名", "a digit must commit the highlighted candidate, not candidate one")
assert(context.commits[2] == "１" and context.input == "", "a menu digit must commit full-width directly")

-- A digit after Henkan commits the katakana and its full-width digit.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
press(env, string.byte("2"))
assert(context.commits[1] == "カナ", "a digit after Henkan must commit the katakana")
assert(context.commits[2] == "２" and context.input == "", "a digit after Henkan must commit full-width")
assert(not context:get_option("katakana"), "the commit must restore the original mode")

-- Symbols after a hidden reading commit it and open the symbol gate.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte("$")) == kNoop, "dollar must reach the punctuator")
assert(context.commits[1] == "かな" and context.input == "", "dollar must commit the reading")
assert(not context:get_option("_kagiroi_hide_candidates"), "dollar must open the symbol gate")

-- Minus extends the reading, but minus and equal after selection commit it as symbols.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte("-")) == kNoop and #context.commits == 0,
    "minus in a reading must reach the speller without committing")
for _, key in ipairs({ "-", "=" }) do
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, 0x20)
    assert(press(env, string.byte(key)) == kNoop, "the symbol must reach the speller chain")
    assert(context.commits[1] == "仮名" and context.input == "",
        "the symbol must commit the highlighted candidate")
    assert(context:get_option("_kagiroi_hide_candidates") == (key == "-"),
        "minus must restart a hidden reading, while equal must open the symbol gate")
end

-- Semicolon is full-width even though Kagiroi accepts it in the alphabet.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte(";")) == kAccepted, "semicolon must be consumed")
assert(context.commits[1] == "かな" and context.commits[2] == "；", "semicolon must commit the reading and full-width symbol")

-- Shift+letter commits the selection and then the half-width letter.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(press(env, string.byte("A"), { shift = true }) == kAccepted, "Shift+A must be consumed")
assert(context.commits[1] == "かな" and context.commits[2] == "A" and context.input == "",
    "Shift+A must commit the conversion and ASCII A")

-- Comma and period commit the selection like other typing keys; the
-- punctuation itself comes from the downstream punctuator.
for _, key in ipairs({ ",", "." }) do
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, 0x20)
    assert(segment.selected_index == 1, "cycling must select the second candidate first")
    local before_punct = calls
    local result = press(env, string.byte(key))
    assert(result == kNoop, "the " .. key .. " key must pass through to the punctuation chain")
    assert(context.commits[1] == "仮名", "a " .. key .. " key must commit the selected candidate")
    assert(context.input == "", "a " .. key .. " key must end the composition input")
    assert(not context:get_option("_kagiroi_hide_candidates"),
        "a " .. key .. " key must open the gate for the punctuator")
    assert(calls == before_punct + 1, "the " .. key .. " key must reach the kana speller")

    -- From the hidden conversion after the first Space, the gate must open
    -- for the punctuator as well.
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    assert(context:get_option("_kagiroi_hide_candidates"), "the first Space must keep the gate closed")
    press(env, string.byte(key))
    assert(context.commits[1] == "かな", "a " .. key .. " key after the first Space must commit the first candidate")
    assert(not context:get_option("_kagiroi_hide_candidates"),
        "a " .. key .. " key after the first Space must open the gate for the punctuator")
end

-- An external commit (the ascii mode toggle) cleans the Henkan state.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
context:commit()
assert(context.commits[1] == "カナ", "the external commit must commit the katakana input")
assert(not context:get_option("katakana"), "an external commit must restore the kana mode")
assert(env.conversion == nil, "an external commit must end the conversion state")

-- Ascii mode and modifier combinations pass through.
env, context, segment = new_environment()
context:set_option("ascii_mode", true)
context.input = "かな"
assert(press(env, 0xff23) == kNoop, "Henkan in ascii mode must pass through")
assert(press(env, 0x20) == kNoop, "Space in ascii mode must pass through")
assert(press(env, 0xff0d) == kNoop, "Enter in ascii mode must pass through")
assert(press(env, 0xff1b) == kNoop, "Esc in ascii mode must pass through")
assert(press(env, 0xffb1) == kNoop, "keypad digits in ascii mode must pass through")
assert(press(env, string.byte("1")) == kNoop, "main-row digits in ascii mode must pass through")
assert(press(env, 0xffae) == kNoop, "KP_Decimal in ascii mode must pass through")
assert(press(env, 0x20, { ctrl = true }) == kNoop, "modified Space must pass through")
assert(press(env, 0xff23, { shift = true }) == kNoop, "modified Henkan must pass through")
assert(#context.commits == 0 and context.input == "かな", "ascii mode must leave the composition alone")

print("Rime candidate visibility, conversion and revert tests passed")
