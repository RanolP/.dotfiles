{
  description = "ranolp's macOS configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    # Pin for mise — track a nixpkgs-unstable rev where aarch64-darwin
    # build is cached (avoids a Rust source build). This rev has 2026.5.12 cached.
    nixpkgs-mise.url = "github:NixOS/nixpkgs/4100e830e085863741bc69b156ec4ccd53ab5be0";

    nix-darwin = {
      url = "github:LnL7/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    homebrew-brew = {
      url = "github:Homebrew/brew";
      flake = false;
    };

    nix-homebrew = {
      url = "github:zhaofengli/nix-homebrew";
      inputs.brew-src.follows = "homebrew-brew";
    };

    nur.url = "github:nix-community/NUR";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-mise,
      nix-darwin,
      home-manager,
      nix-homebrew,
      nur,
      homebrew-brew,
      ...
    }:
    let
      username = "ranolp";
    in
    {
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt-rfc-style;

      homeConfigurations."ranolp-archwsl" = home-manager.lib.homeManagerConfiguration {
        pkgs = import nixpkgs {
          system = "x86_64-linux";
          config.allowUnfree = true;
        };
        modules = [
          ./home
          ./home/linux
        ];
      };

      darwinConfigurations."ranolp-work-MBP-26" = nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin";
        modules = [
          ./darwin
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
          {
            nix-homebrew = {
              enable = true;
              enableRosetta = false;
              user = username;
            };

            home-manager = {
              useGlobalPkgs = true;
              useUserPackages = true;
              backupFileExtension = "before-hm";
              users.${username} = {
                imports = [
                  ./home
                  ./home/darwin
                ];
              };
            };

            nixpkgs.overlays = [
              (final: prev: {
                nur = import nur {
                  pkgs = prev;
                  nurpkgs = prev;
                };

                # Pull mise from a pinned nixpkgs rev where aarch64-darwin
                # build is cached (avoids a Rust source build).
                mise = (import nixpkgs-mise { system = prev.stdenv.hostPlatform.system; }).mise;
              })
            ];
          }
        ];
      };
    };
}
