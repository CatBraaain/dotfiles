local filter = dofile(arg[1])

local function candidate(text, comment)
    return {
        type = "phrase",
        text = text,
        comment = comment or "",
        to_shadow_candidate = function(self, kind, display, annotation)
            assert(kind == self.type and display == self.text)
            return { type = kind, text = display, comment = annotation, original = self }
        end,
    }
end

local function run_filter(hidden, candidates, expanded, offset)
    local produced = {}
    _G.yield = function(item)
        table.insert(produced, item)
    end
    local context = { options = {}, properties = { _kagiroi_page_offset = offset or "0" } }
    function context:get_option(name)
        if name == "_kagiroi_hide_candidates" then return hidden end
        return expanded or false
    end
    function context:get_property(name)
        return self.properties[name] or ""
    end
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

local candidates = {}
for index = 1, 65 do candidates[index] = candidate(tostring(index)) end
candidates[1].comment = "first note"
candidates[31].comment = "second note"

local hidden = run_filter(true, candidates)
assert(#hidden == 0, "the gate must yield no candidates while hiding is requested")

local collapsed = run_filter(false, candidates)
assert(#collapsed == 10 and collapsed[10] == candidates[10],
    "the initial list must expose at most ten candidates without changing their order")
assert(collapsed[1].comment == "first note Page 1" and collapsed[1].original == candidates[1],
    "the first candidate must retain its existing comment and show Page 1")
assert(collapsed[2] == candidates[2], "non-leading candidates must keep their comments and identity")

local expanded = run_filter(false, candidates, true)
assert(#expanded == 65 and expanded[65] == candidates[65],
    "expansion must retain all later pages in the final filter order")
assert(expanded[30] == candidates[30] and expanded[31].comment == "second note Page 2"
    and expanded[31].original == candidates[31],
    "the thirty-first displayed candidate must show Page 2 with its original comment")
assert(expanded[60] == candidates[60] and expanded[61].comment == "Page 3"
    and expanded[61].original == candidates[61],
    "the sixty-first displayed candidate must show Page 3")
assert(candidates[1].comment == "first note" and candidates[31].comment == "second note",
    "page comments must not modify the original translation")

local short = run_filter(false, { candidate("かな"), candidate("仮名") })
assert(#short == 2 and short[1].comment == "Page 1" and short[2].text == "仮名",
    "a short translation must show only the candidates that exist")

-- A collapsed window that skipped earlier candidates numbers its pages over
-- the whole final display order, not over the visible slice
-- (dotfiles/rime/SPEC.md, "候補一覧の見た目"). The stream emulates the
-- bunsetsu window: it yields only the eleventh through twentieth candidates.
local second_window = {}
for index = 11, 20 do second_window[#second_window + 1] = candidates[index] end
local crossed = run_filter(false, second_window, false, "10")
assert(#crossed == 10 and crossed[1].comment == "Page 2" and crossed[1].original == candidates[11],
    "the second collapsed window must show Page 2 on its first candidate")
assert(crossed[2] == candidates[12], "later candidates of a crossed window must stay unannotated")
local fourth_window = {}
for index = 31, 40 do fourth_window[#fourth_window + 1] = candidates[index] end
local late = run_filter(false, fourth_window, false, "30")
assert(late[1].comment == "second note Page 4",
    "the fourth collapsed window must show its final-order page number after the existing comment")
local crossed_note = run_filter(false, { candidate("かな", "既存") }, false, "10")
assert(crossed_note[1].comment == "既存 Page 2",
    "a crossed window must keep the candidate's existing comment before Page 2")

print("candidate gate filter tests passed")
