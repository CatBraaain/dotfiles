local kAccepted = 1
local kNoop = 2
local processor = dofile(arg[1])
local context = { options = {}, input = "", commits = {} }
function context:get_option(name)
    return self.options[name] or false
end
function context:set_option(name, value)
    self.options[name] = value
end
function context:commit()
    table.insert(self.commits, self.input)
    self.input = ""
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

-- Switching to ascii mode confirms the unconfirmed composition first.
context.input = "かんじ"
context:set_option("_kagiroi_hide_candidates", false)
assert(press() == kAccepted, "Zenkaku_Hankaku with a composition must be consumed")
assert(context.commits[1] == "かんじ", "switching to ascii mode must commit the composition")
assert(context.input == "", "switching to ascii mode must end the composition")
assert(context:get_option("_kagiroi_hide_candidates"),
    "switching to ascii mode must hide candidates for the next input")
assert(context:get_option("ascii_mode"), "Zenkaku_Hankaku must enable ascii mode after the commit")

-- Switching back keeps working and leaves the clean state alone.
assert(press() == kAccepted and not context:get_option("ascii_mode"),
    "Zenkaku_Hankaku must restore Japanese mode")
assert(#context.commits == 1, "switching back without a composition must not commit")

print("Rime ascii mode toggle tests passed")
