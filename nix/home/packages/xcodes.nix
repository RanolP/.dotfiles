{ pkgs }:

pkgs.stdenv.mkDerivation rec {
  pname = "xcodes";
  version = "1.6.2";

  src = pkgs.fetchurl {
    url = "https://github.com/XcodesOrg/xcodes/releases/download/${version}/xcodes-${version}.macos.arm64.tar.gz";
    sha256 = "1xy4hn96qlkg1d2q7lppw53vwj860gvdqjv7zmihv18jmw102ly4";
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
