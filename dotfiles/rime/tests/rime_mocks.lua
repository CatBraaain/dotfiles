local M = {}

function M.install_globals()
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
end

return M
