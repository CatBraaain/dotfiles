-- Per-context clause choices, the active-clause menu and the full preview.
local Top = {}
local sessions = {}
local next_session = 0
local stock
local variants = require("kagiroi/char_variants")

function Top.init(env)
    stock = stock or require("kagiroi/kagiroi_translator")
    stock.init(env)
    next_session = next_session + 1
    env.session_id = tostring(next_session)
    env.engine.context:set_property("_kagiroi_bunsetsu_session", env.session_id)
    sessions[env.session_id] = env
    local context = env.engine.context
    env.option_connection = context.option_update_notifier:connect(function(_, option)
        if option == "emoji" and env.conversion then
            for _, clause in ipairs(env.conversion.clauses) do
                clause.filtered = false
            end
            Top.render(context)
        end
    end)
end

function Top.fini(env)
    env.option_connection:disconnect()
    sessions[env.session_id] = nil
    stock.fini(env)
end

local function session(context)
    return sessions[context:get_property("_kagiroi_bunsetsu_session")]
end

function Top.state(context)
    local env = session(context)
    return env and env.conversion
end

function Top.clear(context)
    local env = session(context)
    if env then env.conversion = nil end
end

local function choice_candidate(choice, seg, env)
    if not choice.entry then
        return Candidate("kagiroi", seg.start, seg._end, choice.text, choice.comment or "")
    end
    local candidate = Phrase(env.mem, "kagiroi_lex", seg.start, seg._end, choice.entry):toCandidate()
    return ShadowCandidate(candidate, "kagiroi", choice.text, choice.comment or "")
end

local function save_filtered(clause, translation)
    local previous = clause.candidates[clause.selected]
    local candidates, seen = {}, {}
    for candidate in translation:iter() do
        if not seen[candidate.text] then
            seen[candidate.text] = true
            local genuine = candidate:get_genuine()
            local phrase = genuine:to_phrase()
            candidates[#candidates + 1] = {
                text = candidate.text,
                comment = candidate.comment,
                source_text = genuine.text,
                entry = phrase and DictEntry(phrase.entry),
            }
        end
    end
    clause.candidates, clause.selected, clause.filtered = candidates, 1, true
    if previous then
        for index, choice in ipairs(candidates) do
            if choice.text == previous.text and choice.source_text == previous.source_text then
                clause.selected = index
                return
            end
        end
        for index, choice in ipairs(candidates) do
            if choice.source_text == previous.source_text then
                clause.selected = index
                return
            end
        end
    end
end

local function new_clause(reading, env)
    local seg = Segment(0, #reading)
    seg.tags = Set({ env.tag })
    local candidates, seen = {}, {}
    env.viterbi:analyze(reading)
    local has_dictionary_path = env.viterbi:best_n()() ~= nil
    local katakana = env.hira2kata_opencc():convert(reading)
    local function collect(translator)
        local iter = coroutine.wrap(function() translator(reading, seg, env) end)
        for candidate in iter do
            if candidate._end == #reading and not seen[candidate.text] then
                local phrase = candidate:get_genuine():to_phrase()
                local dummy = not has_dictionary_path and phrase
                    and (candidate.text == reading or candidate.text == katakana)
                if not dummy then
                    seen[candidate.text] = true
                    candidates[#candidates + 1] = {
                        text = candidate.text,
                        comment = candidate.comment,
                        entry = phrase and DictEntry(phrase.entry),
                    }
                end
            end
        end
    end
    collect(stock.func)
    collect(variants.func)
    if #candidates == 0 then candidates[1] = { text = reading } end
    return { reading = reading, unfiltered = candidates, candidates = candidates, selected = 1 }
end

local function is_kana(codepoint)
    return codepoint >= 0x3040 and codepoint <= 0x30ff
end

local function split(reading, env)
    local clauses = {}
    local position = 1
    while position <= #reading do
        local kana = is_kana(utf8.codepoint(reading, position))
        local run_end = position
        for offset, codepoint in utf8.codes(reading:sub(position)) do
            if is_kana(codepoint) ~= kana then break end
            run_end = position + offset - 1 + #utf8.char(codepoint)
        end
        local remaining = reading:sub(position, run_end - 1)
        while remaining ~= "" do
            local prefix = remaining
            if kana then
                env.viterbi:analyze(remaining)
                local lex = env.viterbi:best_n_prefix()()
                if lex and lex.surface ~= "" then prefix = lex.surface end
            end
            clauses[#clauses + 1] = new_clause(prefix, env)
            remaining = remaining:sub(#prefix + 1)
        end
        position = run_end
    end
    return clauses
end

function Top.start(context, reading, katakana)
    local env = session(context)
    local clauses = katakana and { new_clause(reading, env) } or split(reading, env)
    if katakana then clauses[1].override = katakana end
    env.conversion = { reading = reading, clauses = clauses, active = 1, henkan = katakana ~= nil }
    Top.render(context)
    return env.conversion
end

function Top.sync(context)
    local state = Top.state(context)
    if not state or context:get_option("_kagiroi_hide_candidates") then return end
    local segment = context.composition:back()
    if segment and context:has_menu() then
        state.clauses[state.active].selected = state.window_start + segment.selected_index + 1
    end
end

function Top.display(context)
    Top.sync(context)
    local state = Top.state(context)
    local parts = {}
    for _, clause in ipairs(state.clauses) do
        parts[#parts + 1] = clause.override or clause.candidates[clause.selected].text
    end
    return table.concat(parts)
end

function Top.render(context)
    local state = Top.state(context)
    local active_index = state.active
    for index, clause in ipairs(state.clauses) do
        if not clause.filtered then
            state.active = index
            state.active_start, state.active_end = 0, #clause.reading
            state.window_start = 0
            state.collecting = true
            context.input = ""
            context.input = clause.reading
            state.collecting = false
        end
    end
    state.active = active_index
    local hidden = context:get_option("_kagiroi_hide_candidates")
    local prefix, suffix = {}, {}
    for index, clause in ipairs(state.clauses) do
        local text = clause.override or clause.candidates[clause.selected].text
        if index < state.active then prefix[#prefix + 1] = text end
        if index > state.active then suffix[#suffix + 1] = text end
    end
    local clause = state.clauses[state.active]
    local active = hidden and (clause.override or clause.candidates[clause.selected].text) or clause.reading
    state.active_start = #table.concat(prefix)
    state.active_end = state.active_start + #active
    state.layout = table.concat(prefix) .. active .. table.concat(suffix)
    state.window_start = context:get_option("_kagiroi_expand_candidates") and 0
        or math.floor((clause.selected - 1) / 10) * 10
    context.input = ""
    context.input = state.layout
    local segment = context.composition:back()
    if not hidden and segment and context:has_menu() then
        local index = clause.selected - state.window_start - 1
        if type(context.highlight) == "function" then context:highlight(index)
        else segment.selected_index = index end
    end
end

function Top.move(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    state.active = math.max(1, math.min(#state.clauses, state.active + direction))
    Top.render(context)
end

function Top.resize(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    local index = state.active
    local left, right = state.clauses[index], state.clauses[index + 1]
    local left_reading, right_reading = left.reading, right and right.reading or ""
    if direction < 0 then
        if utf8.len(left_reading) == 1 then return end
        local last = utf8.offset(left_reading, -1)
        right_reading = left_reading:sub(last) .. right_reading
        left_reading = left_reading:sub(1, last - 1)
    else
        if not right then return end
        local second = utf8.offset(right_reading, 2) or (#right_reading + 1)
        left_reading = left_reading .. right_reading:sub(1, second - 1)
        right_reading = right_reading:sub(second)
    end
    local env = session(context)
    state.clauses[index] = new_clause(left_reading, env)
    if right_reading == "" then table.remove(state.clauses, index + 1)
    elseif right then state.clauses[index + 1] = new_clause(right_reading, env)
    else table.insert(state.clauses, index + 1, new_clause(right_reading, env)) end
    state.henkan = false
    Top.render(context)
end

function Top.select(context, direction, arrows)
    Top.sync(context)
    local state = Top.state(context)
    local clause = state.clauses[state.active]
    local first, count = 1, #clause.candidates
    if arrows and not context:get_option("_kagiroi_expand_candidates") then
        first = state.window_start + 1
        count = math.min(10, count - state.window_start)
    end
    clause.selected = first + (clause.selected - first + direction) % count
    clause.override = nil
    Top.render(context)
end

function Top.page(context, direction)
    Top.sync(context)
    local state = Top.state(context)
    if not context:get_option("_kagiroi_expand_candidates") then return end
    local clause = state.clauses[state.active]
    local page = math.floor((clause.selected - 1) / 30) + direction
    local last_page = math.floor((#clause.candidates - 1) / 30)
    clause.selected = math.min(#clause.candidates,
        math.max(0, math.min(last_page, page)) * 30 + (clause.selected - 1) % 30 + 1)
    Top.render(context)
end

function Top.learn(context)
    Top.sync(context)
    local env = session(context)
    for _, clause in ipairs(env.conversion.clauses) do
        local entry = not clause.override and clause.candidates[clause.selected].entry
        if entry then env.mem:update_userdict(entry, 1, "") end
    end
    env.viterbi:clear()
end

function Top.segment(segmentation, env)
    local state = Top.state(env.engine.context)
    if not state then return true end
    local start = segmentation:get_current_start_position()
    if start >= state.active_end then return false end
    local finish = start < state.active_start and state.active_start or state.active_end
    local segment = Segment(start, finish)
    segment.tags = Set({ start < state.active_start and "bunsetsu_fixed" or "bunsetsu_active" })
    segmentation:add_segment(segment)
    return false
end

function Top.func(input, seg, env)
    local state = env.conversion
    if not state then
        if utf8.len(input) then return stock.func(input, seg, env) end
        return
    end
    if not seg:has_tag("bunsetsu_active") then return end
    for _, choice in ipairs(state.clauses[state.active].unfiltered) do
        yield(choice_candidate(choice, seg, env))
    end
end

-- Uniquifier checks the Menu's emitted candidates, so eagerly collecting
-- the complete stream also needs text deduplication before windowing it.
-- Stored choices retain their genuine dictionary entries, including emoji.
Top.filter = {
    tags_match = function(seg, env)
        env.segment = seg
        return seg:has_tag("bunsetsu_active")
    end,
    func = function(translation, env)
        local context = env.engine.context
        local state = Top.state(context)
        local clause = state.clauses[state.active]
        save_filtered(clause, translation)
        local first = state.collecting and 1 or state.window_start + 1
        local last = context:get_option("_kagiroi_expand_candidates") and #clause.candidates
            or math.min(#clause.candidates, first + 9)
        for index = first, last do
            yield(choice_candidate(clause.candidates[index], env.segment, session(context)))
        end
    end,
}

return Top
