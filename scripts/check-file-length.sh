#!/usr/bin/env bash
# Fails if any tracked source file is longer than MAX_LINES (default 300).
# Lockfiles and generated files are excluded.
set -euo pipefail

MAX_LINES="${MAX_LINES:-300}"
status=0

while IFS= read -r file; do
  lines=$(wc -l < "$file" | tr -d ' ')
  if (( lines > MAX_LINES )); then
    echo "::error file=$file::$file has $lines lines (max $MAX_LINES). Split it up."
    status=1
  fi
done < <(git ls-files \
  | grep -Ev '(^|/)(pnpm-lock\.yaml|next-env\.d\.ts|AGENTS\.md|LICENSE)$' \
  | grep -Ev '\.(png|jpg|jpeg|gif|ico|svg|woff2?)$')

exit "$status"
