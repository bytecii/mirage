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
"""Measure shell integration coverage independently of unit tests.

From the repository root, after installing dependencies and building TS:
  python/.venv/bin/python integ/runners/tools/shell_coverage.py python --check
  python/.venv/bin/python integ/runners/tools/shell_coverage.py typescript

Scope and measured floors live in integ/shell_coverage.json. Both hosts run the
same RAM cases. Their instrumentation differs, so compare each host to its own
baseline. HTML shows uncovered statements and branches. summary.json records
scope and totals. Failed cases produce reports but cannot pass the gate.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONFIG = ROOT / "integ" / "shell_coverage.json"


async def run(command: list[str], cwd: Path) -> int:
    """Run a coverage tool, inheriting output and propagating its exit status.

    Args:
        command (list[str]): executable and arguments.
        cwd (Path): the implementation's package root.
    """
    proc = await asyncio.create_subprocess_exec(*command, cwd=cwd)
    return await proc.wait()


async def measure(language: str, output: Path, check: bool) -> int:
    """Collect one language's shell-only report and optionally gate its totals.

    Args:
        language (str): Python or TypeScript host.
        output (Path): parent directory of the language's reports.
        check (bool): enforce the committed coverage floors.
    """
    config = json.loads(CONFIG.read_text())
    destination = output / language
    destination.mkdir(parents=True, exist_ok=True)
    selection = [
        "--suite", config["suite"], "--target", config["target"], "--strict"
    ]
    if language == "python":
        cwd = ROOT / "python"
        source = ",".join("mirage." + name.replace("/", ".")
                          for name in config["sources"])
        data = str(destination / ".coverage")
        tool = [sys.executable, "-m", "coverage"]
        status = await run([
            *tool,
            "run",
            "--branch",
            f"--source={source}",
            f"--data-file={data}",
            "--context=shell-integ",
            str(ROOT / "integ/runners/python/main.py"),
            *selection,
        ], cwd)
        for command in [
            [
                *tool, "json", f"--data-file={data}", "--pretty-print",
                "--show-contexts", "-o",
                str(destination / "coverage.json")
            ],
            [
                *tool, "html", f"--data-file={data}", "-d",
                str(destination / "html")
            ],
        ]:
            if await run(command, cwd):
                return 1
        totals = json.loads(
            (destination / "coverage.json").read_text())["totals"]
        counts = {
            "statements": (totals["covered_lines"], totals["num_statements"]),
            "branches": (totals["covered_branches"], totals["num_branches"]),
        }
    else:
        cwd = ROOT / "typescript"
        include = []
        for source in config["sources"]:
            suffix = "/**" if (cwd / "packages/core/src" /
                               source).is_dir() else ".ts"
            include.extend(["--include", f"**/{source}{suffix}"])
        status = await run([
            "node",
            str(ROOT / "integ/node_modules/c8/bin/c8.js"),
            "--all",
            "--src",
            "packages/core/src",
            "--src",
            "packages/node/src",
            *include,
            "--exclude",
            "**/*.test.ts",
            "--exclude",
            "**/fixtures/**",
            "--reporter=json-summary",
            "--reporter=json",
            "--reporter=html",
            "--reporter=text-summary",
            f"--reports-dir={destination}",
            "node",
            "--import",
            str(ROOT / "integ/node_modules/tsx/dist/loader.mjs"),
            str(ROOT / "integ/runners/typescript/main.ts"),
            *selection,
        ], cwd)
        summary_path = destination / "coverage-summary.json"
        if not summary_path.exists():
            return 1
        totals = json.loads(summary_path.read_text())["total"]
        counts = {
            name: (totals[name]["covered"], totals[name]["total"])
            for name in ("statements", "branches")
        }
    if any(total == 0 for _, total in counts.values()):
        print("shell coverage: empty instrumentation report", file=sys.stderr)
        return 1
    percentages = {
        name: 100 * covered / total
        for name, (covered, total) in counts.items()
    }
    summary = {
        "language": language,
        "suite": config["suite"],
        "target": config["target"],
        "sources": config["sources"],
        "passed": status == 0,
        "coverage": {
            name: {
                "covered": covered,
                "total": total,
                "percent": percentages[name]
            }
            for name, (covered, total) in counts.items()
        },
    }
    (destination /
     "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    for name, percent in percentages.items():
        minimum = config["minimum"][language][name]
        print(f"shell {language} {name}: {percent:.2f}% (floor {minimum}%)")
        if check and percent < minimum:
            print(f"shell coverage: {name} fell below its baseline",
                  file=sys.stderr)
            status = 1
    return status


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("language", choices=("python", "typescript"))
    parser.add_argument("--output", type=Path, default=ROOT / "coverage/shell")
    parser.add_argument("--check",
                        action="store_true",
                        help="fail below the measured coverage floors")
    args = parser.parse_args()
    sys.exit(
        asyncio.run(measure(args.language, args.output.resolve(), args.check)))


if __name__ == "__main__":
    main()
