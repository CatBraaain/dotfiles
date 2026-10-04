-- fcitx5-rime client preedit, frontend Muhenkan boundary and platform
-- placement contract (dotfiles/rime/SPEC.md, "配置"). Static checks are used
-- because this test does not launch fcitx5 or inspect the frontend.
local config_path = arg[1]
local remap_path = arg[2]
assert(config_path and remap_path,
    "usage: lua5.4 tests/fcitx5_config.test.lua <rime.conf> <remap.data.md>")

local config = assert(io.open(config_path, "rb"))
local config_contents = config:read("*a")
config:close()
assert(config_contents == "PreeditMode=Commit preview\n",
    "rime.conf must contain only the unsectioned PreeditMode=Commit preview setting")

-- The Muhenkan frontend deactivation lives next to conf/rime.conf in the
-- same remapped fcitx5 entry: dotfiles/fcitx5/config -> ~/.config/fcitx5/config.
local entry_root = config_path:match("^(.*)/[^/]+/[^/]+$")
assert(entry_root, "cannot locate the fcitx5 entry from " .. config_path)
local deactivate_keys
local section
for line in io.lines(entry_root .. "/config") do
    local heading = line:match("^%s*%[([^%]]+)%]%s*$")
    if heading then
        section = heading
    elseif section == "Behavior" then
        local key, value = line:match("^%s*([%w]+)%s*=%s*(%S.*)$")
        if key == "DeactivateKeys" then deactivate_keys = value end
    end
end
assert(deactivate_keys == "Muhenkan",
    "fcitx5/config must assign Muhenkan to input method deactivation, got "
    .. tostring(deactivate_keys))

local remap_rows = {}
for line in io.lines(remap_path) do
    local cells = {}
    for cell in line:gmatch("[^|]+") do
        cells[#cells + 1] = cell:match("^%s*(.-)%s*$")
    end
    if cells[1] == "fcitx5" or cells[1] == "rime" then
        assert(remap_rows[cells[1]] == nil, cells[1] .. " remap must be unique")
        remap_rows[cells[1]] = cells
    end
end

local fcitx5_row = assert(remap_rows["fcitx5"], "fcitx5 remap must exist in " .. remap_path)
assert(fcitx5_row[2] == ".config/fcitx5",
    "fcitx5 Linux destination must be .config/fcitx5")
assert(fcitx5_row[3] == "-", "fcitx5 must be removed on Windows")
assert(fcitx5_row[4] == "-", "fcitx5 must be removed on macOS")

-- SPEC "配置": the same Rime user data directory on Windows and Linux.
local rime_row = assert(remap_rows["rime"], "rime remap must exist in " .. remap_path)
assert(rime_row[2] == ".local/share/fcitx5/rime",
    "Rime Linux destination must be .local/share/fcitx5/rime")
assert(rime_row[3] == "AppData/Roaming/Rime",
    "Rime Windows destination must be AppData/Roaming/Rime")

print("Rime fcitx5 config tests passed")
