-- Keeps the candidate list hidden while the _kagiroi_hide_candidates option
-- is on. The name deliberately carries no core meaning on any librime
-- version, so hiding is performed by this filter alone and behaves the same
-- on Windows (librime 1.13.1) and Linux (librime 1.16).
local function hide_or_pass(translation, env)
    if env.engine.context:get_option("_kagiroi_hide_candidates") then
        return
    end
    local expanded = env.engine.context:get_option("_kagiroi_expand_candidates")
    local count = 0
    for candidate in translation:iter() do
        if count % 30 == 0 then
            local page_comment = "Page " .. (math.floor(count / 30) + 1)
            local comment = candidate.comment or ""
            if comment ~= "" then
                page_comment = comment .. " " .. page_comment
            end
            candidate = candidate:to_shadow_candidate(candidate.type, candidate.text, page_comment)
        end
        yield(candidate)
        count = count + 1
        if not expanded and count == 10 then
            return
        end
    end
end

return { func = hide_or_pass }
