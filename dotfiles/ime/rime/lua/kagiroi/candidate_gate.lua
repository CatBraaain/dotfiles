-- Keeps the candidate list hidden while the _kagiroi_hide_candidates option
-- is on. The name deliberately carries no core meaning on any librime
-- version, so hiding is performed by this filter alone and behaves the same
-- on Windows (librime 1.13.1) and Linux (librime 1.16).
local function hide_or_pass(translation, env)
    if env.engine.context:get_option("_kagiroi_hide_candidates") then
        return
    end
    for candidate in translation:iter() do
        yield(candidate)
    end
end

return { func = hide_or_pass }
