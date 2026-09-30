local kAccepted = 1
local kNoop = 2
package.preload["kagiroi/kagiroi_n_kana_speller"] = function()
    return { init = function() end, fini = function() end, func = function() return kNoop end, ascii_tail = nil }
end
package.preload["kagiroi/rime_controls"] = function()
    return dofile(arg[2])
end
local controls = require("kagiroi/rime_controls")
local kana_speller = require("kagiroi/kagiroi_n_kana_speller")
local processor = dofile(arg[1])
local context = { options = {}, input = "", commits = {} }
function context:get_option(name)
    return self.options[name] or false
end
function context:set_option(name, value)
    self.options[name] = value
end
local env = { engine = { context = context } }
controls.init(env)

local function press(modifiers)
    modifiers = modifiers or {}
    return processor.func({
        keycode = modifiers.keycode or 0xff2a,
        release = function() return modifiers.release or false end,
        shift = function() return modifiers.shift or false end,
        ctrl = function() return modifiers.ctrl or false end,
        alt = function() return modifiers.alt or false end,
        super = function() return modifiers.super or false end,
    }, env)
end

-- Zenkaku_Hankaku toggles the unconfirmed ascii input mode.
assert(press() == kAccepted and context:get_option("_kagiroi_ascii_input"),
    "first Zenkaku_Hankaku must enter the ascii input mode")
assert(press() == kAccepted and not context:get_option("_kagiroi_ascii_input"),
    "second Zenkaku_Hankaku must restore the Japanese mode")
for _, modifiers in ipairs({
    { release = true }, { shift = true }, { ctrl = true }, { alt = true }, { super = true },
    { keycode = string.byte("a") },
}) do
    assert(press(modifiers) == kNoop, "other key events must pass to the Japanese mode")
    assert(not context:get_option("_kagiroi_ascii_input"),
        "other key events must leave the ascii input mode unchanged")
end

-- Entering the ascii input mode keeps the composition unconfirmed and
-- records the tail position (dotfiles/rime/SPEC.md).
context.input = "かんじ"
context:set_option("_kagiroi_hide_candidates", false)
assert(press() == kAccepted, "Zenkaku_Hankaku with a composition must be consumed")
assert(#context.commits == 0, "entering the ascii input mode must not commit")
assert(context.input == "かんじ", "entering the ascii input mode must keep the composition")
assert(context:get_option("_kagiroi_hide_candidates"),
    "entering the ascii input mode must hide the candidate list")
assert(context:get_option("_kagiroi_ascii_input"),
    "Zenkaku_Hankaku must enter the ascii input mode")
assert(kana_speller.ascii_tail == #context.input,
    "entering the ascii input mode must record the tail position")

-- Returning to the Japanese mode keeps the composition and the tail.
assert(press() == kAccepted and not context:get_option("_kagiroi_ascii_input"),
    "Zenkaku_Hankaku must restore the Japanese mode")
assert(context.input == "かんじ", "the return must keep the composition")
assert(kana_speller.ascii_tail == #context.input, "the return must keep the tail position")
assert(#context.commits == 0, "the round trip must not commit")

-- Muhenkan always enters the ascii input mode and keeps the composition
-- unconfirmed like Zenkaku_Hankaku. Hiragana_Katakana is unbound: the key
-- passes through without touching the mode or the tail
-- (dotfiles/rime/SPEC.md).
local kHiraganaKatakana = 0xff27
local kMuhenkan = 0xff22
context.input = "にほんご"
press({ keycode = kMuhenkan })
assert(context:get_option("_kagiroi_ascii_input"),
    "Muhenkan must always enter the ascii input mode")
assert(context.input == "にほんご" and #context.commits == 0,
    "Muhenkan must keep the composition unconfirmed")
assert(kana_speller.ascii_tail == #context.input, "Muhenkan must record the tail position")
press({ keycode = kMuhenkan })
assert(context:get_option("_kagiroi_ascii_input"),
    "a second Muhenkan must stay in the ascii input mode")
assert(press({ keycode = kHiraganaKatakana }) == kNoop,
    "Hiragana_Katakana must pass through unbound")
assert(context:get_option("_kagiroi_ascii_input") and context.input == "にほんご",
    "Hiragana_Katakana must leave the ascii input mode and the composition unchanged")

print("Rime ascii input mode toggle tests passed")
