-- fcitx5-rime client preedit and platform placement contract
-- (dotfiles/rime/SPEC.md). Static checks are used because this test does not
-- launch fcitx5 or inspect the frontend.
local config_path = arg[1]
local remap_path = arg[2]
assert(config_path and remap_path,
    "usage: lua5.4 tests/fcitx5_config.test.lua <rime.conf> <remap.data.md>")

local config = assert(io.open(config_path, "rb"))
local config_contents = config:read("*a")
config:close()
assert(config_contents == "PreeditMode=Commit preview\n",
    "rime.conf must contain only the unsectioned PreeditMode=Commit preview setting")

local remap_row
for line in io.lines(remap_path) do
    local cells = {}
    for cell in line:gmatch("[^|]+") do
        cells[#cells + 1] = cell:match("^%s*(.-)%s*$")
    end
    if cells[1] == "fcitx5" then
        assert(remap_row == nil, "fcitx5 remap must be unique")
        remap_row = cells
    end
end

assert(remap_row, "fcitx5 remap must exist in " .. remap_path)
assert(remap_row[2] == ".config/fcitx5",
    "fcitx5 Linux destination must be .config/fcitx5")
assert(remap_row[3] == "-", "fcitx5 must be removed on Windows")
assert(remap_row[4] == "-", "fcitx5 must be removed on macOS")

print("Rime fcitx5 config tests passed")
