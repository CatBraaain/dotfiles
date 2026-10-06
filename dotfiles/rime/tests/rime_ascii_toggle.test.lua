package.path = arg[2]:match("^(.*)/kagiroi/") .. "/?.lua;" .. package.path
local kAccepted = 1
local kNoop = 2
-- The generated key → text mappings are a build artifact (arg[3],
-- lua/kagiroi/zenkaku_text.lua), not a repository file.
package.preload["kagiroi/zenkaku_text"] = function() return dofile(arg[3]) end
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
function context:get_property() return "" end
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

-- Zenkaku_Hankaku and Muhenkan with nothing unconfirmed switch IME OFF
-- through the ascii_mode option instead of entering the mode
-- (dotfiles/rime/SPEC.md).
assert(press() == kAccepted, "idle Zenkaku_Hankaku must be consumed")
assert(context:get_option("ascii_mode"), "idle Zenkaku_Hankaku must switch IME OFF")
assert(not context:get_option("_kagiroi_ascii_input"),
    "idle Zenkaku_Hankaku must not enter the ascii input mode")
for _, modifiers in ipairs({
    { release = true }, { shift = true }, { ctrl = true }, { alt = true }, { super = true },
    { keycode = 0xff22 }, { keycode = string.byte("a") }, { keycode = string.byte("1") },
    { keycode = string.byte(".") }, { keycode = string.byte(" ") },
}) do
    assert(press(modifiers) == kNoop, "other key events in IME OFF must pass through")
    assert(context:get_option("ascii_mode"), "other key events must keep IME OFF")
    assert(not context:get_option("_kagiroi_ascii_input") and context.input == "",
        "other key events in IME OFF must not create a composition")
    assert(#context.commits == 0, "other key events in IME OFF must not commit")
end
assert(press() == kAccepted, "a second idle Zenkaku_Hankaku must be consumed")
assert(not context:get_option("ascii_mode"), "a second idle Zenkaku_Hankaku must restore Japanese input")
assert(not context:get_option("_kagiroi_ascii_input") and context.input == "",
    "the idle round trip must not enter the ascii input mode or create a composition")
assert(#context.commits == 0, "the idle round trip must not commit")

assert(press({ keycode = 0xff22 }) == kAccepted, "idle Muhenkan must be consumed")
assert(context:get_option("ascii_mode"), "idle Muhenkan must switch IME OFF")
assert(not context:get_option("_kagiroi_ascii_input"),
    "idle Muhenkan must not enter the ascii input mode")
assert(press({ keycode = 0xff22 }) == kNoop, "Muhenkan in IME OFF must pass through")
assert(context:get_option("ascii_mode"), "Muhenkan in IME OFF must keep IME OFF")
assert(press() == kAccepted, "Zenkaku_Hankaku must return from Muhenkan's IME OFF")
assert(not context:get_option("ascii_mode"), "Zenkaku_Hankaku must restore Japanese input")

for _, modifiers in ipairs({
    { release = true }, { shift = true }, { ctrl = true }, { alt = true }, { super = true },
    { keycode = string.byte("a") },
}) do
    assert(press(modifiers) == kNoop, "other key events must pass to the Japanese mode")
    assert(not context:get_option("_kagiroi_ascii_input"),
        "other key events must leave the ascii input mode unchanged")
end

-- Entering the ascii input mode keeps the composition unconfirmed and
-- records the tail position and an independent OFF reservation
-- (dotfiles/rime/SPEC.md).
context.input = "かんじ"
context:set_option("_kagiroi_hide_candidates", false)
assert(press() == kAccepted, "Zenkaku_Hankaku with a composition must be consumed")
assert(#context.commits == 0, "entering the ascii input mode must not commit")
assert(context.input == "かんじ", "entering the ascii input mode must keep the composition")
assert(not context:get_option("_kagiroi_hide_candidates"),
    "entering the ascii input mode must preserve candidate visibility")
assert(context:get_option("_kagiroi_ascii_input"),
    "Zenkaku_Hankaku must enter the ascii input mode")
assert(kana_speller.ascii_tail == #context.input,
    "entering the ascii input mode must record the tail position")
assert(context:get_option("_kagiroi_off_pending"),
    "entering by Zenkaku_Hankaku must reserve IME OFF")

-- Returning to the Japanese mode keeps the composition and the tail, and
-- preserves the OFF reservation.
assert(press() == kAccepted and not context:get_option("_kagiroi_ascii_input"),
    "Zenkaku_Hankaku must restore the Japanese mode")
assert(context.input == "かんじ", "the return must keep the composition")
assert(kana_speller.ascii_tail == #context.input, "the return must keep the tail position")
assert(#context.commits == 0, "the round trip must not commit")
assert(context:get_option("_kagiroi_off_pending"),
    "returning to Japanese input must preserve the OFF reservation")

-- Muhenkan enters the mode from the Japanese input like Zenkaku_Hankaku and
-- reserves IME OFF. Hiragana_Katakana is unbound: the key passes
-- through without touching the mode or the tail
-- (dotfiles/rime/SPEC.md).
local kHiraganaKatakana = 0xff27
local kMuhenkan = 0xff22
context.input = "にほんご"
press({ keycode = kMuhenkan })
assert(context:get_option("_kagiroi_ascii_input"),
    "Muhenkan must enter the ascii input mode from a composition")
assert(context.input == "にほんご" and #context.commits == 0,
    "Muhenkan must keep the composition unconfirmed")
assert(kana_speller.ascii_tail == #context.input, "Muhenkan must record the tail position")
assert(context:get_option("_kagiroi_off_pending"), "Muhenkan must reserve IME OFF")
assert(press({ keycode = kMuhenkan }) == kAccepted,
    "Muhenkan inside the mode must reserve IME OFF")
assert(context:get_option("_kagiroi_ascii_input") and context.input == "にほんご",
    "the in-mode Muhenkan must leave the mode and the composition unchanged")
assert(press({ keycode = kHiraganaKatakana }) == kNoop,
    "Hiragana_Katakana must pass through unbound")
assert(context:get_option("_kagiroi_ascii_input") and context.input == "にほんご",
    "Hiragana_Katakana must leave the ascii input mode and the composition unchanged")
press()
assert(not context:get_option("_kagiroi_ascii_input"),
    "Zenkaku_Hankaku must restore the Japanese mode from Muhenkan's entry")

print("Rime ascii input mode toggle tests passed")
