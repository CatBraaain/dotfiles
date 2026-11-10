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

print(string.format("bunsetsu: %d checks, %d failures", checks, failures))
os.exit(failures == 0 and 0 or 1)
