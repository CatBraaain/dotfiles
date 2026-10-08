-- ascii_composer switch key assignment for the managed default.custom.yaml
-- (dotfiles/rime/SPEC.md, "切替キー"): IME ON/OFF switching stays limited to
-- Muhenkan (the managed Lua) and Zenkaku_Hankaku; Caps_Lock, Eisu_toggle and
-- a lone Shift must not switch modes and pass Rime untouched. Static checks
-- are used because the librime harness cannot observe the switch table in
-- isolation.
local path = arg[1]
assert(path, "usage: lua5.4 tests/default_config.test.lua default.custom.yaml")

local switch_keys = {}
for line in io.lines(path) do
    local key, value = line:match(
        '^%s*"?(ascii_composer/switch_key/[^":%s]+)"?%s*:%s*([^%s#]+)')
    if key then
        assert(switch_keys[key] == nil,
            "switch key " .. key .. " must be assigned exactly once")
        switch_keys[key] = value
    end
end

local expected = {
    ["ascii_composer/switch_key/Zenkaku_Hankaku"] = "clear",
    ["ascii_composer/switch_key/Shift_L"] = "noop",
    ["ascii_composer/switch_key/Shift_R"] = "noop",
    ["ascii_composer/switch_key/Caps_Lock"] = "noop",
    ["ascii_composer/switch_key/Eisu_toggle"] = "noop",
}
for key, value in pairs(expected) do
    assert(switch_keys[key] == value,
        key .. " must be " .. value .. ", got " .. tostring(switch_keys[key]))
end
for key in pairs(switch_keys) do
    assert(expected[key] ~= nil, "unexpected switch key assignment: " .. key)
end

print("Rime default config tests passed")
