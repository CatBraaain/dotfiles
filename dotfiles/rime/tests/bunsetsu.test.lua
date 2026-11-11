local test_dir = arg[0]:match("^(.*)/")
local bunsetsu_path = arg[1]
package.path = test_dir .. "/probe/fixed/?.lua;" .. test_dir .. "/probe/?.lua;"
    .. bunsetsu_path:match("^(.*)/kagiroi/") .. "/?.lua;" .. package.path

local synth = require("viterbi_synth_env")
synth.install_globals()
local viterbi_module = require("kagiroi/kagiroi_viterbi")

_G.yield = coroutine.yield
_G.Translation = function(func)
    return { iter = function() return coroutine.wrap(func) end }
end
_G.Set = function(tags) return tags end
_G.Segment = function(start, finish)
    return { start = start, _end = finish, has_tag = function() return true end }
end
_G.Candidate = function(kind, start, finish, text, comment)
    local candidate = { type = kind, start = start, _end = finish, text = text, comment = comment }
    function candidate:get_genuine() return self end
    function candidate:to_phrase() return self.phrase and { entry = self.phrase } or nil end
    return candidate
end
_G.ShadowCandidate = function(candidate, kind, text, comment)
    local shadow = { type = kind, text = text, comment = comment, start = candidate.start, _end = candidate._end }
    function shadow:get_genuine() return candidate end
    function shadow:to_phrase() return candidate:to_phrase() end
    return shadow
end
_G.DictEntry = function(copy)
    return copy and { text = copy.text, custom_code = copy.custom_code }
        or { text = "", custom_code = "" }
end
_G.Phrase = function(mem, tag, start, finish, entry)
    return {
        toCandidate = function()
            local candidate = Candidate("kagiroi", start, finish, entry.text, "")
            candidate.phrase = entry
            return candidate
        end,
    }
end

local function new_engine(dictionary, matrix, readings, expand_emoji, boundary, userdict)
    local synth_env = synth.new_env(dictionary, userdict, matrix)
    local viterbi = viterbi_module.new(synth_env)
    package.loaded["kagiroi/segmenter"] = nil
    package.loaded["kagiroi/kagiroi_translator"] = nil
    package.loaded["kagiroi/char_variants"] = nil
    package.preload["kagiroi/kagiroi_translator"] = nil
    package.preload["kagiroi/segmenter"] = function()
        return { is_boundary_internal = function(right_id, left_id)
            if right_id == 0 or left_id == 0 then return true end
            if boundary then return boundary(right_id, left_id) end
            if right_id == 1926 and left_id == 368 then return false end
            if right_id == 368 and left_id == 368 then return false end
            return matrix[right_id .. " " .. left_id] ~= nil
        end }
    end
    package.preload["kagiroi/kagiroi_translator"] = function()
        return {
            init = function(env)
                env.tag = "kagiroi"
                env.hira2kata_opencc = function() return { convert = function(_, text) return synth.hira2kata(text) end } end
                env.mem = synth_env.mem
                env.viterbi = viterbi
            end,
            fini = function() end,
            func = function(input, seg, env)
                if type(readings[input]) == "function" then return readings[input](seg, env) end
                for _, offered in ipairs(readings[input] or {}) do
                    local candidate = Candidate("kagiroi", seg.start, seg._end, offered.text, "")
                    candidate.phrase = offered.phrase
                    yield(candidate)
                end
            end,
        }
    end
    local bunsetsu = dofile(bunsetsu_path)
    local segment = { selected_index = 0 }
    local context = { options = {}, properties = {} }
    function context:get_property(name) return self.properties[name] or "" end
    function context:set_property(name, value) self.properties[name] = value end
    context.option_update_notifier = { connect = function() return { disconnect = function() end } end }
    context.composition = { back = function() return segment end }
    function segment:get_candidate_at(index)
        local state = bunsetsu.state(context)
        if state then
            local clause = state.clauses[state.active]
            return clause.candidates[state.window_start + index + 1]
        end
        return nil
    end
    function context:has_menu()
        return self.input ~= "" and not self.options._kagiroi_hide_candidates
            and segment:get_candidate_at(0) ~= nil
    end
    function context:get_option(name) return self.options[name] or false end
    function context:set_option(name, value) self.options[name] = value end
    function context:highlight(index)
        if segment:get_candidate_at(index) then segment.selected_index = index end
    end
    setmetatable(context, {
        __newindex = function(table, key, value)
            if key == "input" then
                rawset(table, "_input", value)
                local state = bunsetsu.state(table)
                if value ~= "" and state then
                    local seg = Segment(state.active_start, state.active_end)
                    local translation = Translation(function()
                        for candidate in coroutine.wrap(function()
                            bunsetsu.func(value, seg, table.translator_env)
                        end) do
                            yield(candidate)
                            if type(expand_emoji) == "function" then
                                expand_emoji(candidate)
                            elseif expand_emoji and candidate.text == "朱" then
                                yield(ShadowCandidate(candidate, "simplified", "🔴", ""))
                            end
                        end
                    end)
                    local filter_env = { engine = table.translator_env.engine, segment = seg }
                    if bunsetsu.filter.tags_match(seg, filter_env) then
                        for _ in coroutine.wrap(function()
                            bunsetsu.filter.func(translation, filter_env)
                        end) do end
                    end
                end
            else
                rawset(table, key, value)
            end
        end,
        __index = function(table, key)
            if key == "input" then return rawget(table, "_input") or "" end
            return nil
        end,
    })
    context.input = ""
    local env = { engine = { context = context }, mem = synth_env.mem }
    bunsetsu.init(env)
    context.translator_env = env
    return bunsetsu, context, viterbi
end

local checks, failures = 0, 0
local function check(condition, description)
    checks = checks + 1
    if condition then
        print("  ok: " .. description)
    else
        failures = failures + 1
        print("  FAIL: " .. description)
    end
end

local function record_learning(bunsetsu, context, userdict)
    context.translator_env.mem.update_userdict = function(_, entry)
        for _, row in ipairs(userdict) do
            if row.text == entry.text then
                row.commit_count = row.commit_count + 1
                return
            end
        end
        userdict[#userdict + 1] = {
            surface = entry.custom_code:match("^(.*) $"),
            text = entry.text,
            commit_count = 1,
        }
    end
    bunsetsu.learn(context)
end

local function select_clause_text(bunsetsu, context, index, text)
    local state = bunsetsu.state(context)
    state.active = index
    bunsetsu.render(context)
    local clause = state.clauses[index]
    for position, choice in ipairs(clause.candidates) do
        if choice.text == text then
            bunsetsu.select(context, position - clause.selected)
            return true
        end
    end
    return false
end

local function pos_matrix(ids, overrides)
    local matrix = {}
    local lefts, rights = { 0, -20 }, { 0, -10 }
    for _, id in ipairs(ids) do
        lefts[#lefts + 1] = id
        rights[#rights + 1] = id
    end
    for _, right_id in ipairs(rights) do
        for _, left_id in ipairs(lefts) do
            matrix[right_id .. " " .. left_id] = 0
        end
    end
    for key, value in pairs(overrides or {}) do matrix[key] = value end
    return matrix
end

local function pos_engine(dictionary, matrix, userdict, boundary)
    local readings = {}
    for _, row in ipairs(dictionary) do
        readings[row.surface] = readings[row.surface] or {}
        readings[row.surface][#readings[row.surface] + 1] = { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id,
                custom_code = row.surface .. " " } }
    end
    return new_engine(dictionary, matrix, readings, false, boundary, userdict)
end

print("== 1. candidates keep the unlearned word spans and part-of-speech sequence")
do
    local dictionary = {
        { surface = "あいう", candidate = "全", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あいう", candidate = "同", left_id = 1851, right_id = 1851, cost = 300 },
        { surface = "あいう", candidate = "異", left_id = 1841, right_id = 1841, cost = 1851 },
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 200 },
        { surface = "いう", candidate = "伊宇", left_id = 1851, right_id = 1851, cost = 200 },
    }
    local matrix = pos_matrix({ 1851, 1841 })
    for _, count in ipairs({ 0, 1, 1000000 }) do
        for _, suffix in ipairs({ "", "|1851 1851", "|1851 1851\tp2:c" }) do
            local histories = {
                { surface = "あ", text = "亜" .. suffix, commit_count = count },
                { surface = "あいう", text = "異|1851 1851\tp2:c あいう,異,1841,1841", commit_count = count },
                { surface = "あいう", text = "亜伊宇|1851 1851\tp2:c あ,亜,1851,1851;いう,伊宇,1851,1851", commit_count = count },
            }
            local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
            bunsetsu.start(context, "あいう")
            local state = bunsetsu.state(context)
            check(#state.clauses == 1 and state.clauses[1].reading == "あいう",
                "history frequency preserves the initial clause boundary")
            local clause = state.clauses[1]
            local texts = {}
            for _, choice in ipairs(clause.candidates) do texts[choice.text] = true end
            check(texts["全"] and texts["同"] and not texts["異"] and not texts["亜伊宇"],
                "the complete menu contains only the fixed single-word part of speech")
            for _, choice in ipairs(clause.unfiltered) do
                local words = choice.route_words
                check(words and #words == 1 and words[1].surface == "あいう"
                    and words[1].left_id == 1851 and words[1].right_id == 1851,
                    "every generated dictionary route preserves the fixed span and ids")
            end
        end
    end
end

print("== 2. equal word counts and endpoints cannot hide changed spans or middle ids")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "い", candidate = "井", left_id = 1920, right_id = 1920, cost = 300 },
        { surface = "うえ", candidate = "宇絵", left_id = 1909, right_id = 1909, cost = 100 },
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 300 },
        { surface = "う", candidate = "宇", left_id = 1841, right_id = 1841, cost = 300 },
        { surface = "え", candidate = "絵", left_id = 1909, right_id = 1909, cost = 300 },
    }
    local matrix = pos_matrix({ 1851, 1841, 1920, 1909 })
    local histories = {
        { surface = "あいうえ", text = "亜井宇絵|1851 1851\tp2:c あ,亜,1851,1851;い,井,1920,1920;うえ,宇絵,1909,1909", commit_count = 1000000 },
        { surface = "あいうえ", text = "愛宇絵|1851 1851\tp2:c あい,愛,1851,1851;う,宇,1841,1841;え,絵,1909,1909", commit_count = 1000000 },
    }
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいうえ")
    local clause = bunsetsu.state(context).clauses[1]
    check(bunsetsu.display(context) == "亜伊宇絵", "incompatible whole-clause histories cannot change the fixed route")
    for _, choice in ipairs(clause.unfiltered) do
        local words = choice.route_words
        check(words and #words == 3 and words[1].surface == "あ" and words[2].surface == "い"
            and words[3].surface == "うえ" and words[2].left_id == 1841 and words[2].right_id == 1841,
            "all route words match the original spans and full id sequence")
    end
end

print("== 3. learning ranks alternatives within the fixed frame and survives a new engine")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あい", candidate = "藍", left_id = 1851, right_id = 1851, cost = 300 },
        { surface = "う", candidate = "宇", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1841 })
    local histories = {}
    local boundary = function() return true end
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, boundary)
    bunsetsu.start(context, "あいう")
    check(bunsetsu.display(context) == "愛宇", "the initial surface follows the unlearned frame")
    check(select_clause_text(bunsetsu, context, 1, "藍"), "a lower-ranked same-frame alternative remains selectable")
    record_learning(bunsetsu, context, histories)
    check(#histories == 3 and histories[1].text == "藍|1851 1851\tp2:c あい,藍,1851,1851",
        "learning retains the existing clause and sentence history format")
    bunsetsu, context = pos_engine(dictionary, matrix, histories, boundary)
    bunsetsu.start(context, "あいう")
    local state = bunsetsu.state(context)
    check(#state.clauses == 2 and bunsetsu.display(context) == "藍宇",
        "a new engine uses the saved history only to rank same-frame alternatives")
    bunsetsu.move(context, 1)
    bunsetsu.move(context, -1)
    check(state.active == 1 and bunsetsu.display(context) == "藍宇", "clause movement retains both selections")
    bunsetsu.resize(context, 1)
    check(#state.clauses == 1 and state.clauses[1].reading == "あいう",
        "manual boundary extension reparses only the changed reading")
    for _, choice in ipairs(state.clauses[1].unfiltered) do
        local words = choice.route_words
        check(not choice.entry or (words and #words == 2 and words[1].surface == "あい" and words[1].left_id == 1851
            and words[2].surface == "う" and words[2].left_id == 1841),
            "resized candidates preserve the newly determined unlearned frame")
    end
end

print("== 4. lexical id differences retain the same part of speech and original route ids")
do
    local dictionary = {
        { surface = "さかな", candidate = "魚", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "さかな", candidate = "さかな", left_id = 1851, right_id = 1851, cost = 400 },
        { surface = "さかな", candidate = "異", left_id = 1841, right_id = 1841, cost = 500 },
    }
    local matrix = pos_matrix({ 1851, 1898, 1841 }, { ["0 1851"] = 200 })
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "さかな")
    local clause = bunsetsu.state(context).clauses[1]
    local offered = {}
    for _, choice in ipairs(clause.candidates) do offered[choice.text] = choice end
    check(offered["魚"] and offered["さかな"] and not offered["異"],
        "the same six POS fields allow different lexical ids but exclude a different noun subclass")
    check(clause.frame[1].left_id == 1898 and bunsetsu.display(context) == "魚",
        "the mechanical frame retains its original lexical id")
    check(select_clause_text(bunsetsu, context, 1, "さかな"), "the same-POS alternative with another id is selectable")
    record_learning(bunsetsu, context, histories)
    check(histories[1].text == "さかな|1851 1851\tp2:c さかな,さかな,1851,1851",
        "history stores the selected route ids, not the frame ids or a POS key")
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "さかな")
    clause = bunsetsu.state(context).clauses[1]
    local choice = clause.candidates[clause.selected]
    check(clause.frame[1].left_id == 1898 and choice.left_id == 1851 and choice.right_id == 1851
        and bunsetsu.display(context) == "さかな",
        "saved learning changes rank within the same POS while both ids keep their original meaning")
end

print("== 5. partial histories rank fixed multiword clauses without moving their boundaries")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 40 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 40 },
        { surface = "う", candidate = "宇", left_id = 1920, right_id = 1920, cost = 1000 },
        { surface = "う", candidate = "迂", left_id = 1920, right_id = 1920, cost = 5000 },
        { surface = "え", candidate = "絵", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1841, 1920, 1909 }, { ["1851 1841"] = 100 })
    local boundary = function(right_id, left_id) return right_id == 1851 and left_id == 1920 end
    for _, count in ipairs({ 0, 1, 1000000 }) do
        for _, suffix in ipairs({ "", "|1851 1851", "|1851 1851\tp2:c う,迂,1920,1920" }) do
            local histories = { { surface = "う", text = "迂" .. suffix, commit_count = count } }
            local bunsetsu, context = pos_engine(dictionary, matrix, histories, boundary)
            bunsetsu.start(context, "あいうえ")
            local clauses = bunsetsu.state(context).clauses
            check(#clauses == 2 and clauses[1].reading == "あい" and clauses[2].reading == "うえ"
                and #clauses[1].frame == 1 and clauses[1].frame[1].left_id == 1851
                and #clauses[2].frame == 2 and clauses[2].frame[1].surface == "う"
                and clauses[2].frame[1].left_id == 1920 and clauses[2].frame[2].surface == "え"
                and clauses[2].frame[2].left_id == 1909,
                "partial learning preserves both clause boundaries and every unlearned word slot")
            local expected = count == 0 and "愛宇絵" or "愛迂絵"
            check(bunsetsu.display(context) == expected,
                "typed and legacy partial histories rank alternatives inside the fixed multiword clause")
            check(histories[1].text == "迂" .. suffix and histories[1].commit_count == count,
                "conversion preserves the original history without rewriting or clearing it")
        end
    end
end

print("== 6. both word sides keep the fixed inflection form while lexical ids may differ")
do
    local dictionary = {
        { surface = "あ", candidate = "甲", left_id = 694, right_id = 694, cost = 100 },
        { surface = "あ", candidate = "乙", left_id = 695, right_id = 695, cost = 200 },
        { surface = "あ", candidate = "丙", left_id = 694, right_id = 701, cost = 300 },
        { surface = "あ", candidate = "丁", left_id = 701, right_id = 694, cost = 300 },
    }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 694, 695, 701 }), {}, function() return false end)
    bunsetsu.start(context, "あ")
    local offered = {}
    for _, choice in ipairs(bunsetsu.state(context).clauses[1].candidates) do offered[choice.text] = true end
    check(offered["甲"] and offered["乙"] and not offered["丙"] and not offered["丁"],
        "the sixth POS field constrains inflection on both sides without constraining the lexical field")
end

print("== 7. a fresh dictionary-backed engine analyzes only individual clauses")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local bunsetsu, context, viterbi = pos_engine(dictionary, pos_matrix({ 1851, 1841 }), {},
        function() return true end)
    check(next(viterbi.lattice) == nil and viterbi.eos == nil, "the engine has not analyzed any reading")
    local analyze = viterbi.analyze
    local analyzed = {}
    function viterbi:analyze(reading)
        analyzed[#analyzed + 1] = reading
        return analyze(self, reading)
    end
    bunsetsu.start(context, "あいう")
    local state = bunsetsu.state(context)
    check(state.contextual and #state.clauses == 2 and state.clauses[1].reading == "あい"
        and state.clauses[2].reading == "う" and bunsetsu.display(context) == "愛宇",
        "a fresh engine determines the original clause boundaries and dictionary choices")
    check(#analyzed == 2 and analyzed[1] == "あい" and analyzed[2] == "う",
        "only stock candidate generation analyzes each clause, not the whole kana run")
end

print("== 8. lattice-backed fallbacks still analyze the kana run before splitting")
do
    local dictionary = {
        { surface = "あい", candidate = "愛", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local bunsetsu, context, viterbi = pos_engine(dictionary, pos_matrix({ 1851, 1841 }), {},
        function() return true end)
    local analyze, lookup = viterbi.analyze, viterbi._lookup
    local analyzed = {}
    viterbi._lookup = false
    function viterbi:analyze(reading)
        analyzed[#analyzed + 1] = reading
        self._lookup = lookup
        analyze(self, reading)
        self._lookup = false
    end
    bunsetsu.start(context, "あいう")
    local state = bunsetsu.state(context)
    check(state.contextual and #state.clauses == 2 and state.clauses[1].reading == "あい"
        and state.clauses[2].reading == "う" and bunsetsu.display(context) == "愛宇",
        "lattice fallback preserves the clause boundaries and choices without the dictionary API")
    check(#analyzed == 3 and analyzed[1] == "あいう" and analyzed[2] == "あい" and analyzed[3] == "う",
        "lattice fallback and stock candidates retain their required analyses")
end

print("== 9. deep same-frame stock candidates follow the complete contextual order")
do
    local dictionary, readings = {}, { ["あ"] = {}, ["う"] = {} }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 695"] = 10000, ["1898 695"] = 0,
    })
    for index = 1, 65 do
        local text = "候" .. index
        local id = index == 65 and 1898 or 1851
        dictionary[#dictionary + 1] = { surface = "あ", candidate = text, left_id = id, right_id = id, cost = index }
        readings["あ"][index] = { text = text, phrase = { text = text .. "|" .. id .. " " .. id, custom_code = "あ " } }
    end
    for index, id in ipairs({ 694, 695 }) do
        local text = "隣" .. index
        dictionary[#dictionary + 1] = { surface = "う", candidate = text, left_id = id, right_id = id, cost = index * 100000 }
        readings["う"][index] = { text = text, phrase = { text = text .. "|" .. id .. " " .. id, custom_code = "う " } }
    end
    local bunsetsu, context, viterbi = new_engine(dictionary, matrix, readings, false, function() return true end)
    bunsetsu.start(context, "あう")
    local state = bunsetsu.state(context)
    local clause = state.clauses[1]
    check(#clause.candidates == 65 and bunsetsu.display(context) == "候1隣1",
        "all sixty-five stock texts remain available beyond the upstream beam")
    for index, choice in ipairs(clause.candidates) do
        check(choice.text == "候" .. index, "the complete initial menu follows independent word costs at rank " .. index)
    end
    viterbi:analyze("あ")
    local isolated_target_rank = 0
    for assembly in viterbi:best_n() do
        isolated_target_rank = isolated_target_rank + 1
        check(assembly.candidate ~= "候65", "the contextual target is outside the isolated beam")
    end
    check(isolated_target_rank > 30, "the isolated premise extends beyond the first thirty candidates")
    check(select_clause_text(bunsetsu, context, 2, "隣2"), "the alternate neighbor remains in the same verb form")
    check(clause.candidates[1].text == "候65" and bunsetsu.display(context) == "候1隣2",
        "context promotes the deepest text while preserving the neighboring selected display")
    for index = 2, #clause.candidates do
        check(clause.candidates[index].text == "候" .. (index - 1),
            "every remaining page follows its independent contextual cost at rank " .. index)
    end
    matrix["1851 0"] = 10000
    bunsetsu, context, viterbi = new_engine(dictionary, matrix, { ["あ"] = { readings["あ"][1] } })
    viterbi:analyze("あ")
    check(viterbi:best_n()().candidate ~= "候65", "the stock beam does not supply the contextual first")
    bunsetsu.start(context, "あ")
    check(bunsetsu.display(context) == "候65" and bunsetsu.state(context).clauses[1].selected == 1,
        "initial selection and preview use the discovered contextual head rather than the beam seed")
end

print("== 10. full-cover stock texts survive a prefix stream longer than five hundred twelve rows")
do
    local dictionary = {}
    local matrix = pos_matrix({ 368 })
    for index = 1, 49 do
        dictionary[index] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 100 + index }
    end
    local reading = string.rep("あ", 14)
    local stock_texts, prefix_count, last_full_position = {}, 0, 0
    local readings = { [reading] = function(seg, env)
        for assembly in env.viterbi:best_n_prefix() do
            prefix_count = prefix_count + 1
            if assembly.surface == reading then
                stock_texts[assembly.candidate] = true
                last_full_position = prefix_count
                local candidate = Candidate("kagiroi", seg.start, seg._end, assembly.candidate, "")
                candidate.phrase = { text = assembly.candidate .. "|368 368", custom_code = reading .. " " }
                yield(candidate)
            end
        end
    end }
    local bunsetsu, context = new_engine(dictionary, matrix, readings)
    bunsetsu.start(context, reading)
    local clause = bunsetsu.state(context).clauses[1]
    check(prefix_count > 512 and last_full_position > 512, "the fixture supplies full-cover stock texts after row 512")
    local displayed = {}
    for _, choice in ipairs(clause.candidates) do displayed[choice.text] = true end
    for text in pairs(stock_texts) do
        local expected_cost = 0
        for _, codepoint in utf8.codes(text) do expected_cost = expected_cost + 100 + codepoint - 0x4e00 end
        local scored = false
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == text and choice.own == expected_cost then scored = true end
        end
        check(displayed[text] and scored, "each full-cover stock text retains its independent route cost: " .. text)
    end
end

print("== 11. tied fixed-frame paths retain the selected text and distinct alternatives")
do
    local dictionary = {}
    for index = 1, 48 do
        dictionary[index] = { surface = "あ", candidate = utf8.char(0x4e00 + index),
            left_id = 368, right_id = 368, cost = 0 }
    end
    local reading = string.rep("あ", 12)
    local bunsetsu, context, viterbi = new_engine(dictionary, pos_matrix({ 368 }), {})
    viterbi:analyze(reading)
    local initial_text = viterbi:best_n()().candidate
    bunsetsu.start(context, reading)
    local clause = bunsetsu.state(context).clauses[1]
    local seen, initial_scored = {}, false
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == initial_text and choice.own == 0 then initial_scored = true end
    end
    check(initial_scored and #clause.candidates > 1, "the selected tied route and distinct alternatives remain available")
    for _, choice in ipairs(clause.candidates) do
        check(not seen[choice.text], "tied paths display each text only once")
        seen[choice.text] = true
    end
end

print("== 12. contextual discovery includes an expensive prefix followed by a negative connection")
do
    local dictionary = {
        { surface = "あ", candidate = "遅", left_id = 1898, right_id = 1898, cost = 10000 },
        { surface = "い", candidate = "平", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "い", candidate = "勝", left_id = 1898, right_id = 1898, cost = 10 },
        { surface = "う", candidate = "隣1", left_id = 694, right_id = 694, cost = 1 },
        { surface = "う", candidate = "隣2", left_id = 695, right_id = 695, cost = 200000 },
    }
    for index = 1, 40 do
        dictionary[#dictionary + 1] = { surface = "あ", candidate = "安" .. index,
            left_id = 1851, right_id = 1851, cost = 100 + index }
    end
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1898 1898"] = -20000, ["1898 694"] = 100000,
    })
    local readings = {
        ["あい"] = { { text = "あい" } },
        ["う"] = {
            { text = "隣1", phrase = { text = "隣1|694 694", custom_code = "う " } },
            { text = "隣2", phrase = { text = "隣2|695 695", custom_code = "う " } },
        },
    }
    local bunsetsu, context = new_engine(dictionary, matrix, readings, false,
        function(_, left_id) return left_id == 694 or left_id == 695 end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    local previously_present = false
    for _, choice in ipairs(clause.candidates) do if choice.text == "遅勝" then previously_present = true end end
    check(not previously_present, "the negative-tail target is absent from the initial stock and contextual head")
    check(select_clause_text(bunsetsu, context, 2, "隣2"), "the new neighbor exposes the negative-tail context")
    check(clause.candidates[1].text == "遅勝", "the independent cost of minus 9990 wins within the fixed two-word frame")
    local scored = false
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == "遅勝" and choice.own == 10000 - 20000 + 10 then scored = true end
    end
    check(scored, "discovery retains the complete negative-tail route rather than pruning its expensive prefix")
end

print("== 13. selection paging and menu sync propagate same-text route identities without changing other displays")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 1 },
        { surface = "い", candidate = "同", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "同", left_id = 695, right_id = 695, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1898 694"] = 20, ["1851 695"] = 10, ["1898 695"] = 0,
        ["694 1851"] = 0, ["694 1898"] = 100, ["695 1851"] = 50, ["695 1898"] = 0,
    })
    for index = 1, 40 do
        dictionary[#dictionary + 1] = { surface = "あ", candidate = "埋" .. index,
            left_id = 1851, right_id = 1851, cost = 2 }
    end
    local readings = { ["う"] = {} }
    for index = 1, 11 do
        local id = index == 11 and 1898 or 1851
        dictionary[#dictionary + 1] = { surface = "う", candidate = "隣" .. index,
            left_id = id, right_id = id, cost = index }
        readings["う"][index] = { text = "隣" .. index,
            phrase = { text = "隣" .. index .. "|" .. id .. " " .. id, custom_code = "う " } }
    end
    readings["う"][12] = { text = "未採点" }
    for _, operation in ipairs({ "select", "page", "sync" }) do
        local bunsetsu, context = new_engine(dictionary, matrix, readings, false, function() return true end)
        bunsetsu.start(context, "あいう")
        local state = bunsetsu.state(context)
        check(bunsetsu.display(context) == "赤同隣1", operation .. ": initial selections follow independent connection costs")
        local red_count, red_routes = 0, 0
        for _, choice in ipairs(state.clauses[1].candidates) do
            if choice.text == "赤" then red_count = red_count + 1 end
        end
        for _, choice in ipairs(state.clauses[1].unfiltered) do
            if choice.text == "赤" and choice.own ~= nil then red_routes = red_routes + 1 end
        end
        check(red_count == 1 and red_routes == 2 and #state.clauses[2].candidates == 1,
            operation .. ": a same-text route behind forty cheaper texts remains scored without duplicating its display")
        state.active = 3
        context:set_option("_kagiroi_hide_candidates", false)
        bunsetsu.render(context)
        if operation == "select" then
            for _ = 1, 10 do bunsetsu.select(context, 1) end
        elseif operation == "page" then
            bunsetsu.page(context, 1)
        else
            context:set_option("_kagiroi_expand_candidates", true)
            bunsetsu.render(context)
            context:highlight(10)
            bunsetsu.display(context)
        end
        local outer, middle = state.clauses[1], state.clauses[2]
        check(bunsetsu.display(context) == "赤同隣11"
            and outer.candidates[outer.selected].left_id == 1898
            and middle.candidates[middle.selected].left_id == 695,
            operation .. ": the best compatible representatives propagate across two unchanged displays")
        check(select_clause_text(bunsetsu, context, 3, "未採点") and bunsetsu.display(context) == "赤同未採点",
            operation .. ": an unscored boundary retains both surrounding displays")
        check(select_clause_text(bunsetsu, context, 3, "隣1") and bunsetsu.display(context) == "赤同隣1"
            and outer.candidates[outer.selected].left_id == 1851
            and middle.candidates[middle.selected].left_id == 694,
            operation .. ": returning to the original neighbor restores both best representatives")
    end
end

print("== 14. reranking preserves filtered choices unscored order and the target reading")
do
    local dictionary = {
        { surface = "あか", candidate = "赤", left_id = 1851, right_id = 1851, cost = 10 },
        { surface = "あか", candidate = "赤", left_id = 1898, right_id = 1898, cost = 15 },
        { surface = "あか", candidate = "朱", left_id = 1851, right_id = 1851, cost = 20 },
        { surface = "とり", candidate = "鳥", left_id = 1851, right_id = 1851, cost = 10 },
        { surface = "とり", candidate = "鶏", left_id = 1851, right_id = 1851, cost = 20 },
        { surface = "赤鳥", candidate = "誤表記", left_id = 1851, right_id = 1851, cost = 1 },
    }
    local readings = {
        ["あか"] = {
            { text = "赤", phrase = { text = "赤|1851 1841", custom_code = "あか " } },
            { text = "朱", phrase = { text = "朱|1851 1851", custom_code = "あか " } },
            { text = "よみ1" },
            { text = "幻", phrase = { text = "幻|999 999", custom_code = "あか " } },
            { text = "よみ2" }, { text = "アカ" },
        },
        ["とり"] = {
            { text = "鳥", phrase = { text = "鳥|1851 1851", custom_code = "とり " } },
            { text = "鶏", phrase = { text = "鶏|1851 1851", custom_code = "とり " } },
        },
    }
    for _, foreign in ipairs({ "とり", "赤鳥" }) do
        for _, selected_text in ipairs({ "朱", "よみ1", "🔴" }) do
            local bunsetsu, context, viterbi = new_engine(dictionary, pos_matrix({ 1851, 1898 }), readings, true,
                function() return true end)
            bunsetsu.start(context, "あかとり")
            local clause = bunsetsu.state(context).clauses[1]
            local displayed = {}
            for _, choice in ipairs(clause.candidates) do displayed[#displayed + 1] = choice.text end
            check(table.concat(displayed, "|") == "赤|朱|🔴|よみ1|よみ2|アカ",
                "real routes rank their texts while invalid phrase rows disappear and unscored rows keep their order")
            check(select_clause_text(bunsetsu, context, 1, selected_text), "the requested filtered choice is selectable: " .. selected_text)
            viterbi:analyze(foreign)
            check(select_clause_text(bunsetsu, context, 2, "鶏"), "neighbor selection reranks after foreign analysis: " .. foreign)
            bunsetsu.page(context, 1)
            check(clause.candidates[clause.selected].text == selected_text,
                "neighbor selection and paging retain the filtered text rather than a raw-route index: " .. selected_text)
            for _, choice in ipairs(clause.candidates) do
                check(choice.text ~= "鳥" and choice.text ~= "鶏" and choice.text ~= "誤表記",
                    "reranking never imports candidates from the foreign reading: " .. foreign)
            end
        end
    end
end

print("== 15. resizing settles compatible routes while retaining an outer filtered selection")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 1 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 1 },
        { surface = "いさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "かな", candidate = "鉛", left_id = 1909, right_id = 1909, cost = 1 },
        { surface = "い", candidate = "左1", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "左2", left_id = 695, right_id = 695, cost = 100 },
        { surface = "さかな", candidate = "右", left_id = 1851, right_id = 1851, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1898, 1841, 1909, 694, 695 }, {
        ["1851 1841"] = 0, ["1898 1841"] = 100,
        ["1851 694"] = 10, ["1851 695"] = 20,
        ["1898 694"] = 5, ["1898 695"] = 0,
    })
    local readings = {}
    for _, row in ipairs(dictionary) do
        readings[row.surface] = readings[row.surface] or {}
        table.insert(readings[row.surface], { text = row.candidate,
            phrase = { text = row.candidate .. "|" .. row.left_id .. " " .. row.right_id,
                custom_code = row.surface .. " " } })
    end
    for _, filtered in ipairs({ false, true }) do
        local expand = function(candidate)
            if candidate.text == "赤" then yield(ShadowCandidate(candidate, "simplified", "🔴", "")) end
        end
        local bunsetsu, context = new_engine(dictionary, matrix, readings, expand, function() return true end)
        bunsetsu.start(context, "あいさかな")
        local state = bunsetsu.state(context)
        check(bunsetsu.display(context) == "赤元鉛", "the original dictionary frame has three clauses before resize")
        if filtered then
            check(select_clause_text(bunsetsu, context, 1, "🔴"), "the outer filter addition is selectable before resize")
        end
        local outer_text = filtered and "🔴" or "赤"
        state.active = 2
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        local outer, left, right = state.clauses[1], state.clauses[2], state.clauses[3]
        check(left.reading == "い" and right.reading == "さかな" and left.frame[1].left_id == 694,
            "resize reparses both readings and fixes the unlearned verb form")
        check(outer.candidates[outer.selected].text == outer_text
            and outer.candidates[outer.selected].left_id == 1898,
            "the outer display is retained while its best compatible source route changes")
        check(left.selected == 1 and left.candidates[1].text == "左2"
            and right.selected == 1 and right.candidates[1].text == "右",
            "both resized selections follow independent final-neighbor connection minima")
        local expected = outer_text .. "左2右"
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == expected, "repeated publication retains the settled choices and filter addition")
        end
    end
end

print("== 16. absorbing a clause retains the selected display of its successor")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "え", candidate = "絵A", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "え", candidate = "絵B", left_id = 1898, right_id = 1898, cost = 200 },
    }
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), {}, function() return true end)
    bunsetsu.start(context, "あいうえ")
    check(select_clause_text(bunsetsu, context, 4, "絵B"), "the successor starts from a nonfirst same-POS selection")
    local state = bunsetsu.state(context)
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, 1)
    check(#state.clauses == 3 and state.clauses[2].reading == "いう" and state.clauses[2].selected == 1,
        "extension absorbs the next clause and selects the merged frame's first candidate")
    check(state.clauses[3].reading == "え" and bunsetsu.display(context) == "亜伊宇絵B",
        "the clause after the removed boundary keeps its selected display")
end

print("== 17. relearning a deduped winner refreshes the same engine without changing the fixed frame")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "朱", left_id = 1851, right_id = 1851, cost = 300 },
        { surface = "あ", candidate = "朱", left_id = 1898, right_id = 1898, cost = 400 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), histories)
    bunsetsu.start(context, "あ")
    check(bunsetsu.display(context) == "赤", "the target begins below the ordinary first candidate")
    for round = 1, 3 do
        check(select_clause_text(bunsetsu, context, 1, "朱"), "the deduped target remains selectable in learning round " .. round)
        record_learning(bunsetsu, context, histories)
        bunsetsu.start(context, "あ")
        local clause = bunsetsu.state(context).clauses[1]
        check(bunsetsu.display(context) == "朱" and clause.frame[1].left_id == 1851,
            "the same engine sees new learning while keeping its ordinary frame in round " .. round)
        check(#histories == 1 and histories[1].commit_count == round
            and histories[1].text == "朱|1851 1851\tp2:c あ,朱,1851,1851",
            "relearning increases only the actual selected route's counter in round " .. round)
    end
end

print("== 18. same-text histories with shared endpoints keep different middle-word frames separate")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1920, right_id = 1920, cost = 1000 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local histories = {}
    local matrix = pos_matrix({ 1851, 1841, 1920, 1909 })
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    local first_history = "亜伊宇|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1841,1841;う,宇,1909,1909"
    local second_history = "亜伊宇|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1920,1920;う,宇,1909,1909"
    check(histories[1].text == first_history, "learning records the complete route including its middle word")
    dictionary[2].cost, dictionary[3].cost = 2000, 100
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].route_words[2].left_id == 1920,
        "a different ordinary middle-word frame cannot be replaced by the previous learned frame")
    check(clause.unfiltered[1].history_discount == nil, "shared endpoints do not transfer the previous middle-word discount")
    for _ = 1, 2 do
        record_learning(bunsetsu, context, histories)
        bunsetsu.start(context, "あいう")
    end
    check(#histories == 2 and histories[1].commit_count == 1
        and histories[2].text == second_history and histories[2].commit_count == 2,
        "the two identical displays maintain independent middle-word counters")
    dictionary[2].cost, dictionary[3].cost = 100, 1000
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    check(histories[1].commit_count == 2 and histories[2].commit_count == 2,
        "returning to the original frame relearns only its own complete route")
end

print("== 19. context-specific single-word and multiword histories cannot replace each other's frames")
do
    local dictionary = {
        { surface = "ないで", candidate = "内で", left_id = 1851, right_id = 1851, cost = 50 },
        { surface = "ない", candidate = "内", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "で", candidate = "で", left_id = 1909, right_id = 1909, cost = 100 },
        { surface = "たべ", candidate = "食べ", left_id = 694, right_id = 694, cost = 100 },
    }
    local matrix = pos_matrix({ 1851, 1841, 1909, 694 }, { ["694 1851"] = 50000 })
    local boundary = function(right_id) return right_id == 694 end
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, boundary)
    bunsetsu.start(context, "ないで")
    record_learning(bunsetsu, context, histories)
    check(histories[1].text == "内で|1851 1851\tp2:c ないで,内で,1851,1851", "the standalone frame records its one-word route")
    for _ = 1, 3 do
        bunsetsu.start(context, "たべないで")
        local clauses = bunsetsu.state(context).clauses
        check(#clauses == 2 and #clauses[2].frame == 2 and bunsetsu.display(context) == "食べ内で",
            "verb context independently fixes the multiword frame")
        record_learning(bunsetsu, context, histories)
    end
    check(#histories == 4 and histories[1].commit_count == 1
        and histories[3].text == "内で|1851 1851\tp2:c ない,内,1841,1841;で,で,1909,1909"
        and histories[3].commit_count == 3,
        "single-word and multiword histories over the same reading and display have separate counters")
    bunsetsu.start(context, "ないで")
    local clause = bunsetsu.state(context).clauses[1]
    check(#clause.frame == 1 and #clause.candidates[clause.selected].route_words == 1,
        "more commits to the multiword route cannot change the standalone one-word frame")
    record_learning(bunsetsu, context, histories)
    check(histories[1].commit_count == 2 and histories[3].commit_count == 3,
        "relearning the standalone route leaves the contextual multiword counter unchanged")
end

print("== 20. clause and whole-sentence histories have independent counters for the same word route")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1841 }), histories, function() return true end)
    bunsetsu.start(context, "あい")
    record_learning(bunsetsu, context, histories)
    check(#histories == 3 and histories[3].text == "亜伊|1851 1851\tp2:s あ,亜,1851,1851;い,伊,1841,1841",
        "the listed two-clause selection stores both clauses and its complete sentence route")
    bunsetsu.start(context, "あい")
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, 1)
    record_learning(bunsetsu, context, histories)
    record_learning(bunsetsu, context, histories)
    check(#histories == 4 and histories[3].commit_count == 1 and histories[4].commit_count == 2
        and histories[4].text == "亜伊|1851 1851\tp2:c あ,亜,1851,1851;い,伊,1841,1841",
        "merging and relearning the same words grows only the clause-scoped counter")
end

print("== 21. a learned subword discounts only its original ids inside a fixed multiword frame")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "亜", left_id = 1898, right_id = 1898, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
    }
    local histories = {}
    local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898, 1841 }), histories, function() return false end)
    bunsetsu.start(context, "あ")
    check(select_clause_text(bunsetsu, context, 1, "亜"), "the single-word route can be selected for subword training")
    record_learning(bunsetsu, context, histories)
    bunsetsu.start(context, "あい")
    local clause = bunsetsu.state(context).clauses[1]
    local learned_own, other_own
    for _, choice in ipairs(clause.unfiltered) do
        if choice.text == "亜伊" and choice.left_id == 1851 then learned_own = choice.own end
        if choice.text == "亜伊" and choice.left_id == 1898 then other_own = choice.own end
    end
    check(#clause.frame == 2 and bunsetsu.display(context) == "亜伊" and learned_own == 600 and other_own == 5100,
        "only the trained word identity improves the enclosing fixed-frame candidate")
end

print("== 22. legacy partial histories retain stored rows and actual words at every interval position")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1898, right_id = 1898, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local cases = {
        { surface = "あ", candidate = "亜", readings = {
            { "あ", "亜" }, { "あい", "亜伊" }, { "いあ", "伊亜" }, { "いあう", "伊亜宇" },
        }, saved = "伊亜宇|1851 1851\tp2:c い,伊,1841,1841;あ,亜,1851,1851;う,宇,1909,1909" },
        { surface = "あい", candidate = "亜伊", readings = {
            { "あい", "亜伊" }, { "あいう", "亜伊宇" }, { "うあい", "宇亜伊" }, { "うあいう", "宇亜伊宇" },
        }, saved = "宇亜伊宇|1851 1851\tp2:c う,宇,1909,1909;あ,亜,1851,1851;い,伊,1841,1841;う,宇,1909,1909" },
    }
    for _, case in ipairs(cases) do
        for _, encoded in ipairs({ false, true }) do
            local legacy = { surface = case.surface, candidate = case.candidate,
                left_id = 1851, right_id = 1851, commit_count = 1000000 }
            if encoded then legacy.text = case.candidate .. "|1851 1851" end
            local stored_text = legacy.text
            local histories = { legacy }
            local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898, 1841, 1909 }), histories,
                function() return false end)
            for _, reading in ipairs(case.readings) do
                bunsetsu.start(context, reading[1])
                local clause = bunsetsu.state(context).clauses[1]
                check(bunsetsu.display(context) == reading[2] and #clause.frame == utf8.len(reading[1]),
                    "legacy learning ranks only the original word slots in " .. reading[1])
            end
            record_learning(bunsetsu, context, histories)
            check(#histories == 2 and legacy.text == stored_text and legacy.candidate == case.candidate
                and legacy.commit_count == 1000000 and legacy.left_id == 1851 and legacy.right_id == 1851,
                "adding route-aware learning does not rewrite or merge the existing legacy record")
            check(histories[2].text == case.saved and histories[2].commit_count == 1,
                "relearning stores actual dictionary words instead of a synthetic legacy word")
        end
    end
end

print("== 23. long-vowel kana learning is visible after reconversion and a new engine")
do
    local dictionary = {
        { surface = "かれー", candidate = "カレー", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "かれー", candidate = "かれー", left_id = 1851, right_id = 1851, cost = 300 },
    }
    local matrix, histories = pos_matrix({ 1851, 1898 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "かれー")
    check(select_clause_text(bunsetsu, context, 1, "かれー"), "the lower-ranked long-vowel kana dictionary candidate is selectable")
    record_learning(bunsetsu, context, histories)
    check(histories[1].text == "かれー|1851 1851\tp2:c かれー,かれー,1851,1851",
        "kana learning records the long vowel and original route ids")
    bunsetsu.start(context, "かれー")
    check(bunsetsu.display(context) == "かれー", "reconversion in the same engine uses the new kana history")
    bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "かれー")
    check(bunsetsu.display(context) == "かれー", "a new engine restores the saved long-vowel kana history")
end

print("== 24. auxiliary learning cannot be reused by a noun-only frame with the same display")
do
    local dictionary = {
        { surface = "ない", candidate = "ない", left_id = 213, right_id = 213, cost = 100 },
        { surface = "ない", candidate = "ない", left_id = 1954, right_id = 1954, cost = 5000 },
    }
    local matrix, histories = pos_matrix({ 213, 1954 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "ない")
    record_learning(bunsetsu, context, histories)
    table.remove(dictionary, 1)
    bunsetsu, context = pos_engine(dictionary, matrix, histories)
    bunsetsu.start(context, "ない")
    local clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].left_id == 1954 and clause.unfiltered[1].own == 5000
        and clause.unfiltered[1].history_discount == nil,
        "a noun-only frame keeps its original identity and cost despite the auxiliary history")
    record_learning(bunsetsu, context, histories)
    check(#histories == 2 and histories[1].commit_count == 1
        and histories[2].text == "ない|1851 1851\tp2:c ない,ない,1954,1954",
        "noun learning creates a separate route history instead of growing the auxiliary counter")
end

print("== 25. malformed route suffixes are skipped without hiding the following valid history")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1851, right_id = 1851, cost = 5000 },
        { surface = "あ", candidate = "阿", left_id = 1898, right_id = 1898, cost = 1000 },
    }
    local suffixes = {
        "\tp2:c %FF,亜,1851,1851", "\tp2:c あ,%FF,1851,1851",
        "\tp2:c い,亜,1851,1851", "\tp2:c あ,阿,1851,1851",
        "\tp2:c あ,亜,1851,1851;", "\tp2:c ;あ,亜,1851,1851",
        "\tp2:c あ,亜,1851,1851;;あ,亜,1851,1851",
        "\tp2:c ,亜,1851,1851", "\tp2:c あ,,1851,1851",
        "\tp2:c %GG,亜,1851,1851", "\tp2:c bogus", "\tp2:c ",
        "\tp2:x あ,亜,1851,1851", "\tp2:c あ,亜," .. string.rep("9", 400) .. ",1851",
    }
    for _, suffix in ipairs(suffixes) do
        local malformed = { surface = "あ", text = "亜|1851 1851" .. suffix, commit_count = 1000000 }
        local histories = { malformed,
            { surface = "あ", text = "阿|1851 1851\tp2:c あ,阿,1898,1898", commit_count = 1 },
        }
        local bunsetsu, context = pos_engine(dictionary, pos_matrix({ 1851, 1898 }), histories)
        bunsetsu.start(context, "あ")
        local clause = bunsetsu.state(context).clauses[1]
        local rejected, accepted
        for _, choice in ipairs(clause.unfiltered) do
            if choice.text == "亜" then rejected = choice end
            if choice.text == "阿" then accepted = choice end
        end
        check(rejected and rejected.history_discount == nil and accepted and accepted.history_discount == 10000
            and bunsetsu.display(context) == "阿", "invalid suffix is not a legacy discount and the following valid row remains readable: " .. suffix)
        check(#histories == 2 and malformed.text == "亜|1851 1851" .. suffix and malformed.commit_count == 1000000,
            "rejecting a malformed suffix does not rewrite its stored row")
    end
end

print("== 26. both reshaped clauses select their first candidate under each other's final compatible route")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1909, right_id = 1909, cost = 1 },
        { surface = "いさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "かな", candidate = "鉛", left_id = 1920, right_id = 1920, cost = 1 },
        { surface = "い", candidate = "取1", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "取2", left_id = 695, right_id = 695, cost = 100 },
        { surface = "さかな", candidate = "魚1", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "さかな", candidate = "魚2", left_id = 1898, right_id = 1898, cost = 100 },
    }
    local matrix = pos_matrix({ 1909, 1841, 1920, 694, 695, 1851, 1898 }, {
        ["694 1851"] = 9000, ["694 1898"] = 10,
        ["695 1851"] = 10, ["695 1898"] = 9000,
    })
    local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
    bunsetsu.start(context, "あいさかな")
    local state = bunsetsu.state(context)
    state.active = 2
    context:set_option("_kagiroi_hide_candidates", true)
    bunsetsu.resize(context, -1)
    local left, right = state.clauses[2], state.clauses[3]
    local left_choice, right_choice = left.candidates[left.selected], right.candidates[right.selected]
    local final_connection = matrix[left_choice.right_id .. " " .. right_choice.left_id]
    check(left.reading == "い" and right.reading == "さかな" and left.selected == 1 and right.selected == 1,
        "both changed clauses initialize to the final filtered first candidate in their new fixed frames")
    for _, id in ipairs({ 694, 695 }) do
        check(final_connection <= matrix[id .. " " .. right_choice.left_id],
            "the left first minimizes independent costs under the final right selection")
    end
    for _, id in ipairs({ 1851, 1898 }) do
        check(final_connection <= matrix[left_choice.right_id .. " " .. id],
            "the right first minimizes independent costs under the final left selection")
    end
    check(bunsetsu.display(context) == "赤" .. left_choice.text .. right_choice.text,
        "settling both reshaped sides preserves the unreshaped outer display")
end

print("== 27. a same-POS middle-word history beats a cheaper competing route without leaking after removal")
do
    local dictionary = {
        { surface = "あ", candidate = "亜", left_id = 1841, right_id = 1841, cost = 100 },
        { surface = "い", candidate = "伊", left_id = 1851, right_id = 1851, cost = 1000 },
        { surface = "い", candidate = "伊", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "う", candidate = "宇", left_id = 1909, right_id = 1909, cost = 100 },
    }
    local matrix, histories = pos_matrix({ 1841, 1851, 1898, 1909 }), {}
    local bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    record_learning(bunsetsu, context, histories)
    local saved = "亜伊宇|1851 1851\tp2:c あ,亜,1841,1841;い,伊,1898,1898;う,宇,1909,1909"
    check(#histories == 1 and histories[1].text == saved, "training stores the original middle word with shared endpoints")
    dictionary[2].cost = 10
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    local clause = bunsetsu.state(context).clauses[1]
    local selected = clause.candidates[clause.selected]
    check(clause.frame[2].left_id == 1851 and selected.route_words[2].left_id == 1898
        and selected.left_id == 1841 and selected.right_id == 1909 and bunsetsu.display(context) == "亜伊宇",
        "learning preserves the middle lexical identity even when a same-POS competitor becomes cheaper")
    record_learning(bunsetsu, context, histories)
    check(#histories == 1 and histories[1].text == saved and histories[1].commit_count == 2,
        "deduplication and relearning grow only the selected middle-word history")
    table.remove(dictionary, 3)
    bunsetsu, context = pos_engine(dictionary, matrix, histories, function() return false end)
    bunsetsu.start(context, "あいう")
    clause = bunsetsu.state(context).clauses[1]
    check(clause.candidates[clause.selected].route_words[2].left_id == 1851,
        "removing the trained middle word leaves the competing same-POS route selectable")
    for _, choice in ipairs(clause.unfiltered) do
        check(choice.route_words[2].left_id == 1851 and choice.own == 210 and choice.history_discount == nil,
            "the remaining route keeps its independent word cost and receives no removed-word discount")
    end
    check(histories[1].text == saved and histories[1].commit_count == 2,
        "ignoring an unavailable middle-word history does not rewrite its stored row")
end

print("== 28. initial conversion settles a changed same-text representative before selecting its neighbor")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "赤", left_id = 1898, right_id = 1898, cost = 100 },
        { surface = "い", candidate = "鳥", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "取", left_id = 695, right_id = 695, cost = 200 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 500, ["1898 695"] = 0,
    })
    local histories = {
        { surface = "あ", text = "赤|1851 1851\tp2:c あ,赤,1898,1898", commit_count = 1 },
    }
    local bunsetsu, context, viterbi = pos_engine(dictionary, matrix, histories, function() return true end)
    viterbi:analyze("あい")
    local initial = viterbi:best_n()()
    check(initial.candidate == "赤鳥" and initial.left_id == 1851 and initial.right_id == 694,
        "the upstream beam initially supplies the unlearned red1851 and bird694 path")
    bunsetsu.start(context, "あい")
    local state = bunsetsu.state(context)
    local left, right = state.clauses[1], state.clauses[2]
    check(left.frame[1].left_id == 1851 and right.frame[1].left_id == 694,
        "the ordinary fixed frame retains the original full-path lexical ids")
    check(#left.candidates == 1 and left.candidates[left.selected].left_id == 1898,
        "the first conversion must switch the deduped representative to the learned same-POS route")
    local bird_cost = 100 + matrix["1898 694"]
    local alternative_cost = 200 + matrix["1898 695"]
    check(alternative_cost == 200 and bird_cost == 600 and alternative_cost < bird_cost,
        "independent costs under the final representative require the alternate neighbor")
    check(right.selected == 1 and right.candidates[1].text == "取"
        and right.candidates[right.selected].left_id == 695 and bunsetsu.display(context) == "赤取",
        "initial neighbor order selection and preview all use the final representative rather than its beam seed")
end

print("== 29. choosing the left clause reverses the right ranking while retaining its selected display")
do
    local dictionary = {
        { surface = "あ", candidate = "赤", left_id = 1851, right_id = 1851, cost = 100 },
        { surface = "あ", candidate = "朱", left_id = 1898, right_id = 1898, cost = 200 },
        { surface = "い", candidate = "鳥", left_id = 694, right_id = 694, cost = 100 },
        { surface = "い", candidate = "鶏", left_id = 695, right_id = 695, cost = 200 },
    }
    local matrix = pos_matrix({ 1851, 1898, 694, 695 }, {
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 1000, ["1898 695"] = 0,
    })
    local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
    bunsetsu.start(context, "あい")
    local right = bunsetsu.state(context).clauses[2]
    check(right.candidates[1].text == "鳥" and right.candidates[right.selected].text == "鳥"
        and 100 + matrix["1851 694"] < 200 + matrix["1851 695"],
        "before left selection the right head and selected display follow the original independent minimum")
    check(select_clause_text(bunsetsu, context, 1, "朱"), "a different same-POS left candidate remains selectable")
    check(200 + matrix["1898 695"] < 100 + matrix["1898 694"]
        and right.candidates[1].text == "鶏" and right.candidates[right.selected].text == "鳥"
        and bunsetsu.display(context) == "朱鳥",
        "left selection reverses the right head without replacing its existing selected display")
    check(select_clause_text(bunsetsu, context, 1, "赤") and right.candidates[1].text == "鳥"
        and right.candidates[right.selected].text == "鳥" and bunsetsu.display(context) == "赤鳥",
        "returning to the original left candidate restores the right order without changing its display")
end

print("== 30. a resized pair settles a long chain of same-text representatives to independent final-context minima")
do
    local prefix_readings = { "あ", "い", "う", "え", "お", "か", "き", "く" }
    local dictionary, word_costs = {}, {}
    for index, reading in ipairs(prefix_readings) do
        word_costs[reading] = { [1851] = 2, [1898] = 1 }
        for _, id in ipairs({ 1851, 1898 }) do
            dictionary[#dictionary + 1] = { surface = reading, candidate = "同" .. index,
                left_id = id, right_id = id, cost = word_costs[reading][id] }
        end
    end
    dictionary[#dictionary + 1] = { surface = "とりさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 }
    dictionary[#dictionary + 1] = { surface = "とり", candidate = "取", left_id = 1851, right_id = 1851, cost = 5000 }
    dictionary[#dictionary + 1] = { surface = "とり", candidate = "取", left_id = 1898, right_id = 1898, cost = 100 }
    dictionary[#dictionary + 1] = { surface = "さ", candidate = "魚", left_id = 694, right_id = 694, cost = 100 }
    dictionary[#dictionary + 1] = { surface = "さ", candidate = "魚", left_id = 695, right_id = 695, cost = 100 }
    word_costs["とり"] = { [1851] = 5000, [1898] = 100 }
    word_costs["さ"] = { [694] = 100, [695] = 100 }
    local matrix = pos_matrix({ 1851, 1898, 1841, 694, 695 }, {
        ["0 1898"] = 10000, ["1851 1898"] = 1000, ["1898 1841"] = 10000,
        ["1851 694"] = 0, ["1851 695"] = 1000,
        ["1898 694"] = 1000, ["1898 695"] = 0,
    })
    local prefix = table.concat(prefix_readings)
    for repetition = 1, 3 do
        local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return true end)
        bunsetsu.start(context, prefix .. "とりさ")
        local state = bunsetsu.state(context)
        for index = 1, #prefix_readings do
            local clause = state.clauses[index]
            check(clause.frame[1].left_id == 1851 and clause.candidates[clause.selected].left_id == 1851,
                "the initial ordinary path starts every prefix representative on its original id")
        end
        state.active = #state.clauses
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        check(#state.clauses == #prefix_readings + 2
            and state.clauses[#prefix_readings + 1].reading == "とり"
            and state.clauses[#prefix_readings + 2].reading == "さ",
            "the boundary change regenerates the final pair without changing any prefix reading")
        local expected_ids = { 1851, 1898, 1898, 1898, 1898, 1898, 1898, 1898, 1898, 695 }
        local expected_display = "同1同2同3同4同5同6同7同8取魚"
        for index, clause in ipairs(state.clauses) do
            local chosen = clause.candidates[clause.selected]
            check(chosen.left_id == expected_ids[index],
                "the final same-text representative is stable across the full chain at clause " .. index)
            local previous = state.clauses[index - 1]
            local following = state.clauses[index + 1]
            local previous_id = previous and previous.candidates[previous.selected].right_id or 0
            local following_id = following and following.candidates[following.selected].left_id or 0
            local costs = word_costs[clause.reading]
            local chosen_cost = costs[chosen.left_id]
                + matrix[previous_id .. " " .. chosen.left_id] + matrix[chosen.right_id .. " " .. following_id]
            for id, own in pairs(costs) do
                local alternative = own + matrix[previous_id .. " " .. id] + matrix[id .. " " .. following_id]
                check(chosen_cost <= alternative,
                    "each final representative minimizes independent costs under both final neighbors at clause " .. index)
            end
        end
        check(state.clauses[#prefix_readings + 1].selected == 1
            and state.clauses[#prefix_readings + 2].selected == 1 and bunsetsu.display(context) == expected_display,
            "both resized clauses select their settled heads while all prefix displays remain unchanged")
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == expected_display, "repeated publication retains the full settled display")
            for index, clause in ipairs(state.clauses) do
                check(clause.candidates[clause.selected].left_id == expected_ids[index],
                    "repeated publication cannot move a settled representative at clause " .. index)
            end
        end
    end
end

print("== 31. resized same-text routes switch identities and retain a stable equal-cost representative")
do
    local dictionary = {
        { surface = "とりさ", candidate = "元", left_id = 1841, right_id = 1841, cost = 1 },
        { surface = "とり", candidate = "同", left_id = 694, right_id = 694, cost = 500 },
        { surface = "とり", candidate = "同", left_id = 695, right_id = 695, cost = 500 },
        { surface = "とり", candidate = "同", left_id = 694, right_id = 695, cost = 500 },
        { surface = "さ", candidate = "魚", left_id = 1851, right_id = 1851, cost = 500 },
        { surface = "さ", candidate = "魚", left_id = 1898, right_id = 1898, cost = 500 },
    }
    local matrix = pos_matrix({ 1841, 694, 695, 1851, 1898 }, {
        ["694 1851"] = 10, ["694 1898"] = 10,
        ["695 1851"] = 5, ["695 1898"] = 1,
    })
    for repetition = 1, 3 do
        local bunsetsu, context = pos_engine(dictionary, matrix, {}, function() return false end)
        bunsetsu.start(context, "とりさ")
        context:set_option("_kagiroi_hide_candidates", true)
        bunsetsu.resize(context, -1)
        local state = bunsetsu.state(context)
        local left, right = state.clauses[1], state.clauses[2]
        local chosen_left, chosen_right = left.candidates[left.selected], right.candidates[right.selected]
        check(#left.candidates == 1 and #right.candidates == 1 and left.selected == 1 and right.selected == 1,
            "same-text route changes retain one final first candidate per resized clause")
        check(chosen_left.left_id == 694 and chosen_left.right_id == 695 and chosen_right.left_id == 1898,
            "both representative identities switch beyond their stock rows and retain stable tie order")
        local tied_left_ids = {}
        for _, choice in ipairs(left.unfiltered) do
            if choice.right_id == 695 and choice.own == 500 then tied_left_ids[choice.left_id] = true end
        end
        check(tied_left_ids[694] and tied_left_ids[695], "both equal-cost best left routes remain materialized after deduplication")
        check(500 + matrix["695 1898"] == 501 and 500 + matrix["694 1898"] == 510
            and 500 + matrix["695 1851"] == 505,
            "independent final-context costs favor the chosen right id and tie both best left routes")
        for _ = 1, 3 do
            bunsetsu.render(context)
            check(bunsetsu.display(context) == "同魚" and left.candidates[left.selected].left_id == 694
                and left.candidates[left.selected].right_id == 695 and right.candidates[right.selected].left_id == 1898,
                "equal-cost same-text representatives and preview remain unchanged after publication")
        end
    end
end

print(string.format("bunsetsu: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
