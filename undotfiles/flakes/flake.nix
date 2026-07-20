{
  description = "User packages";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    input:
    let
      system = "x86_64-linux"; # WSL2
      pkgs = import input.nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [
          input.llm-agents.overlays.shared-nixpkgs
        ];
      };
    in
    {
      packages.${system}.default = pkgs.buildEnv {
        name = "user-packages";
        paths = (
          with pkgs;
          [
            # keep-sorted start by_regex=\s*#?\s*(.*) sticky_comments=no  prefix_order=llm-agents,
            llm-agents.apm
            llm-agents.cc-switch-cli
            llm-agents.claude-code
            llm-agents.coderabbit-cli
            llm-agents.cursor-agent
            # llm-agents.oh-my-opencode
            llm-agents.opencode
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
            gopls
            just
            just-lsp
            keep-sorted
            mise
            nixfmt
            nodejs
            oxfmt
            oxlint
            pnpm
            powershell
            ripgrep
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
