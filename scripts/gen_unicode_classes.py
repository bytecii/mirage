# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import hashlib
import pathlib
import sys
import urllib.request

from gen_unicode_width import VERSION, categories, entries, ranges, rows

ROOT = pathlib.Path(__file__).resolve().parent.parent
RS_OUT = ROOT / "rust/mirage-rs/src/generated/unicode_classes.rs"

# The data files the POSIX classes of a UTF-8 locale are drawn from, at
# the Unicode version gen_unicode_width.py reads; integ's grep and sed
# class cases check the rules below against the pinned image.
FILES = {
    "UnicodeData.txt": (
        "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f"
    ),
    "PropList.txt": (
        "53d614508e2a0b2305a8aa21cd60d993de9326cdf65993660dfcce4503548583"
    ),
    "DerivedCoreProperties.txt": (
        "39d35161f2954497f69e08bdb9e701493f476a3d30222de20028feda36c1dabd"
    ),
    "SpecialCasing.txt": (
        "8d5de354eef79f2395a54c9c7dcebbaf3d30fc962d0f85611ea97aa973a0c451"
    ),
}

# The no-break spaces, which are graphic and no blank or space.
NO_BREAK = {0xA0, 0x2007, 0x202F}

CLASSES = (
    "alnum",
    "alpha",
    "blank",
    "cntrl",
    "digit",
    "graph",
    "lower",
    "print",
    "punct",
    "space",
    "upper",
    "xdigit",
)


def fetch(name: str) -> str:
    url = f"https://www.unicode.org/Public/{VERSION}/ucd/{name}"
    request = urllib.request.Request(url, headers={"User-Agent": "mirage"})
    with urllib.request.urlopen(request) as response:
        data: bytes = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != FILES[name]:
        raise SystemExit(f"{name}: sha256 {digest}, want {FILES[name]}")
    return data.decode("utf-8")


def single(table: dict[int, list[int]]) -> dict[int, int]:
    """The mappings to one other code point."""
    return {
        cp: to[0] for cp, to in table.items() if len(to) == 1 and to[0] != cp
    }


def case_maps() -> tuple[dict[int, int], dict[int, int]]:
    """Each code point's full uppercase and lowercase mapping when it is
    one other code point: SpecialCasing.txt's unconditional mappings, and
    UnicodeData.txt's simple ones where it has none."""
    upper: dict[int, list[int]] = {}
    lower: dict[int, list[int]] = {}
    for line in fetch("UnicodeData.txt").splitlines():
        fields = line.split(";")
        cp = int(fields[0], 16)
        if fields[12]:
            upper[cp] = [int(fields[12], 16)]
        if fields[13]:
            lower[cp] = [int(fields[13], 16)]
    for line in fetch("SpecialCasing.txt").splitlines():
        fields = [f.strip() for f in line.split("#")[0].split(";")]
        if len(fields) < 5 or fields[4]:
            continue
        cp = int(fields[0], 16)
        lower[cp] = [int(x, 16) for x in fields[1].split()]
        upper[cp] = [int(x, 16) for x in fields[3].split()]

    return single(upper), single(lower)


def classes() -> dict[str, list[int]]:
    """Each class's members under a UTF-8 locale, from the properties as
    the C.UTF-8 locale draws them:
    - alpha takes the decimal digits of other scripts;
    - the no-break spaces are no space or blank, and NEL is no space;
    - the line and paragraph separators are controls;
    - graph and print take private use and format characters;
    - a letter with a case mapping is upper or lower (so the titlecase
      letters are upper, and the Latin ones lower too).

    Digits stay ASCII, as POSIX asks of digit and xdigit.
    """
    category, _ = categories(fetch("UnicodeData.txt"))
    props = entries(fetch("PropList.txt")) + entries(
        fetch("DerivedCoreProperties.txt")
    )
    named = {
        name: {cp for span, value in props if value == name for cp in span}
        for name in ("White_Space", "Alphabetic", "Lowercase", "Uppercase")
    }
    upper_of, lower_of = case_maps()
    out: dict[str, list[int]] = {name: [] for name in CLASSES}
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        gc = category.get(cp, "Cn")
        alnum = cp in named["Alphabetic"] or gc == "Nd"
        graph = (
            gc not in ("Cc", "Cn") and not gc.startswith("Z")
        ) or cp in NO_BREAK
        member = {
            "alnum": alnum,
            "alpha": alnum and not 0x30 <= cp <= 0x39,
            "blank": cp == 0x09 or (gc == "Zs" and cp not in NO_BREAK),
            "cntrl": gc in ("Cc", "Zl", "Zp"),
            "digit": 0x30 <= cp <= 0x39,
            "graph": graph,
            "lower": cp in named["Lowercase"] or cp in upper_of,
            "print": gc not in ("Cc", "Cn", "Zl", "Zp"),
            "punct": graph and not alnum,
            "space": cp in named["White_Space"]
            and cp != 0x85
            and cp not in NO_BREAK,
            "upper": cp in named["Uppercase"] or cp in lower_of,
            "xdigit": chr(cp) in "0123456789ABCDEFabcdef",
        }
        for name, inside in member.items():
            if inside:
                out[name].append(cp)
    return out


def table(name: str, codes: list[int]) -> str:
    spans = ranges(codes)
    head = f"pub(crate) const {name.upper()}: &[(u32, u32)] = &"
    inline = ", ".join(f"(0x{lo:04X}, 0x{hi:04X})" for lo, hi in spans)
    # rustfmt keeps an array on one line while it fits in 60 columns.
    if len(inline) + 2 <= 60:
        return f"{head}[{inline}];"
    return f"{head}[\n{rows(spans)}\n];"


def render(members: dict[str, list[int]]) -> str:
    tables = "\n\n".join(table(name, codes) for name, codes in members.items())
    return f"""// GENERATED by scripts/gen_unicode_classes.py from the Unicode {VERSION}
// Character Database (UnicodeData.txt, PropList.txt,
// DerivedCoreProperties.txt, SpecialCasing.txt). Do not edit by hand;
// rerun the script.

// The POSIX character classes of a UTF-8 locale, as code point ranges.

{tables}
"""


def main() -> int:
    RS_OUT.write_text(render(classes()))
    print(f"Unicode {VERSION}: wrote {RS_OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
