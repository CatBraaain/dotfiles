local kAccepted = 1
local kNoop = 2
local calls = 0
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
    }
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
    local context = { input = "", options = {}, composition = { back = function() return segment end }, commits = {} }
    -- Mirrors the gate filter: while _kagiroi_hide_candidates is on the menu is empty.
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
    function context:commit()
        table.insert(self.commits, segment:get_candidate_at(segment.selected_index))
        self.input = ""
    end
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

local env, context, segment = new_environment()
press(env, string.byte("k"))
assert(context:get_option("_kagiroi_hide_candidates"), "typing must hide candidates")
context.input = "か"
local first_space = press(env, 0x20)
assert(first_space == kAccepted, "first Space must be consumed")
assert(not context:get_option("_kagiroi_hide_candidates"), "first Space must reveal candidates")
assert(segment.selected_index == 0, "first Space must select the first candidate")
local before_selection = calls
local second_space = press(env, 0x20)
assert(second_space == kAccepted, "subsequent Space must not reach standard processors")
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

env, context, segment = new_environment()
context.highlight = nil
press(env, string.byte("k"))
context.input = "か"
local windows_first_ok, windows_first_space = pcall(press, env, 0x20)
assert(windows_first_ok, "first Space must not raise without the highlight API: " .. tostring(windows_first_space))
assert(windows_first_space == kAccepted, "first Space must be consumed without the highlight API")
assert(not context:get_option("_kagiroi_hide_candidates"), "first Space must reveal candidates without the highlight API")
assert(segment.selected_index == 0, "the default first candidate must stay selected without the highlight API")
assert(#context.commits == 0 and context.input == "か", "first Space must not commit without the highlight API")
local windows_second_ok, windows_second_space = pcall(press, env, 0x20)
assert(windows_second_ok, "subsequent Space must not raise without the highlight API: " .. tostring(windows_second_space))
assert(windows_second_space == kAccepted, "subsequent Space must be consumed without the highlight API")
assert(segment.selected_index == 1, "subsequent Space must move the selection via selected_index")
assert(#context.commits == 0 and context.input == "か", "Space cycling must not commit without the highlight API")
press(env, 0x20)
assert(segment.selected_index == 2, "Space must reach the last candidate via selected_index")
press(env, 0x20)
assert(segment.selected_index == 0, "Space must wrap to the first candidate via selected_index")
press(env, 0x20)
assert(segment.selected_index == 1, "Space must advance again after wrapping via selected_index")
local windows_enter = press(env, 0xff0d)
assert(windows_enter == kAccepted, "Enter must be consumed without the highlight API")
assert(context.commits[1] == "仮名", "Enter must commit the candidate selected via selected_index")
assert(context.input == "", "Enter must end composition without the highlight API")

env, context, segment = new_environment({ "かな" })
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
press(env, 0x20)
press(env, 0x20)
assert(segment.selected_index == 0 and #context.commits == 0, "a single candidate must stay highlighted without committing")

local before_empty_enter = calls
env, context = new_environment()
assert(press(env, 0xff0d) == kNoop, "Enter outside composition must pass through")
assert(calls == before_empty_enter + 1, "Enter without a menu must reach the kana speller")

env, context = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
assert(press(env, 0xff0d) == kNoop, "Enter before Space must retain the standard binding")
assert(#context.commits == 0, "Enter before Space must not use candidate commit")

env, context = new_environment()
context.input = "か"
context:set_option("_kagiroi_hide_candidates", true)
function context:has_menu() return false end
local no_menu_space = press(env, 0x20)
assert(no_menu_space == kNoop, "Space without a candidate menu must reach standard processors")
assert(context:get_option("_kagiroi_hide_candidates"), "Space without candidates must not reveal a menu")

env, context = new_environment()
context.input = ""
press(env, string.byte("n"))
assert(context:get_option("_kagiroi_hide_candidates"), "next input must hide candidates again")

local before_henkan = calls
context.input = "かな"
local henkan = press(env, 0xff23)
assert(henkan == kAccepted, "Henkan must be consumed without committing")
assert(calls == before_henkan, "Henkan must not reach the kana speller")
assert(context.input == "かな", "Henkan must leave composition intact")
assert(context:get_option("katakana"), "Henkan must enable full-width katakana")
assert(context:get_option("_rime_henkan"), "Henkan must enable candidate promotion")
assert(context.composition:back().selected_index == 0, "Henkan must highlight the first candidate")
press(env, 0xff23)
assert(context:get_option("_rime_henkan"), "repeated Henkan must keep candidate promotion")
context.input = ""
press(env, string.byte("k"))
assert(not context:get_option("katakana"), "next input must restore the prior kana mode after repeated Henkan")
assert(not context:get_option("_rime_henkan"), "next input must stop candidate promotion")
assert(context:get_option("_kagiroi_hide_candidates"), "next input must start hidden")

env, context = new_environment()
context.input = "かな"
context:set_option("hw_katakana", true)
press(env, 0xff23)
press(env, 0xff23)
assert(not context:get_option("hw_katakana"), "Henkan must use full-width katakana")
context.input = ""
press(env, string.byte("k"))
assert(context:get_option("hw_katakana"), "next input must restore the prior kana mode")

env, context, segment = new_environment({})
context.input = "k"
context:set_option("_kagiroi_hide_candidates", true)
local candidate_less_space = press(env, 0x20)
assert(candidate_less_space == kNoop, "Space on a candidate-less input must reach standard processors")
assert(context:get_option("_kagiroi_hide_candidates"), "a candidate-less input must stay hidden for later Spaces")

local henkan_candidate_less = press(env, 0xff23)
assert(henkan_candidate_less == kNoop, "Henkan on a candidate-less input must reach standard processors")
assert(context:get_option("_kagiroi_hide_candidates"), "Henkan on a candidate-less input must keep the menu hidden")
assert(not context:get_option("katakana"), "Henkan on a candidate-less input must not change kana mode")

env, context = new_environment()
context:set_option("ascii_mode", true)
local empty_henkan = press(env, 0xff23)
assert(empty_henkan == kNoop, "Henkan outside composition must pass through")
context.input = "かな"
local ascii_henkan = press(env, 0xff23)
assert(ascii_henkan == kNoop, "Henkan in ascii mode must pass through")
local modified_space = press(env, 0x20, { ctrl = true })
assert(modified_space == kNoop, "modified Space must pass through")
context:set_option("_kagiroi_hide_candidates", false)
assert(press(env, 0x20) == kNoop, "Space in ascii mode must pass through")
assert(press(env, 0xff0d) == kNoop, "Enter in ascii mode must pass through")

print("Rime candidate visibility and Henkan tests passed")
