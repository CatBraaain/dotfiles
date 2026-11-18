#define main rime_behavior_main
#include "harness.c"
#undef main
#include <assert.h>

int main(void) {
    char display[256];
    unsigned long selected;
    assert(snapshot_display("1;6:感じ", display, sizeof(display), &selected));
    assert(strcmp(display, "感じ") == 0 && selected == 1);
    assert(snapshot_display("2;9:今日は6:商工", display, sizeof(display), &selected));
    assert(strcmp(display, "[今日は, 商工]") == 0 && selected == 2);
    assert(!snapshot_display("1;4:[a,b]", display, sizeof(display), &selected));
    assert(snapshot_display("1;5:[a,b]", display, sizeof(display), &selected));
    assert(strcmp(display, "\"[a,b]\"") == 0);
    assert(snapshot_display("1;3:a,b3:a\"b", display, sizeof(display), &selected));
    assert(strcmp(display, "[\"a,b\", \"a\\\"b\"]") == 0);
    assert(snapshot_display("1;4:🍛3:a:b", display, sizeof(display), &selected));
    assert(strcmp(display, "[🍛, a:b]") == 0);
    assert(snapshot_display("1;2:124:null4:true", display, sizeof(display), &selected));
    assert(strcmp(display, "[\"12\", \"null\", \"true\"]") == 0);
    assert(snapshot_display("1;2: a", display, sizeof(display), &selected));
    assert(strcmp(display, "\" a\"") == 0);

    RIME_STRUCT(RimeContext, context);
    context.composition.preedit = "今日はしょうこう";
    context.commit_text_preview = "not used to infer clause text";
    RimeCandidate candidates[] = {{.text = "商工"}, {.text = "昇降"}, {.text = "消耗"}};
    context.menu.num_candidates = 3;
    context.menu.candidates = candidates;
    context.menu.highlighted_candidate_index = 0;
    begin_scenario("ordinary_conversion");
    record_context(&context, "2;9:今日は6:商工");
    assert(g_line_count == 4);
    assert(strcmp(g_lines[2], "    display: [今日は, 商工]") == 0);
    assert(strcmp(g_lines[3], "    candidates: [商工, 昇降, 消耗]") == 0);
    record_context(&context, "1;9:今日は6:商工");
    assert(g_line_count == 6);
    assert(strcmp(g_lines[4], g_lines[2]) == 0);
    assert(strcmp(g_lines[5], g_lines[3]) == 0);
    begin_scenario("bunsetsu_selection_and_preview");
    record_context(&context, "2;9:今日は6:商工");
    assert(strcmp(g_lines[g_line_count - 3], "    display: [今日は, 商工]") == 0);
    assert(strcmp(g_lines[g_line_count - 2], "    selected_clause: 2") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    candidates: [商工, 昇降, 消耗]") == 0);

    context.menu.num_candidates = 0;
    record_context(&context, "1;9:今日は6:商工");
    assert(strcmp(g_lines[g_line_count - 2], "    display: [今日は, 商工]") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    selected_clause: 1") == 0);
    record_context(&context, "2;9:今日は6:商工");
    assert(strcmp(g_lines[g_line_count - 2], "    display: [今日は, 商工]") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    selected_clause: 2") == 0);
    context.composition.preedit = "かんじ";
    context.commit_text_preview = "かんじ";
    size_t before_cancelled = g_line_count;
    record_context(&context, "");
    assert(g_line_count == before_cancelled + 1);
    assert(strcmp(g_lines[g_line_count - 1], "    display: かんじ") == 0);
    context.commit_text_preview = NULL;
    record_context(&context, "");
    assert(strcmp(g_lines[g_line_count - 1], "    display: かんじ") == 0);
    record_context(&context, "1;6:感じ");
    assert(strcmp(g_lines[g_line_count - 2], "    display: 感じ") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    selected_clause: 1") == 0);
    context.composition.preedit = "";
    context.commit_text_preview = "";
    size_t before_empty = g_line_count;
    record_context(&context, "");
    assert(g_line_count == before_empty);

    char scalar[512];
    assert(strcmp(yaml_scalar(scalar, sizeof(scalar), "a\"\nb", False), "\"a\\\"\\nb\"") == 0);
    assert(strcmp(yaml_scalar(scalar, sizeof(scalar), "a[0]", True), "\"a[0]\"") == 0);
    assert(strcmp(yaml_scalar(scalar, sizeof(scalar), "kanji{SPACE}", False), "kanji{SPACE}") == 0);
    static const char* invalid[] = {
        "", "0;6:感じ", "2;6:感じ", "3;9:今日は6:商工", "-1;6:感じ", "1.5;6:感じ",
        "999999999999999999999999;6:感じ", "1;", "1;0:", "1;6:", "1;-6:感じ",
        "1;6感じ", "1;6:感じ,", "1;5:感じ", "1;7:感じ", "1;1:\x80",
        "1;999999999999999999999999:感じ",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i)
        assert(!snapshot_display(invalid[i], display, sizeof(display), &selected));
    assert(!snapshot_display("1;6:感じ", display, 2, &selected));
    assert(!snapshot_display("2;9:今日は6:商工", display, 10, &selected));
    begin_scenario("named_steps");
    append_input("kyouhashoukou");
    record_key(kRight, 0, "次の文節への移動");
    assert(strcmp(g_lines[g_line_count - 2], "  - name: 次の文節への移動") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    input: kyouhashoukou{RIGHT}") == 0);
    record_key(kRight, 0, "右端での移動停止");
    assert(strcmp(g_lines[g_line_count - 2], "  - name: 右端での移動停止") == 0);
    assert(strcmp(g_lines[g_line_count - 1], "    input: kyouhashoukou{RIGHT}{RIGHT}") == 0);
    record_key(kLeft, 0, "引用: \"名前\"");
    assert(strcmp(g_lines[g_line_count - 2], "  - name: \"引用: \\\"名前\\\"\"") == 0);
    size_t before_unnamed = g_line_count;
    record_key(kLeft, 0, NULL);
    assert(g_line_count == before_unnamed + 1);
    assert(strcmp(g_lines[g_line_count - 1], "  - input: kyouhashoukou{RIGHT}{RIGHT}{LEFT}{LEFT}") == 0);
    free_lines();
    puts("snapshot format tests passed");
    return 0;
}
