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

from collections.abc import Sequence
from typing import NamedTuple

from mirage.commands.spec.types import FlagValue
from mirage.types import PathSpec


class ParsedCommand(NamedTuple):
    paths: list[PathSpec]
    texts: list[str]
    flag_kwargs: dict[str, FlagValue]
    warnings: list[str]
    invalid_options: list[str]
    ambiguous_options: list[tuple[str, tuple[str, ...]]]
    option_error_kinds: list[str]
    needs_value_options: list[str]
    invalid_value_options: list[tuple[str, str, tuple[str, ...]]]
    invalid_int_options: list[tuple[str, str]]
    invalid_float_options: list[tuple[str, str]]
    missing_required_options: list[str]
    old_option_needs_value: str | None = None
    # Only a CLI reads these two: the display names of required operand
    # slots the line left empty, and the dests it actually typed in scan
    # order. Both feed a usage line rendered in another program's
    # dialect, which is why they carry names and order at all. Sequence
    # and not list because a NamedTuple default is one shared object.
    missing_required_operands: Sequence[str] = ()
    typed_dests: Sequence[str] = ()
