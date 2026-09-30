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
        ascii_tail = nil,
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
    local context = { options = {}, commits = {}, commit_slots = {} }
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
    function context:get_commit_text()
        if self:has_menu() then
            local candidate = segment:get_candidate_at(segment.selected_index)
            if candidate then
                return candidate.text
            end
        end
        return self.input
    end
    function context:commit()
        local text
        if self:has_menu() then
            text = segment:get_candidate_at(segment.selected_index).text
        else
            text = self.input
        end
        table.insert(self.commits, text)
        self.input = ""
        for _, handler in ipairs(self.commit_slots) do
            handler()
        end
    end
    -- The raw input lives under _input so every assignment to context.input
    -- passes through __newindex and moves the caret to the end, mirroring
    -- Context::set_input. rime_controls writes caret_pos directly when it
    -- resizes the selected segment.
    setmetatable(context, {
        __index = function(table, key)
            if key == "input" then
                return rawget(table, "_input") or ""
            end
            return nil
        end,
        __newindex = function(table, key, value)
            if key == "input" then
                rawset(table, "_input", value)
                rawset(table, "caret_pos", #value)
            else
                rawset(table, key, value)
            end
        end,
    })
    context.input = ""
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

-- Tab expands without moving the selection; a second Tab does nothing and
-- Shift+Tab collapses the expansion back to the collapsed page.
local many_candidates = {}
for index = 1, 65 do many_candidates[index] = "candidate " .. index end
env, context, segment = new_environment(many_candidates)
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff09) == kAccepted, "Tab while the list is hidden must be consumed doing nothing")
press(env, 0x20)
assert(press(env, 0xff09) == kAccepted, "Tab after the first Space must be consumed doing nothing")
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must select candidate two")
assert(press(env, 0xff09) == kAccepted, "the first visible Tab must be consumed")
assert(context:get_option("_kagiroi_expand_candidates") and context.refreshed,
    "the first visible Tab must refresh the expanded translation")
assert(segment.selected_index == 1, "expansion must preserve the selected candidate")
assert(press(env, 0xff09) == kAccepted, "the second Tab must be consumed doing nothing")
assert(segment.selected_index == 1, "the second Tab must keep the selection")
assert(press(env, 0xff09, { shift = true }) == kAccepted,
    "Shift+Tab must be consumed collapsing the expansion")
assert(not context:get_option("_kagiroi_expand_candidates"),
    "Shift+Tab must collapse the expansion")
assert(segment.selected_index == 1, "the collapse must keep the selection")
assert(press(env, 0xff09, { shift = true }) == kAccepted,
    "a collapsed Shift+Tab must be consumed doing nothing")
context:highlight(32)
assert(segment.selected_index == 32, "selection must reach the next page without changing labels")
context:highlight(0)
assert(segment.selected_index == 0, "selection must return to the first page")
press(env, 0xff08)
assert(not context:get_option("_kagiroi_expand_candidates"), "Backspace must collapse the next list")
press(env, 0x20)
press(env, 0x20)
press(env, 0xff09)
press(env, 0xff0d)
assert(not context:get_option("_kagiroi_expand_candidates"), "a commit must reset expansion")

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

-- Left and Right reach the stock navigator in every composing state: the
-- caret moves while typing, the conversion blocks move with the menu open,
-- and the hidden conversion selects the conversion segments
-- (dotfiles/rime/SPEC.md). Shift+Left/Shift+Right resize the selected
-- segment during the hidden conversion.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff51) == kNoop and press(env, 0xff53) == kNoop,
    "Left and Right while typing must reach the navigator")
assert(context.input == "かな" and #context.commits == 0,
    "the arrows while typing must leave the composition alone")
press(env, 0x20)
assert(press(env, 0xff51) == kNoop,
    "Left during the hidden conversion must reach the navigator")
assert(context.input == "かな" and #context.commits == 0 and env.conversion.reading == "かな",
    "the arrow during the hidden conversion must leave the conversion alone")
assert(press(env, 0xff51, { shift = true }) == kAccepted,
    "Shift+Left during the hidden conversion must be consumed")
assert(context.caret_pos == 3,
    "Shift+Left must shrink the selected segment by one character")
assert(press(env, 0xff53, { shift = true }) == kAccepted,
    "Shift+Right during the hidden conversion must be consumed")
assert(context.caret_pos == 6,
    "Shift+Right must extend the selected segment back")
press(env, 0x20)
assert(press(env, 0xff51) == kNoop and press(env, 0xff53) == kNoop,
    "Left and Right with the open list must reach the navigator")
assert(context.input == "かな" and #context.commits == 0,
    "the block navigation must not commit")
assert(not context:get_option("_kagiroi_hide_candidates"), "the list must stay open")
press(env, 0xff1b)
assert(press(env, 0xff53) == kNoop, "Right without the list must reach the navigator again")
env, context = new_environment()
assert(press(env, 0xff51) == kNoop, "Left without a composition must pass through")

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

-- Space converts even when the composition holds no candidate menu: the
-- unconfirmed string becomes its own first candidate
-- (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
function context:has_menu() return false end
assert(press(env, 0x20) == kAccepted, "Space without candidates must convert the input")
assert(context.input == "か" and env.conversion and env.conversion.display == "か",
    "Space without candidates must convert the string to itself")
assert(context:get_option("_kagiroi_hide_candidates"),
    "the conversion without candidates must keep the list hidden")

-- A candidate-less input follows the same conversion.
env, context, segment = new_environment({})
context.input = "k"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kAccepted, "Space on a candidate-less input must convert it")
assert(context.input == "k" and env.conversion.display == "k",
    "a candidate-less input must convert to itself")
assert(context:get_option("_kagiroi_hide_candidates"),
    "a candidate-less input must keep the list hidden")

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

-- Henkan then Space keeps the first candidate selected in the hidden
-- conversion (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
local henkan_space = press(env, 0x20)
assert(henkan_space == kAccepted, "Space after Henkan must be consumed")
assert(context:get_option("_kagiroi_hide_candidates"), "Space after Henkan must keep the list hidden")
assert(not context:has_menu(), "Space after Henkan must not build a menu")
assert(context.input == "カナ", "Space after Henkan must keep the katakana preedit")
assert(segment.selected_index == 0, "Space after Henkan must keep the first candidate selected")
assert(env.conversion and env.conversion.display == "カナ",
    "Space after Henkan must keep the conversion state")
assert(press(env, 0x20) == kAccepted and context:get_option("_kagiroi_hide_candidates"),
    "repeated Space after Henkan must keep the conversion hidden")
local henkan_space_enter = press(env, 0xff0d)
assert(henkan_space_enter == kAccepted, "Enter after Henkan and Space must be consumed")
assert(context.commits[1] == "カナ", "Enter must commit the kept katakana candidate")
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
assert(typing_backspace == kNoop,
    "a later Backspace must reach the kana speller chain (the deletion is its job)")

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

-- A letter key with the first candidate shown confirms it and starts the
-- next reading with the pressed key.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
local before_restart = calls
press(env, string.byte("k"))
assert(context.commits[1] == "かな", "a typing key must confirm the first candidate")
assert(calls == before_restart + 1, "the pressed key must start the next reading through the speller")
assert(context.input == "" and #context.commits == 1,
    "the confirmation must leave the input to the speller")
assert(context:get_option("_kagiroi_hide_candidates"), "the next reading must keep the list hidden")

-- Idle Space commits a full-width space immediately.
env, context, segment = new_environment()
assert(press(env, 0x20) == kAccepted, "idle Space must be consumed")
assert(context.commits[1] == "　" and context.input == "",
    "idle Space must commit the full-width space immediately")
assert(press(env, 0x20) == kAccepted, "a later idle Space must be consumed")
assert(context.commits[2] == "　", "repeated idle Spaces must keep committing")

-- Main-row digits append full-width text; keypad digits stay half-width.
for _, case in ipairs({
    { key = string.byte("0"), expected = "０" },
    { key = string.byte("1"), expected = "１" },
    { key = string.byte("9"), expected = "９" },
    { key = 0xffb0, expected = "0" },
    { key = 0xffb1, expected = "1" },
    { key = 0xffb9, expected = "9" },
    { key = 0xffae, expected = "．" },
    { key = 0xffac, expected = "，" },
}) do
    env, context, segment = new_environment()
    assert(press(env, case.key) == kAccepted, "idle digit/decimal must be consumed")
    assert(context.input == case.expected and #context.commits == 0, "idle digit/decimal must append its width")
end

-- A digit while typing appends the full-width digit to the reading.
env, context, segment = new_environment()
context.input = "かんな"
context:set_option("_kagiroi_hide_candidates", true)
local digit = press(env, string.byte("1"))
assert(digit == kAccepted, "a digit while typing must be consumed")
assert(context.input == "かんな１" and #context.commits == 0,
    "a digit must append full-width to the reading without committing")

-- A digit while typing keeps the raw reading without the n correction.
env, context, segment = new_environment()
context.input = "かn"
context:set_option("_kagiroi_hide_candidates", true)
local raw_digit = press(env, string.byte("2"))
assert(raw_digit == kAccepted, "a digit on a pending n must be consumed")
assert(context.input == "かn２" and #context.commits == 0,
    "a digit must append without the n correction")

-- Punctuation and the keypad separator append to the reading's end while
-- typing (dotfiles/rime/SPEC.md).
for _, case in ipairs({
    { key = string.byte(","), expected = "かな、" },
    { key = string.byte("."), expected = "かな。" },
    { key = 0xffac, expected = "かな，" },
}) do
    env, context, segment = new_environment()
    context.input = "かな"
    context:set_option("_kagiroi_hide_candidates", true)
    assert(press(env, case.key) == kAccepted, "the typing append key must be consumed")
    assert(context.input == case.expected and #context.commits == 0,
        "the typing append key must extend the reading unconfirmed")
end

-- Keypad digits and decimal append; KP_Enter commits like Enter.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xffb1)
assert(context.input == "か1" and #context.commits == 0, "KP_1 must append half-width")
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xffae)
assert(context.input == "か．" and #context.commits == 0, "KP_Decimal must append the full-width period")
env, context, segment = new_environment()
context.input = "かんな"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0xff8b)
assert(context.commits[1] == "かんな" and context.input == "", "KP_Enter must commit like Enter")

-- A digit with the menu visible confirms the highlighted candidate and
-- starts a fresh unconfirmed input instead of selecting by number.
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must highlight the second candidate")
local menu_digit = press(env, string.byte("1"))
assert(menu_digit == kAccepted, "a digit must be consumed without selecting by number")
assert(context.commits[1] == "仮名", "a menu digit must confirm the highlighted candidate")
assert(context.input == "１" and #context.commits == 1,
    "a menu digit must start a fresh input with the full-width digit")

-- A digit after Henkan confirms the katakana and starts a fresh input.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
press(env, string.byte("2"))
assert(context.commits[1] == "カナ", "a digit after Henkan must confirm the katakana")
assert(context.input == "２" and #context.commits == 1,
    "a digit after Henkan must start a fresh input")
assert(env.conversion == nil, "confirming must end the Henkan state")
assert(not context:get_option("katakana"), "confirming must restore the kana mode")

-- Symbols after a hidden reading append to it and keep the gate closed.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte("$")) == kAccepted, "dollar must be consumed")
assert(context.input == "かな＄" and #context.commits == 0, "dollar must append unconfirmed")
assert(context:get_option("_kagiroi_hide_candidates"), "dollar must keep the list hidden")

-- Minus extends the reading while typing; after a selection, minus and
-- equal confirm it and start a fresh input with their symbol.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte("-")) == kNoop and #context.commits == 0,
    "minus in a reading must reach the speller without committing")
for _, case in ipairs({ { key = "-", symbol = "ー" }, { key = "=", symbol = "＝" } }) do
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, 0x20)
    assert(press(env, string.byte(case.key)) == kAccepted, "the symbol must be consumed")
    assert(context.commits[1] == "仮名", "the symbol must confirm the highlighted candidate")
    assert(context.input == case.symbol and #context.commits == 1,
        "the symbol must start a fresh input")
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the append must keep the list hidden")
end

-- Semicolon is full-width even though Kagiroi accepts it in the alphabet.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, string.byte(";")) == kAccepted, "semicolon must be consumed")
assert(context.input == "かな；" and #context.commits == 0,
    "semicolon must append the full-width symbol")

-- Shift+letter switches to the unconfirmed ascii input mode from every
-- Japanese state and appends the uppercase letter to the kept reading
-- (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
assert(press(env, string.byte("A"), { shift = true }) == kAccepted, "idle Shift+A must be consumed")
assert(context:get_option("_kagiroi_ascii_input") and context.input == "A",
    "idle Shift+A must enter the ascii input mode with A")
assert(processor.ascii_input_origin == "shift", "Shift+A must record the shift origin")

env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(press(env, string.byte("A"), { shift = true }) == kAccepted, "Shift+A must be consumed")
assert(context:get_option("_kagiroi_ascii_input"), "Shift+A must enter the ascii input mode")
assert(#context.commits == 0, "Shift+A must not commit the conversion")
assert(context.input == "かA",
    "Shift+A must restore the reading and append A")
assert(env.conversion == nil, "Shift+A must end the conversion state")

-- Comma and period during conversion append the punctuation to the
-- converted text without committing it and end the conversion mode
-- (dotfiles/rime/SPEC.md, "句読点").
for _, case in ipairs({ { key = ",", punct = "、" }, { key = ".", punct = "。" } }) do
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, 0x20)
    assert(segment.selected_index == 1, "cycling must select the second candidate first")
    local result = press(env, string.byte(case.key))
    assert(result == kAccepted, "the " .. case.key .. " key must be consumed")
    assert(#context.commits == 0, "a " .. case.key .. " key must not commit the selection")
    assert(context.input == "仮名" .. case.punct,
        "a " .. case.key .. " key must append " .. case.punct .. " to the selection")
    assert(env.conversion == nil, "the append must end the conversion mode")
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the append must keep the gate closed")

    -- From the hidden conversion after the first Space, the punctuation
    -- appends to the inline display.
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, string.byte(case.key))
    assert(#context.commits == 0, "a " .. case.key .. " key after the first Space must not commit")
    assert(context.input == "かな" .. case.punct,
        "a " .. case.key .. " key after the first Space must append to the display")
    assert(env.conversion == nil,
        "a " .. case.key .. " key after the first Space must end the conversion")
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the append must keep the gate closed")
end

-- Esc with the menu visible closes the list and keeps the conversion to
-- the selected candidate; a second Esc restores the reading
-- (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 1, "the reveal must select the second candidate")
assert(press(env, 0xff1b) == kAccepted, "Esc with the menu open must be consumed")
assert(context.input == "仮名", "Esc must keep the conversion to the selected candidate")
assert(env.conversion and env.conversion.display == "仮名",
    "the conversion state must survive the menu close")
assert(context:get_option("_kagiroi_hide_candidates"),
    "the menu close must hide the list")
assert(#context.commits == 0, "the menu close must not commit")
assert(press(env, 0xff1b) == kAccepted, "the second Esc must be consumed")
assert(context.input == "か", "the second Esc must restore the reading")
assert(env.conversion == nil, "the second Esc must end the conversion")

-- The keypad separator confirms the conversion and starts a fresh input
-- with the full-width comma (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(press(env, 0xffac) == kAccepted,
    "the keypad separator during conversion must be consumed")
assert(context.commits[1] == "かな",
    "the keypad separator must confirm the conversion")
assert(context.input == "，" and #context.commits == 1,
    "the keypad separator must start a fresh input with ，")

-- An external commit (the ascii mode toggle) cleans the Henkan state.
env, context, segment = new_environment()
context.input = "かな"
press(env, 0xff23)
context:commit()
assert(context.commits[1] == "カナ", "the external commit must commit the katakana input")
assert(not context:get_option("katakana"), "an external commit must restore the kana mode")
assert(env.conversion == nil, "an external commit must end the conversion state")

-- A commit also drops the ascii tail recorded for the ascii input mode.
env, context, segment = new_environment()
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
kana_speller.ascii_tail = 6
context:commit()
assert(kana_speller.ascii_tail == nil, "a commit must drop the ascii tail")

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

-- The unconfirmed ascii input mode appends half-width characters to the
-- unconfirmed input (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "かんじ"
context:set_option("_kagiroi_ascii_input", true)
assert(press(env, string.byte("a")) == kAccepted, "an ascii letter must be consumed")
assert(context.input == "かんじa" and #context.commits == 0,
    "an ascii letter must append half-width")
assert(press(env, string.byte("A"), { shift = true }) == kAccepted,
    "Shift+letter must be consumed")
assert(context.input == "かんじaA", "Shift+letter must append the uppercase letter")
assert(press(env, string.byte("1")) == kAccepted and context.input == "かんじaA1",
    "a digit must append half-width")
assert(press(env, 0xffb1) == kAccepted and context.input == "かんじaA11",
    "a keypad digit must append half-width")
assert(press(env, string.byte("!")) == kAccepted and context.input == "かんじaA11!",
    "a symbol must append half-width")
assert(press(env, 0x20) == kAccepted and context.input == "かんじaA11! ",
    "a Space must append a half-width space")
assert(press(env, string.byte(",")) == kAccepted and context.input == "かんじaA11! ,",
    "a comma must append a half-width comma")
assert(press(env, string.byte(".")) == kAccepted and context.input == "かんじaA11! ,.",
    "a period must append a half-width period")
assert(press(env, 0xffac) == kAccepted and context.input == "かんじaA11! ,.,",
    "the keypad separator must append a half-width comma")
assert(context:get_option("_kagiroi_hide_candidates"), "the append must keep the list hidden")

-- Backspace removes the last character and ends the mode when empty.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
assert(press(env, 0xff08) == kAccepted, "Backspace must be consumed")
assert(context.input == "か", "Backspace must remove the appended character")
assert(context:get_option("_kagiroi_ascii_input"),
    "Backspace must keep the mode while the text remains")
assert(press(env, 0xff08) == kAccepted and context.input == "",
    "Backspace must remove the last character")
assert(not context:get_option("_kagiroi_ascii_input"),
    "Backspace must end the mode when the input empties")

-- The toggle origin continues into IME OFF once the string empties; the
-- shift origin returns to the Japanese input (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
processor.ascii_input_origin = "toggle"
press(env, 0xff08)
press(env, 0xff08)
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Backspace must empty the string and leave the mode")
assert(context:get_option("ascii_mode"),
    "an emptied toggle-origin string must switch IME OFF")
assert(processor.ascii_input_origin == nil, "the exit must clear the origin record")
context:set_option("ascii_mode", false)

env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
processor.ascii_input_origin = "shift"
press(env, 0xff1b)
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Esc must empty the string and leave the mode")
assert(not context:get_option("ascii_mode"),
    "an emptied shift-origin string must return to the Japanese input")
assert(processor.ascii_input_origin == nil, "the exit must clear the origin record")

-- Enter commits and returns to the Japanese input regardless of the origin.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
context:set_option("_kagiroi_hide_candidates", true)
processor.ascii_input_origin = "toggle"
assert(press(env, 0xff0d) == kAccepted, "Enter must be consumed")
assert(context.commits[1] == "かa" and context.input == "",
    "Enter must commit the unconfirmed string")
assert(not context:get_option("_kagiroi_ascii_input")
    and not context:get_option("ascii_mode"),
    "Enter must return to the Japanese input")
assert(processor.ascii_input_origin == nil, "Enter must clear the origin record")

-- Esc clears the composition and ends the mode without committing.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
assert(press(env, 0xff1b) == kAccepted, "Esc must be consumed")
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Esc must clear the composition and end the mode")
assert(#context.commits == 0, "Esc must not commit")

-- Enter commits the mixed composition and ends the mode.
env, context, segment = new_environment()
context.input = "かんじabc"
context:set_option("_kagiroi_ascii_input", true)
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff0d) == kAccepted, "Enter must be consumed")
assert(context.commits[1] == "かんじabc", "Enter must commit the mixed composition")
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Enter must end the mode")
assert(kana_speller.ascii_tail == nil, "the commit must drop the ascii tail")

-- Editing and conversion keys pass through while the mode is on.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
assert(press(env, 0xff23) == kNoop, "Henkan must pass through")
assert(press(env, 0xff52) == kNoop, "Up must pass through")
assert(press(env, string.byte("a"), { ctrl = true }) == kNoop, "modified letters must pass through")
assert(context.input == "かa", "passing-through keys must leave the composition alone")

print("Rime candidate visibility, conversion and revert tests passed")
