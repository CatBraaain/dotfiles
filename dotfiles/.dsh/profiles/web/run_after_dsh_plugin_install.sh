#!/bin/sh

set -eu

# External plugins are intentionally refreshed on every profile apply.
dsh plugin --profile web add --force --ignore-scripts dsh-codex-auth@rc
dsh plugin --profile web add --force --ignore-scripts \
  https://github.com/NOirBRight/dsh-llm-providers-ui/releases/latest/download/dsh-llm-providers-ui-0.2.9.tgz
dsh plugin --profile web add --force --ignore-scripts \
  https://github.com/NOirBRight/dsh-llm-commandcode/releases/latest/download/dsh-llm-commandcode-0.1.31.tgz
