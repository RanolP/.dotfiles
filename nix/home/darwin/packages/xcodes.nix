{ pkgs }:

pkgs.stdenv.mkDerivation rec {
  pname = "xcodes";
  version = "2.1.0";

  src = pkgs.fetchurl {
    url = "https://github.com/XcodesOrg/xcodes/releases/download/${version}/xcodes-${version}.macos.arm64.bottle.tar.gz";
    sha256 = "0c14gxlgfsldfjwicg3160cnhd5l35sdklq94wq46rx1zk0lq9dc";
  };

  sourceRoot = ".";

  installPhase = ''
    mkdir -p $out/bin
    install -m 755 xcodes/${version}/bin/xcodes $out/bin/xcodes
  '';

  meta = {
    description = "Xcode version manager CLI";
    homepage = "https://github.com/XcodesOrg/xcodes";
    platforms = [ "aarch64-darwin" ];
  };
}
