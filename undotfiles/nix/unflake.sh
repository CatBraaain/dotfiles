if ! command -v vp >/dev/null 2>&1; then
  curl -fsSL https://vite.plus | bash
fi
go install github.com/karust/openserp@latest
uv tool install trafilatura[all]
uv tool install mineru[all]

if ! dpkg -s libasound2t64 >/dev/null 2>&1; then
  sudo apt install -y libasound2t64
fi

if ! dpkg -s xvfb >/dev/null 2>&1; then
  sudo apt install -y xvfb
fi
