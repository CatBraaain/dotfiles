local kAccepted = 1
local kNoop = 2
package.preload["kagiroi/kagiroi_n_kana_speller"] = function()
    return { init = function() end, fini = function() end, func = function() return kNoop end }
end
package.preload["kagiroi/rime_controls"] = function()
    return dofile(arg[2])
end
local controls = require("kagiroi/rime_controls")
local processor = dofile(arg[1])
local context = { options = {}, input = "", commits = {} }
function context:get_option(name)
    return self.options[name] or false
end
function context:set_option(name, value)
    self.options[name] = value
end
local env = { engine = { context = context } }

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

assert(press() == kAccepted and context:get_option("ascii_mode"), "first Zenkaku_Hankaku must enable ascii mode")
assert(press() == kAccepted and not context:get_option("ascii_mode"), "second Zenkaku_Hankaku must restore Japanese mode")
for _, modifiers in ipairs({
    { release = true }, { shift = true }, { ctrl = true }, { alt = true }, { super = true },
    { keycode = string.byte("a") },
}) do
    assert(press(modifiers) == kNoop, "other key events must pass to ascii_composer")
    assert(not context:get_option("ascii_mode"), "other key events must leave ascii mode unchanged")
end

-- Switching to ascii mode stashes the composition unconfirmed instead of
-- committing it (dotfiles/rime/SPEC.md).
context.input = "かんじ"
context:set_option("_kagiroi_hide_candidates", false)
assert(press() == kAccepted, "Zenkaku_Hankaku with a composition must be consumed")
assert(#context.commits == 0, "switching to ascii mode must not commit the composition")
assert(context.input == "", "switching to ascii mode must hide the composition")
assert(controls.kept.input == "かんじ", "switching to ascii mode must stash the composition")
assert(context:get_option("_kagiroi_hide_candidates"),
    "switching to ascii mode must hide candidates for the return")
assert(context:get_option("ascii_mode"), "Zenkaku_Hankaku must enable ascii mode after the stash")

-- Switching back restores the stashed composition.
assert(press() == kAccepted and not context:get_option("ascii_mode"),
    "Zenkaku_Hankaku must restore Japanese mode")
assert(context.input == "かんじ", "switching back must restore the stashed composition")
assert(controls.kept.input == nil, "switching back must drop the stash")
assert(#context.commits == 0, "the round trip must not commit")

-- A stash cleared elsewhere (a commit) leaves the return clean.
context.input = "かな"
assert(press() == kAccepted and context:get_option("ascii_mode"),
    "the second stash must enable ascii mode")
controls.kept.input = nil
assert(press() == kAccepted and not context:get_option("ascii_mode"),
    "Zenkaku_Hankaku must restore Japanese mode without a stash")
assert(context.input == "" and #context.commits == 0,
    "the return must stay idle without a stash")

print("Rime ascii mode toggle tests passed")
