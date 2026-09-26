local filter = dofile(arg[1])

local function run_filter(hidden, candidates)
    local produced = {}
    _G.yield = function(candidate)
        table.insert(produced, candidate)
    end
    local context = { get_option = function(_, _) return hidden end }
    local translation = {
        iter = function(_)
            local index = 0
            return function()
                index = index + 1
                return candidates[index]
            end
        end,
    }
    filter.func(translation, { engine = { context = context } })
    return produced
end

local hidden = run_filter(true, { "かな", "仮名" })
assert(#hidden == 0, "the gate must yield no candidates while hiding is requested")

local revealed = run_filter(false, { "かな", "仮名" })
assert(revealed[1] == "かな" and revealed[2] == "仮名",
    "the gate must keep every candidate and its order when revealing")

print("candidate gate filter tests passed")
