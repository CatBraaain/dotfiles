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

local function new_environment()
    local context = { input = "", options = {}, selected_index = 1 }
    function context:has_menu()
        return self.input ~= ""
    end
    function context:get_option(name)
        return self.options[name] or false
    end
    function context:set_option(name, value)
        self.options[name] = value
    end
    function context:highlight(index)
        self.selected_index = index
    end
    local env = { engine = { context = context } }
    processor.init(env)
    return env, context
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

local env, context = new_environment()
press(env, string.byte("k"))
assert(context:get_option("_hide_candidate"), "typing must hide candidates")
context.input = "か"
local first_space = press(env, 0x20)
assert(first_space == kAccepted, "first Space must be consumed")
assert(not context:get_option("_hide_candidate"), "first Space must reveal candidates")
local second_space = press(env, 0x20)
assert(second_space == kNoop, "subsequent Space must reach standard processors")
context.input = ""
press(env, string.byte("n"))
assert(context:get_option("_hide_candidate"), "next input must hide candidates again")

local before_henkan = calls
context.input = "かな"
local henkan = press(env, 0xff23)
assert(henkan == kAccepted, "Henkan must be consumed without committing")
assert(calls == before_henkan, "Henkan must not reach the kana speller")
assert(context.input == "かな", "Henkan must leave composition intact")
assert(context:get_option("katakana"), "Henkan must enable full-width katakana")
assert(context:get_option("_weasel_henkan"), "Henkan must enable candidate promotion")
assert(context.selected_index == 0, "Henkan must highlight the first candidate")
press(env, 0xff23)
assert(context:get_option("_weasel_henkan"), "repeated Henkan must keep candidate promotion")
context.input = ""
press(env, string.byte("k"))
assert(not context:get_option("katakana"), "next input must restore the prior kana mode after repeated Henkan")
assert(not context:get_option("_weasel_henkan"), "next input must stop candidate promotion")
assert(context:get_option("_hide_candidate"), "next input must start hidden")

env, context = new_environment()
context.input = "かな"
context:set_option("hw_katakana", true)
press(env, 0xff23)
press(env, 0xff23)
assert(not context:get_option("hw_katakana"), "Henkan must use full-width katakana")
context.input = ""
press(env, string.byte("k"))
assert(context:get_option("hw_katakana"), "next input must restore the prior kana mode")

env, context = new_environment()
context:set_option("ascii_mode", true)
local empty_henkan = press(env, 0xff23)
assert(empty_henkan == kNoop, "Henkan outside composition must pass through")
context.input = "かな"
local ascii_henkan = press(env, 0xff23)
assert(ascii_henkan == kNoop, "Henkan in ascii mode must pass through")
local modified_space = press(env, 0x20, { ctrl = true })
assert(modified_space == kNoop, "modified Space must pass through")

print("Weasel candidate visibility and Henkan tests passed")
