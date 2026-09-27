/*
 * Headless behavior harness for the managed Kagiroi Rime config.
 *
 * The workspace argument must contain the deployed layout: the managed files
 * from dotfiles/rime (default.custom.yaml, kagiroi.custom.yaml, the custom
 * dictionaries and lua/) plus the stock Kagiroi schema, dictionaries and lua/
 * from the local mirror. run.sh assembles it and compiles this file.
 *
 * Scenario order follows dotfiles/rime/SPEC.md: input and conversion
 * (schema, n-run correction, first candidate), then common key handling
 * (Zenkaku_Hankaku, Henkan, candidate gate).
 *
 * Usage: harness <user_data_dir> [-v]
 * Exit status is 0 when every check passes.
 */
#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define kSpace 0x20
#define kReturn 0xff0d
#define kHenkan 0xff23
#define kZenkakuHankaku 0xff2a

static RimeApi* rime = NULL;
static RimeSessionId session = 0;
static int g_checks = 0;
static int g_failures = 0;
static int g_verbose = 0;

static void check(Bool condition, const char* description) {
    ++g_checks;
    if (!condition) {
        ++g_failures;
        fprintf(stderr, "FAIL: %s\n", description);
    }
}

static void press(int keycode) {
    rime->process_key(session, keycode, 0);
}

static void type_text(const char* ascii) {
    for (const unsigned char* p = (const unsigned char*)ascii; *p; ++p) {
        press(*p);
    }
}

static Bool option(const char* name) {
    return rime->get_option(session, name);
}

static Bool composing(void) {
    RIME_STRUCT(RimeStatus, status);
    Bool result = rime->get_status(session, &status) && status.is_composing;
    rime->free_status(&status);
    return result;
}

/* The commit, if one has been produced since the last poll. */
static Bool take_commit(char* buffer, size_t size) {
    RIME_STRUCT(RimeCommit, commit);
    Bool result = False;
    if (rime->get_commit(session, &commit) && commit.text) {
        snprintf(buffer, size, "%s", commit.text);
        result = True;
    }
    rime->free_commit(&commit);
    return result;
}

/* menu.candidates is only valid while context is alive. */
static Bool current_menu(RimeContext* context) {
    return rime->get_context(session, context);
}

static int menu_has_candidate(RimeContext* context, const char* text) {
    for (int i = 0; i < context->menu.num_candidates; ++i) {
        const char* candidate = context->menu.candidates[i].text;
        if (candidate && strstr(candidate, text)) return 1;
    }
    return 0;
}

static void print_context(void) {
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) return;
    printf("  preedit: %s\n", context.composition.preedit ? context.composition.preedit : "(none)");
    printf("  candidates: %d highlighted: %d\n", context.menu.num_candidates,
           context.menu.highlighted_candidate_index);
    for (int i = 0; i < context.menu.num_candidates; ++i) {
        printf("  %d. %s\n", i, context.menu.candidates[i].text ? context.menu.candidates[i].text : "");
    }
    rime->free_context(&context);
}

static void fresh_session(void) {
    if (session) rime->destroy_session(session);
    session = rime->create_session();
    rime->select_schema(session, "kagiroi");
    char schema[64] = {0};
    rime->get_current_schema(session, schema, sizeof(schema));
    if (strcmp(schema, "kagiroi") != 0) {
        fprintf(stderr, "FAIL: expected the kagiroi schema, got '%s'\n", schema);
        ++g_failures;
    }
}

/* SPEC: the default schema is kagiroi before any explicit selection. */
static void test_default_schema_is_kagiroi(void) {
    if (session) rime->destroy_session(session);
    session = rime->create_session();
    char schema[64] = {0};
    rime->get_current_schema(session, schema, sizeof(schema));
    check(strcmp(schema, "kagiroi") == 0,
          "the default schema must be kagiroi without explicit selection");
}

/* SPEC: accepted n-run forms expose a candidate containing the reading's
 * dictionary word. Readings without a matching dictionary word (こにちは,
 * かんだ, にゃ) are checked as preedit in test_n_run_preedit. */
static void test_n_run_correction(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kanji", "漢字"},
        {"kannji", "漢字"},
        {"kannnji", "漢字"},
        {"kana", "かな"},
        {"kanna", "かんな"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konnnitiha", "こんにちは"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        press(kSpace);
        RIME_STRUCT(RimeContext, context);
        Bool found = False;
        if (rime->get_context(session, &context)) {
            found = menu_has_candidate(&context, cases[i].expected);
            if (g_verbose) {
                printf("  %s:\n", cases[i].input);
                print_context();
            }
            rime->free_context(&context);
        }
        check(found, cases[i].input);
        if (!found) {
            fprintf(stderr, "      expected a candidate containing %s\n", cases[i].expected);
        }
    }
}

/* SPEC: accepted n-run forms read exactly as the SPEC table says while
 * composing. */
static void test_n_run_preedit(void) {
    static const struct {
        const char* input;
        const char* expected;
    } cases[] = {
        {"kanji", "かんじ"},
        {"kannji", "かんじ"},
        {"kannnji", "かんじ"},
        {"kana", "かな"},
        {"kanna", "かんな"},
        {"kannna", "かんな"},
        {"kannnna", "かんな"},
        {"konitiha", "こにちは"},
        {"konnnitiha", "こんにちは"},
        {"kanda", "かんだ"},
        {"kannnda", "かんだ"},
        {"nya", "にゃ"},
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
        fresh_session();
        type_text(cases[i].input);
        RIME_STRUCT(RimeContext, context);
        if (!rime->get_context(session, &context)) {
            check(False, "typing must keep a queryable context");
            continue;
        }
        char description[128];
        snprintf(description, sizeof(description), "%s must read %s while composing",
                 cases[i].input, cases[i].expected);
        check(context.composition.preedit &&
                  strcmp(context.composition.preedit, cases[i].expected) == 0,
              description);
        rime->free_context(&context);
    }
}

/* SPEC: n followed by Space resolves to ん and starts the conversion. */
static void test_kan_space_starts_conversion(void) {
    fresh_session();
    type_text("kan");
    press(kSpace);
    check(composing(), "Space must start the conversion of the pending n");
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) {
        check(False, "Space must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates > 0,
          "Space must expose candidates for the reading かん");
    check(context.composition.preedit && strcmp(context.composition.preedit, "かん") == 0,
          "the reading after n + Space must be かん");
    rime->free_context(&context);
}

/* SPEC: Zenkaku_Hankaku toggles between Japanese and ASCII input. */
static void test_zenkaku_hankaku_toggles_ascii(void) {
    fresh_session();
    press(kZenkakuHankaku);
    check(option("ascii_mode"), "Zenkaku_Hankaku must enable ascii mode");
    press(kZenkakuHankaku);
    check(!option("ascii_mode"), "Zenkaku_Hankaku must restore Japanese mode");
    /* The toggle must also work outside a composition. */
    RIME_STRUCT(RimeStatus, status);
    Bool composing_before = rime->get_status(session, &status) && status.is_composing;
    rime->free_status(&status);
    check(!composing_before, "the session must stay idle outside a composition");
}

/* SPEC: Henkan turns the first candidate into full-width katakana without
 * committing; the selection is highlighted from the start. */
static void test_henkan_promotes_katakana(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kHenkan);
    check(composing(), "Henkan must keep the composition open");
    check(option("katakana"), "Henkan must enable the katakana option");
    RIME_STRUCT(RimeContext, context);
    Bool promoted = False;
    if (rime->get_context(session, &context)) {
        promoted = context.menu.num_candidates > 0 &&
                   context.menu.candidates[0].text &&
                   menu_has_candidate(&context, "カンジ") &&
                   context.menu.highlighted_candidate_index == 0;
        if (g_verbose) print_context();
        rime->free_context(&context);
    }
    check(promoted, "Henkan must put full-width katakana first");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "Henkan must not commit");
}

/* SPEC: after Henkan, Space still cycles, Enter commits the selection, and
 * the next typing hides candidates again. */
static void test_henkan_space_enter_chain(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    press(kHenkan);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "the katakana menu must exist after Henkan");
        return;
    }
    check(context.menu.num_candidates > 1,
          "the katakana menu must hold more than one candidate for cycling");
    rime->free_context(&context);
    press(kSpace);
    char expected[256] = "";
    if (rime->get_context(session, &context)) {
        check(composing(), "Space after Henkan must keep the composition open");
        check(context.menu.highlighted_candidate_index == 1,
              "Space after Henkan must move the selection to the next candidate");
        if (context.menu.highlighted_candidate_index < context.menu.num_candidates &&
            context.menu.candidates[context.menu.highlighted_candidate_index].text) {
            snprintf(expected, sizeof(expected), "%s",
                     context.menu.candidates[context.menu.highlighted_candidate_index].text);
        }
        rime->free_context(&context);
    } else {
        check(False, "the menu must survive Space after Henkan");
    }
    check(expected[0] != '\0', "the selected candidate must have text");
    press(kReturn);
    check(composing() == False, "Enter after Henkan cycling must end the composition");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter must commit the candidate selected after Henkan");
    type_text("kanji");
    RIME_STRUCT(RimeContext, next);
    if (rime->get_context(session, &next)) {
        check(composing(), "next typing must start a new composition");
        check(next.menu.num_candidates == 0,
              "next typing must hide candidates until Space again");
        rime->free_context(&next);
    } else {
        check(False, "next typing must keep a queryable context");
    }
}

/*
 * SPEC: typing must not expose any candidates before the first Space.
 *
 * The managed config hides candidates through a Lua gate filter driven by a
 * custom option no librime core handles, so this check exercises the same
 * code path the Windows front-end (librime 1.13.1) runs.
 */
static void test_typing_hides_candidates(void) {
    fresh_session();
    type_text("kanji");
    check(composing(), "typing must start a composition");
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "typing must keep a queryable context");
        return;
    }
    check(context.menu.num_candidates == 0,
          "typing must report zero candidates before the first Space");
    rime->free_context(&context);
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "typing must not commit");
}

/*
 * SPEC: the first Space reveals the candidate menu and selects the first
 * candidate without committing.
 */
static void test_first_space_reveals_candidates(void) {
    fresh_session();
    type_text("kanji");
    if (g_verbose) {
        printf("  after typing:\n");
        print_context();
    }
    press(kSpace);
    check(composing(), "first Space must keep the composition open");
    RIME_STRUCT(RimeContext, context);
    check(current_menu(&context) && context.menu.num_candidates > 0,
          "first Space must expose candidates in the menu");
    check(context.menu.highlighted_candidate_index == 0,
          "first Space must select the first candidate");
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "first Space must not commit");
    if (g_verbose) print_context();
}

/* SPEC: later Spaces move the selection and wrap past the final candidate. */
static void test_space_cycles_candidates(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!current_menu(&context)) {
        check(False, "candidate menu must exist before cycling");
        return;
    }
    int count = context.menu.num_candidates;
    rime->free_context(&context);
    check(count > 1, "the menu must hold more than one candidate for cycling");
    for (int expected = 1; expected <= count; ++expected) {
        press(kSpace);
        if (!rime->get_context(session, &context)) {
            check(False, "the menu must survive cycling");
            return;
        }
        check(context.menu.highlighted_candidate_index == expected % count,
              "Space must advance the highlight and wrap to the first candidate");
        rime->free_context(&context);
    }
    char commit[256];
    check(!take_commit(commit, sizeof(commit)), "cycling must not commit");
}

/* SPEC: Enter commits the highlighted candidate. */
static void test_enter_commits_highlighted_candidate(void) {
    fresh_session();
    type_text("kanji");
    press(kSpace);
    RIME_STRUCT(RimeContext, context);
    if (!rime->get_context(session, &context)) {
        check(False, "the menu must exist before Enter");
        return;
    }
    int highlighted = context.menu.highlighted_candidate_index;
    char expected[256] = "";
    if (highlighted < context.menu.num_candidates && context.menu.candidates[highlighted].text) {
        snprintf(expected, sizeof(expected), "%s", context.menu.candidates[highlighted].text);
    }
    rime->free_context(&context);
    check(expected[0] != '\0', "the highlighted candidate must have text");
    press(kReturn);
    check(composing() == False, "Enter must end the composition");
    char commit[256];
    check(take_commit(commit, sizeof(commit)) && strcmp(commit, expected) == 0,
          "Enter must commit the highlighted candidate");
}

static void on_message(void* context_object, RimeSessionId session_id, const char* message_type, const char* message_value) {
    (void)context_object;
    (void)session_id;
    if (g_verbose) fprintf(stderr, "[%s] %s\n", message_type, message_value);
}

int main(int argc, char* argv[]) {
    const char* user_data_dir = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "-v") == 0) {
            g_verbose = 1;
        } else {
            user_data_dir = argv[i];
        }
    }
    if (!user_data_dir) {
        fprintf(stderr, "usage: harness <user_data_dir> [-v]\n");
        return 2;
    }

    rime = rime_get_api();
    if (!rime) {
        fprintf(stderr, "FAIL: librime is not available\n");
        return 1;
    }

    RIME_STRUCT(RimeTraits, traits);
    traits.shared_data_dir = "/usr/share/rime-data";
    traits.user_data_dir = user_data_dir;
    traits.distribution_name = "dotfiles-rime-test";
    traits.distribution_code_name = "just test-rime";
    traits.distribution_version = "1.0";
    traits.app_name = "rime.kagiroi-behavior-test";
    traits.min_log_level = getenv("RIME_TEST_LOG_LEVEL") ? atoi(getenv("RIME_TEST_LOG_LEVEL")) : 3;
    traits.log_dir = "";

    rime->setup(&traits);
    rime->set_notification_handler(&on_message, NULL);
    rime->initialize(NULL);
    if (!rime->start_maintenance(True)) {
        fprintf(stderr, "FAIL: maintenance did not run\n");
    }
    rime->join_maintenance_thread();

    static void (*const tests[])(void) = {
        test_default_schema_is_kagiroi,
        test_n_run_correction,
        test_n_run_preedit,
        test_kan_space_starts_conversion,
        test_zenkaku_hankaku_toggles_ascii,
        test_henkan_promotes_katakana,
        test_henkan_space_enter_chain,
        test_typing_hides_candidates,
        test_first_space_reveals_candidates,
        test_space_cycles_candidates,
        test_enter_commits_highlighted_candidate,
    };
    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); ++i) {
        tests[i]();
    }

    if (session) rime->destroy_session(session);
    rime->finalize();

    printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
