package.path = arg[1]:match("^(.*)/kagiroi/") .. "/?.lua;" .. package.path
-- The generated key → text mappings are a build artifact (arg[2],
-- lua/kagiroi/zenkaku_text.lua), not a repository file.
package.preload["kagiroi/zenkaku_text"] = function() return dofile(arg[2]) end
_G.yield = coroutine.yield
_G.Translation = function(func)
    return { iter = function() return coroutine.wrap(func) end }
end
_G.Set = function(tags) return tags end
_G.Segment = function(start, finish)
    return { start = start, _end = finish, has_tag = function() return true end }
end
_G.Candidate = function(kind, start, finish, text, comment)
    local candidate = { type = kind, start = start, _end = finish, text = text, comment = comment }
    function candidate:get_genuine() return self end
    -- A candidate carrying an entry (set by the stock mock or Phrase below)
    -- stands for a genuine dictionary phrase, the learning input.
    function candidate:to_phrase()
        return self.phrase and { entry = self.phrase } or nil
    end
    return candidate
end
_G.ShadowCandidate = function(candidate, kind, text, comment)
    local shadow = { type = kind, text = text, comment = comment, start = candidate.start, _end = candidate._end }
    function shadow:get_genuine() return candidate end
    function shadow:to_phrase() return candidate:to_phrase() end
    return shadow
end
_G.DictEntry = function(copy)
    return copy and { text = copy.text, custom_code = copy.custom_code }
        or { text = "", custom_code = "" }
end
_G.Phrase = function(mem, tag, start, finish, entry)
    return {
        toCandidate = function()
            local candidate = Candidate("kagiroi", start, finish, entry.text, "")
            candidate.phrase = entry
            return candidate
        end,
    }
end
package.preload["kagiroi/kagiroi_translator"] = function()
    return {
        init = function(env)
            env.tag = "kagiroi"
            env.hira2kata_opencc = function() return Opencc() end
            env.viterbi = {
                analyze = function(self, reading) self.reading = reading end,
                best_n_prefix = function(self)
                    return function() return { surface = self.reading } end
                end,
                best_n = function() return function() return {} end end,
                clear = function() end,
            }
            env.mem = { update_userdict = function() end }
        end,
        fini = function() end,
        func = function(input, seg, env)
            for _, item in ipairs(env.engine.context.mock_candidates) do
                local offered = type(item) == "table" and item or { text = item }
                if not offered.readings or offered.readings[input] then
                    local candidate = Candidate("kagiroi", seg.start, seg._end, offered.text, "")
                    candidate.phrase = offered.phrase
                    yield(candidate)
                end
            end
        end,
    }
end
local bunsetsu = require("kagiroi/bunsetsu")
local kAccepted = 1
local kNoop = 2
local kRejected = 0
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

    function segment:has_tag(tag)
        return tag == "kagiroi"
    end
    local context = { options = {}, commits = {}, commit_slots = {}, properties = {},
        mock_candidates = segment.menu.candidates }
    function context:get_property(name) return self.properties[name] or "" end
    function context:set_property(name, value) self.properties[name] = value end
    function segment:get_candidate_at(index)
        local state = bunsetsu.state(context)
        if state then
            local clause = state.clauses[state.active]
            return clause.candidates[state.window_start + index + 1]
        end
        local text = self.menu.candidates[index + 1]
        return text and { text = text } or nil
    end
    context.option_update_notifier = {
        connect = function() return { disconnect = function() end } end,
    }
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
            and segment:get_candidate_at(0) ~= nil
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
        local caret = self.caret_pos
        self.input = self.input:sub(1, caret) .. text .. self.input:sub(caret + 1)
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
                segment.selected_index = 0
                table.refreshed = true
                local state = bunsetsu.state(table)
                if value ~= "" and state then
                    local seg = Segment(state.active_start, state.active_end)
                    local translation = Translation(function()
                        bunsetsu.func(value, seg, table.translator_env)
                    end)
                    local filter_env = { engine = table.translator_env.engine }
                    bunsetsu.filter.tags_match(seg, filter_env)
                    for _ in coroutine.wrap(function()
                        bunsetsu.filter.func(translation, filter_env)
                    end) do end
                end
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
    context.translator_env = env
    bunsetsu.init(env)
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

-- Enter learns every dictionary clause and, when all clauses carry
-- entries, the whole reading as one joined entry (dotfiles/rime/SPEC.md,
-- "確定と次入力").
env, context = new_environment({
    { text = "下", readings = { ["か"] = true }, phrase = { text = "下|2820 2820", custom_code = "か " } },
    { text = "ネ", readings = { ["1"] = true }, phrase = { text = "ネ|2830 2830", custom_code = "1 " } },
})
local learned = {}
env.mem = { update_userdict = function(self, entry) table.insert(learned, entry) end }
context.input = "か1"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kAccepted, "the learning test must start with a hidden conversion")
assert(press(env, 0xff0d) == kAccepted, "Enter must commit the conversion")
assert(context.commits[1] == "下ネ", "Enter must commit the displayed clauses")
assert(#learned == 3, "Enter must learn both clauses and their join")
assert(learned[1].text == "下|2820 2820" and learned[1].custom_code == "か ",
    "each clause must learn its own entry first")
assert(learned[2].text == "ネ|2830 2830" and learned[2].custom_code == "1 ",
    "the second clause must follow the first")
assert(learned[3].text == "下ネ|2820 2830" and learned[3].custom_code == "か1 ",
    "the join must carry the whole reading with the boundary ids")

-- A single clause learns only its own entry: the join would duplicate it.
env, context = new_environment({
    { text = "下", phrase = { text = "下|2820 2820", custom_code = "かな " } },
})
learned = {}
env.mem = { update_userdict = function(self, entry) table.insert(learned, entry) end }
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kAccepted and press(env, 0xff0d) == kAccepted,
    "the single-clause test must convert and commit")
assert(#learned == 1 and learned[1].text == "下|2820 2820",
    "a single clause must learn only its own entry")

-- A clause without a dictionary entry keeps the whole reading unlearned:
-- the join would not match what the display shows for that clause.
env, context = new_environment({
    { text = "下", readings = { ["か"] = true } },
    { text = "ネ", readings = { ["1"] = true }, phrase = { text = "ネ|2830 2830", custom_code = "1 " } },
})
learned = {}
env.mem = { update_userdict = function(self, entry) table.insert(learned, entry) end }
context.input = "か1"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kAccepted and press(env, 0xff0d) == kAccepted,
    "the unlearned-clause test must convert and commit")
assert(#learned == 1 and learned[1].text == "ネ|2830 2830",
    "the clause without an entry must leave the join out and learn the rest only")

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
assert(press(env, 0xff56) == kAccepted and segment.selected_index == 0 and
    segment:get_candidate_at(0).text == "candidate 11",
    "collapsed PageDown must select the second window's first candidate")
assert(press(env, 0xff55) == kAccepted and segment.selected_index == 0 and
    segment:get_candidate_at(0).text == "candidate 1",
    "collapsed PageUp must return to the first window's first candidate")
assert(press(env, 0xff55) == kAccepted and segment.selected_index == 0 and
    segment:get_candidate_at(0).text == "candidate 31",
    "collapsed PageUp before the first window must wrap to the last window's head")
assert(press(env, 0xff56) == kAccepted and segment.selected_index == 0 and
    segment:get_candidate_at(0).text == "candidate 1",
    "collapsed PageDown past the last window must wrap to the first window's head")
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
assert(press(env, 0xff55) == kAccepted and segment.selected_index == 30,
    "expanded PageUp before the first page must wrap to the last page's head")
assert(press(env, string.byte("y"), { ctrl = true }) == kNoop and
    press(env, string.byte("v"), { ctrl = true }) == kNoop and
    press(env, string.byte("v"), { alt = true }) == kNoop,
    "modified keys must not navigate in the controls processor")
assert(press(env, 0xff56) == kAccepted and segment.selected_index == 0,
    "expanded PageDown past the last page must wrap to the first page's head")

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

-- Conversion arrows select clauses and resize their reading, not the caret.
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff51) == kNoop and press(env, 0xff53) == kNoop,
    "typing arrows must reach the navigator")
press(env, 0x20)
assert(press(env, 0xff51) == kAccepted and env.conversion.active == 1,
    "Left at the first clause must keep the active clause")
press(env, 0xff51, { shift = true })
assert(env.conversion.clauses[1].reading == "か" and env.conversion.clauses[2].reading == "な",
    "Shift+Left must split the last codepoint into a new clause")
press(env, 0xff53, { shift = true })
assert(#env.conversion.clauses == 1 and env.conversion.clauses[1].reading == "かな",
    "Shift+Right must absorb the following one-character clause")
press(env, 0x20)
assert(press(env, 0xff51) == kAccepted and press(env, 0xff53) == kAccepted,
    "menu arrows must select clauses")
assert(#context.commits == 0 and not context:get_option("_kagiroi_hide_candidates"),
    "clause navigation must retain the open list without committing")

-- A successful clause move with the list open closes it and clears the
-- expansion; a move blocked at an end keeps everything, and each clause
-- keeps its own selection (dotfiles/rime/SPEC.md, "文節移動").
env, context, segment = new_environment()
context.input = "か1"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
press(env, 0xff09)
assert(context:get_option("_kagiroi_expand_candidates") and
    not context:get_option("_kagiroi_hide_candidates"),
    "the two-clause move test must start with an expanded open list")
assert(press(env, 0xff51) == kAccepted and env.conversion.active == 1 and
    not context:get_option("_kagiroi_hide_candidates") and
    context:get_option("_kagiroi_expand_candidates"),
    "Left blocked at the first clause must keep the list, expansion and state")
assert(press(env, 0xff53) == kAccepted and env.conversion.active == 2,
    "Right must move the target to the second clause")
assert(context:get_option("_kagiroi_hide_candidates") and
    not context:get_option("_kagiroi_expand_candidates"),
    "a successful move must close the list, clear the expansion and convert")
assert(env.conversion.clauses[1].selected == 2 and env.conversion.clauses[2].selected == 1,
    "a successful move must keep every clause's own selection")
assert(#context.commits == 0, "clause moves must not commit")
assert(press(env, 0xff53) == kAccepted and env.conversion.active == 2 and
    context:get_option("_kagiroi_hide_candidates"),
    "Right blocked at the last clause must keep the hidden conversion")

-- Resize: a boundary that actually moves closes an open list; a blocked
-- one keeps everything, and the hidden conversion keeps its list closed
-- (dotfiles/rime/SPEC.md, "境界変更").
env, context, segment = new_environment()
context.input = "かな"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0xff51, { shift = true })
assert(context:get_option("_kagiroi_hide_candidates") and #env.conversion.clauses == 2,
    "a hidden resize must keep the list closed while moving the boundary")
press(env, 0x20)
press(env, 0xff09)
assert(press(env, 0xff53, { shift = true }) == kAccepted and #env.conversion.clauses == 1,
    "Shift+Right must absorb the one-character clause")
assert(context:get_option("_kagiroi_hide_candidates") and
    not context:get_option("_kagiroi_expand_candidates"),
    "a successful resize must close the list and clear the expansion")
assert(env.conversion.clauses[1].selected == 1,
    "a moved boundary must reset the active clause to its first candidate")

-- Enter outside a composition passes through to the speller chain.
local before_empty_enter = calls
env, context = new_environment()
assert(press(env, 0xff0d) == kNoop, "Enter outside composition must pass through")
assert(calls == before_empty_enter + 1, "Enter without a menu must reach the kana speller")

env, context, segment = new_environment()
context.input = "かn"
context:set_option("_kagiroi_hide_candidates", true)
local before_typing_enter = conversions_resolved
local typing_enter = press(env, 0xff0d)
assert(typing_enter == kAccepted, "Enter while typing must be consumed")
assert(context.commits[1] == "かn", "Enter while typing must commit the raw reading")
assert(context.input == "", "Enter while typing must end the composition")
assert(conversions_resolved == before_typing_enter, "Enter must not resolve the n run")

-- Enter does not fold an excessive n run either: the displayed reading
-- commits as-is (dotfiles/rime/SPEC.md, "確定と次入力").
env, context, segment = new_environment()
context.input = "かんんあ"
context:set_option("_kagiroi_hide_candidates", true)
local before_excess_enter = conversions_resolved
assert(press(env, 0xff0d) == kAccepted, "Enter on an excessive-n reading must be consumed")
assert(context.commits[#context.commits] == "かんんあ",
    "Enter must commit the excessive-n reading without folding")
assert(conversions_resolved == before_excess_enter,
    "Enter must not resolve the excessive n run")

-- Space converts even when the composition holds no candidate menu: the
-- unconfirmed string becomes its own first candidate
-- (dotfiles/rime/SPEC.md).
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
context.mock_candidates = {}
assert(press(env, 0x20) == kAccepted, "Space without candidates must convert the input")
assert(context.input == "か" and env.conversion and bunsetsu.display(context) == "か",
    "Space without candidates must convert the string to itself")
assert(context:get_option("_kagiroi_hide_candidates"),
    "the conversion without candidates must keep the list hidden")

-- A candidate-less input follows the same conversion.
env, context, segment = new_environment({})
context.input = "k"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0x20) == kAccepted, "Space on a candidate-less input must convert it")
assert(context.input == "k" and bunsetsu.display(context) == "k",
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
assert(not context:get_option("katakana"), "Henkan must not change the kana mode option")
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

-- Space after Henkan returns the whole reading to its normal first candidate.
env, context, segment = new_environment({ "仮名", "かな", "カナ" })
context.input = "かな"
press(env, 0xff23)
assert(press(env, 0x20) == kAccepted and context.input == "仮名",
    "Space after Henkan must select the normal first candidate")
assert(context:get_option("_kagiroi_hide_candidates"), "the Henkan exception must keep the list hidden")
press(env, 0x20)
assert(not context:get_option("_kagiroi_hide_candidates") and segment.selected_index == 1,
    "the following Space must reveal the next normal candidate")
press(env, 0xff0d)
assert(context.commits[1] == "かな", "Enter must commit the selected normal candidate")

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
assert(context.input == "カナ" and context:get_option("hw_katakana"),
    "Henkan must display full-width katakana without changing the prior mode")
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

assert(context:get_option("_kagiroi_hide_candidates"), "Backspace must hide the list")
assert(#context.commits == 0, "Backspace must not commit")
local typing_backspace = press(env, 0xff08)
assert(typing_backspace == kAccepted and context.input == "",
    "a later Backspace must remove the final character in preconversion input")

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

-- Main-row digits append full-width text; keypad digits and every keypad
-- symbol stay half-width (dotfiles/rime/SPEC.md, "共通の文字対応").
for _, case in ipairs({
    { key = string.byte("0"), expected = "０" },
    { key = string.byte("1"), expected = "１" },
    { key = string.byte("9"), expected = "９" },
    { key = 0xffb0, expected = "0" },
    { key = 0xffb1, expected = "1" },
    { key = 0xffb9, expected = "9" },
    { key = 0xffae, expected = "." },
    { key = 0xffac, expected = "," },
    { key = 0xffaa, expected = "*" },
    { key = 0xffab, expected = "+" },
    { key = 0xffad, expected = "-" },
    { key = 0xffaf, expected = "/" },
    { key = 0xffbd, expected = "=" },
}) do
    env, context, segment = new_environment()
    assert(press(env, case.key) == kAccepted, "idle digit/decimal must be consumed")
    assert(context.input == case.expected and #context.commits == 0, "idle digit/decimal must append its character")
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

-- Punctuation, the keypad separator and the keypad operators append to
-- the reading's end while typing (dotfiles/rime/SPEC.md).
for _, case in ipairs({
    { key = string.byte(","), expected = "かな、" },
    { key = string.byte("."), expected = "かな。" },
    { key = 0xffac, expected = "かな," },
    { key = 0xffab, expected = "かな+" },
    { key = 0xffbd, expected = "かな=" },
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
assert(context.input == "か." and #context.commits == 0, "KP_Decimal must append the half-width period")
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

-- Minus extends the reading while typing; during conversion, minus and
-- equal commit the whole display and restart the input with their
-- character (dotfiles/rime/SPEC.md, "確定と次入力").
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
    assert(context.commits[1] == "仮名", "the symbol must commit the whole displayed selection")
    assert(context.input == case.symbol,
        "the symbol must restart the input with its character")
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the restart must keep the gate closed")
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
assert(not context:get_option("_kagiroi_off_pending"), "Shift+A must clear the OFF reservation")

env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(press(env, string.byte("A"), { shift = true }) == kAccepted, "Shift+A must be consumed")
assert(context:get_option("_kagiroi_ascii_input"), "Shift+A must enter the ascii input mode")
assert(#context.commits == 0, "Shift+A must not commit the conversion")
assert(context.input == "かなA",
    "Shift+A must keep the display and append A")
assert(env.conversion == nil, "Shift+A must end the conversion state")
assert(not context:has_menu(), "Shift+A must close the list")

-- Comma and period during conversion commit the whole display and restart
-- the input with the punctuation (dotfiles/rime/SPEC.md, "確定と次入力").
for _, case in ipairs({ { key = ",", punct = "、" }, { key = ".", punct = "。" } }) do
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, 0x20)
    assert(segment.selected_index == 1, "cycling must select the second candidate first")
    local result = press(env, string.byte(case.key))
    assert(result == kAccepted, "the " .. case.key .. " key must be consumed")
    assert(context.commits[1] == "仮名",
        "a " .. case.key .. " key must commit the whole displayed selection")
    assert(context.input == case.punct,
        "a " .. case.key .. " key must restart the input with " .. case.punct)
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the restart must keep the gate closed")

    -- From the hidden conversion after the first Space.
    env, context, segment = new_environment()
    context.input = "か"
    context:set_option("_kagiroi_hide_candidates", true)
    press(env, 0x20)
    press(env, string.byte(case.key))
    assert(context.commits[1] == "かな",
        "a " .. case.key .. " key after the first Space must commit the inline display")
    assert(context.input == case.punct,
        "a " .. case.key .. " key after the first Space must restart with " .. case.punct)
    assert(context:get_option("_kagiroi_hide_candidates"),
        "the restart must keep the gate closed")
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
assert(env.conversion and bunsetsu.display(context) == "仮名",
    "the conversion state must survive the menu close")
assert(context:get_option("_kagiroi_hide_candidates"),
    "the menu close must hide the list")
assert(#context.commits == 0, "the menu close must not commit")
assert(press(env, 0xff1b) == kAccepted, "the second Esc must be consumed")
assert(context.input == "か", "the second Esc must restore the reading")
assert(env.conversion == nil, "the second Esc must end the conversion")

-- The keypad separator commits the whole display and restarts the input
-- with a half-width comma (dotfiles/rime/SPEC.md, "確定と次入力").
env, context, segment = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
assert(press(env, 0xffac) == kAccepted,
    "the keypad separator during conversion must be consumed")
assert(context.commits[1] == "かな", "the keypad separator must commit the whole display")
assert(context.input == ",", "the keypad separator must restart with a half-width comma")
assert(context:get_option("_kagiroi_hide_candidates"),
    "the restart must keep the gate closed")

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
for _, case in ipairs({
    { key = 0xffaa, char = "*" }, { key = 0xffab, char = "+" },
    { key = 0xffad, char = "-" }, { key = 0xffaf, char = "/" },
    { key = 0xffbd, char = "=" },
}) do
    assert(press(env, case.key) == kAccepted,
        "the keypad operator " .. case.char .. " must be consumed")
end
assert(context.input == "かんじaA11! ,.,*+-/=" and #context.commits == 0,
    "the keypad operators must append their half-width characters")
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

-- Only a pending OFF reservation determines the mode after deletion.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
context:set_option("_kagiroi_off_pending", true)
press(env, 0xff08)
press(env, 0xff08)
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Backspace must empty the string and leave the mode")
assert(context:get_option("ascii_mode"),
    "an emptied reserved string must switch IME OFF")
assert(not context:get_option("_kagiroi_off_pending"), "the exit must clear the OFF reservation")
context:set_option("ascii_mode", false)

env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
context:set_option("_kagiroi_off_pending", false)
press(env, 0xff1b)
assert(context.input == "" and not context:get_option("_kagiroi_ascii_input"),
    "Esc must empty the string and leave the mode")
assert(not context:get_option("ascii_mode"),
    "an emptied unreserved string must return to the Japanese input")
assert(not context:get_option("_kagiroi_off_pending"), "the exit must clear the OFF reservation")

-- Enter clears the reservation and returns to Japanese input.
env, context, segment = new_environment()
context.input = "かa"
context:set_option("_kagiroi_ascii_input", true)
context:set_option("_kagiroi_hide_candidates", true)
context:set_option("_kagiroi_off_pending", true)
assert(press(env, 0xff0d) == kAccepted, "Enter must be consumed")
assert(context.commits[1] == "かa" and context.input == "",
    "Enter must commit the unconfirmed string")
assert(not context:get_option("_kagiroi_ascii_input")
    and not context:get_option("ascii_mode"),
    "Enter must return to the Japanese input")
assert(not context:get_option("_kagiroi_off_pending"), "Enter must clear the OFF reservation")

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
assert(press(env, string.byte("z"), { ctrl = true }) == kNoop,
    "unlisted modified letters must pass through")
assert(press(env, string.byte("a"), { ctrl = true }) == kRejected,
    "the listed Control+a must be rejected to the application")
assert(context.input == "かa", "passing-through keys must leave the composition alone")

-- Retained lists keep the displayed choice, expansion and candidate identity.
for _, expanded in ipairs({ false, true }) do
    for _, direction in ipairs({ 0xff52, 0xff54 }) do
        env, context, segment = new_environment({ "今日", "京", "凶" })
        context.input = "きょう"
        press(env, 0x20)
        press(env, 0x20)
        if expanded then press(env, 0xff09) end
        processor.start_ascii_input(context)
        context:set_option("_kagiroi_off_pending", true)
        assert(bunsetsu.display(context) == "京", "halfwidth entry must retain the chosen display")
        assert(context:has_menu() and segment.selected_index == 1,
            "halfwidth entry must retain the list and selection")
        assert(context:get_option("_kagiroi_expand_candidates") == expanded,
            "halfwidth entry must retain expansion")
        press(env, direction)
        assert(not context:get_option("_kagiroi_ascii_input")
            and not context:get_option("_kagiroi_off_pending"),
            "retained-list arrows must return to Japanese and clear the reservation")
        assert(bunsetsu.display(context) == (direction == 0xff52 and "今日" or "凶"),
            "retained-list arrows must select the previous or next candidate")
        assert(context:has_menu() and context:get_option("_kagiroi_expand_candidates") == expanded,
            "retained-list arrows must keep the list and expansion")
    end
end

for _, case in ipairs({
    { key = 0x20, text = "京 ", ascii = true, pending = false },
    { key = string.byte("b"), text = "京b", ascii = true, pending = false },
    { key = string.byte("-"), text = "京-", ascii = true, pending = false },
    { key = 0xff08, text = "", ascii = false, pending = false, off = true },
    { key = 0xff1b, text = "", ascii = false, pending = false, off = true },
    { key = 0xff0d, text = "", ascii = false, pending = false, commit = "京" },
}) do
    env, context, segment = new_environment({ "今日", "京", "凶" })
    context.input = "きょう"
    press(env, 0x20)
    press(env, 0x20)
    press(env, 0xff09)
    processor.start_ascii_input(context)
    context:set_option("_kagiroi_off_pending", true)
    press(env, case.key)
    assert(context.input == case.text, "retained-list edit must act on the displayed text")
    assert(context:get_option("_kagiroi_ascii_input") == case.ascii,
        "retained-list edit must enter the specified mode")
    assert(context:get_option("_kagiroi_off_pending") == case.pending,
        "retained-list edit must update the reservation")
    assert(context:get_option("ascii_mode") == (case.off or false),
        "retained-list deletion must obey the reservation")
    assert(not context:has_menu() and not context:get_option("_kagiroi_expand_candidates"),
        "retained-list edit must close and collapse the list")
    assert(context.commits[1] == case.commit, "only Enter must commit the retained display")
end

for _, ascii in ipairs({ false, true }) do
    for _, pending in ipairs({ false, true }) do
        env, context = new_environment()
        context.input = "かA"
        context:set_option("_kagiroi_ascii_input", ascii)
        context:set_option("_kagiroi_off_pending", pending)
        context.caret_pos = 0
        press(env, 0xff08)
        assert(context.input == "か", "Backspace must delete at the end, not at the caret")
        assert(context:get_option("_kagiroi_off_pending") == pending,
            "partial deletion must preserve the reservation")
        assert(context:get_option("_kagiroi_ascii_input") == ascii,
            "partial deletion must preserve Japanese or halfwidth input")
        press(env, 0xff08)
        assert(context.input == "" and context:get_option("ascii_mode") == pending,
            "deletion to empty must obey the reservation in both input modes")
        assert(not context:get_option("_kagiroi_ascii_input")
            and not context:get_option("_kagiroi_off_pending"),
            "deletion to empty must finish the halfwidth mode and reservation")
    end
end

for _, ascii in ipairs({ false, true }) do
    env, context = new_environment()
    context.input = "かな"
    context.caret_pos = 0
    context:set_option("_kagiroi_ascii_input", ascii)
    context:set_option("_kagiroi_off_pending", true)
    press(env, string.byte("1"))
    assert(context.input == (ascii and "かな1" or "かな１"),
        "direct additions must append at the end even after caret movement")
    assert(not context:get_option("_kagiroi_off_pending"), "additions must clear the reservation")
end

-- The listed editing, mode and emoji shortcuts stay unassigned in Rime:
-- the processor rejects them so the rest of the chain cannot consume them
-- either, and every IME ON state keeps the state untouched
-- (dotfiles/rime/SPEC.md, "ショートカット"). The application-level
-- pass-through is verified by the C harness.
local shortcut_cases = {}
for _, letter in ipairs({ "p", "n", "b", "f", "a", "e", "d", "k", "h", "g", "q" }) do
    table.insert(shortcut_cases, { string.byte(letter), { ctrl = true } })
end
for _, digit in ipairs({ "1", "2", "3", "4", "5", "!", "@", "#", "$", "%" }) do
    table.insert(shortcut_cases, { string.byte(digit), { ctrl = true, shift = true } })
end
table.insert(shortcut_cases, { string.byte("["), { ctrl = true } })
for state = 1, 4 do
    env, context, segment = new_environment({ "今日", "京", "凶" })
    context.input = "きょう"
    context:set_option("_kagiroi_hide_candidates", true)
    if state >= 2 then press(env, 0x20) end
    if state >= 3 then press(env, 0x20) end
    if state == 4 then context:set_option("_kagiroi_ascii_input", true) end
    local input = context.input
    local hide = context:get_option("_kagiroi_hide_candidates")
    local selected = segment.selected_index
    for _, case in ipairs(shortcut_cases) do
        assert(press(env, case[1], case[2]) == kRejected,
            "a listed shortcut must be rejected to the application")
        assert(context.input == input and #context.commits == 0
            and segment.selected_index == selected
            and context:get_option("_kagiroi_hide_candidates") == hide
            and not context:get_option("_kagiroi_off_pending")
            and not context:get_option("_kagiroi_expand_candidates"),
            "a listed shortcut must leave the whole state untouched")
    end
end

print("Rime candidate visibility, conversion and revert tests passed")
