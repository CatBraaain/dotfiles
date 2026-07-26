if ! command -v vp >/dev/null 2>&1; then
  curl -fsSL https://vite.plus | bash
fi
go install github.com/karust/openserp@latest
uv tool install crawl4ai
