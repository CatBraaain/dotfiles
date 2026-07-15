{
  description = "User packages";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents,
    }:
    let
      system = "x86_64-linux"; # WSL2
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [
          llm-agents.overlays.shared-nixpkgs
        ];
      };
    in
    {
      packages.${system}.default = pkgs.buildEnv {
        name = "user-packages";
        paths =
          (with pkgs.llm-agents; [
            # keep-sorted start by_regex=\s*#?\s*(.*) sticky_comments=no
            apm
            cc-switch-cli
            claude-code
            cursor-agent
            # oh-my-opencode
            opencode
            # keep-sorted end
          ])
          ++ (with pkgs; [
            # keep-sorted start by_regex=\s*#?\s*(.*) sticky_comments=no
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
            pnpm
            powershell
            ripgrep
            socat # bash-sandbox
            tokei
            uv
            yq-go
            # keep-sorted end
          ]);
      };
    };
}
