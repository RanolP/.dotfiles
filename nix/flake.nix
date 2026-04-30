{
  description = "ranolp's macOS configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-darwin = {
      url = "github:LnL7/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-homebrew.url = "github:zhaofengli/nix-homebrew";

    nur.url = "github:nix-community/NUR";
  };

  outputs = { self, nixpkgs, nix-darwin, home-manager, nix-homebrew, nur }:
    let
      username = "ranolp";
    in {
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
              users.${username} = import ./home;
            };

            nixpkgs.overlays = [
              (final: prev: {
                nur = import nur { pkgs = prev; nurpkgs = prev; };
              })
            ];
          }
        ];
      };
    };
}
