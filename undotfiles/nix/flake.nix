{
  description = "User packages";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    inputs:
    let
      system = "x86_64-linux"; # WSL2
      pkgs = import inputs.nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [
          inputs.llm-agents.overlays.shared-nixpkgs
        ];
      };
    in
    {
      packages.${system}.default = pkgs.buildEnv {
        name = "user-packages";
        paths = (
          with pkgs;
          [
            # keep-sorted start sticky_comments=no # LLM-only CLI tools
            ast-grep
            dasel
            difftastic
            hyperfine
            jq
            officecli
            pdfcpu
            sd
            shellcheck
            shfmt
            watchexec
            # keep-sorted end
            # keep-sorted start by_regex=\s*#?\s*(.*) sticky_comments=no  prefix_order=llm-agents,
            llm-agents.agent-browser
            llm-agents.apm
            llm-agents.claude-code
            llm-agents.cursor-agent
            # (llm-agents.pi.override { useBun = false; })
            llm-agents.pi
            act
            bubblewrap # bash-sandbox
            bun
            cargo
            cargo-binstall
            chezmoi
            code2prompt
            coreutils
            erdtree
            eza
            fd
            ffmpeg
            gcc
            gh
            git
            git-cliff
            gnumake
            go
            google-chrome
            gopls
            just
            just-lsp
            keep-sorted
            mise
            nixfmt
            nodejs
            noto-fonts-cjk-sans
            oxfmt
            oxlint
            pnpm
            powershell
            ripgrep
            rtk
            socat # bash-sandbox
            tokei
            tree-sitter
            tsgolint
            uv
            yq-go
            # keep-sorted end
          ]
        );
      };
    };
}
