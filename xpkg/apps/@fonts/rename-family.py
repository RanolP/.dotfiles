"""Rewrite a font's family name in place: rename-family.py <family> <font>...

The fonts-archive copy of Apple SD Gothic Neo names each weight as its own
family (AppleSDGothicNeoR00, AppleSDGothicNeoB00, ...), so CSS asking for
"Apple SD Gothic Neo" never matches it and pages fall through to Malgun Gothic.
This gives every file the one family name CSS uses, with the weight taken from
the file name (AppleSDGothicNeo-SemiBold.ttf -> SemiBold, 600).
"""
import re
import sys

from fontTools.ttLib import TTFont

WEIGHTS = {
    "Thin": 100, "ExtraLight": 200, "UltraLight": 200, "Light": 300,
    "Regular": 400, "Medium": 500, "SemiBold": 600, "Bold": 700,
    "ExtraBold": 800, "Black": 900, "Heavy": 900,
}

family, paths = sys.argv[1], sys.argv[2:]
for path in paths:
    m = re.search(r"-([A-Za-z]+)\.[ot]tf$", path)
    style = m and m.group(1)
    if style not in WEIGHTS:
        sys.exit(f"{path}: no weight name ({', '.join(WEIGHTS)}) before the extension")

    font = TTFont(path)
    name = font["name"]
    # nameID 1/2 keep the four-style (Regular/Bold) legacy grouping GDI apps
    # expect; 16/17 carry the real family and weight DirectWrite and browsers use.
    ribbi = style in ("Regular", "Bold")
    legacy_family = family if ribbi else f"{family} {style}"
    legacy_style = style if ribbi else "Regular"
    postscript = f"{family.replace(' ', '')}-{style}"
    for record_id, value in [
        (1, legacy_family), (2, legacy_style), (4, f"{family} {style}"),
        (6, postscript), (16, family), (17, style),
    ]:
        name.removeNames(nameID=record_id)
        name.setName(value, record_id, 3, 1, 0x409)
    font["OS/2"].usWeightClass = WEIGHTS[style]
    font.save(path)
    print(f"{path}: {family} {style} ({WEIGHTS[style]})")
