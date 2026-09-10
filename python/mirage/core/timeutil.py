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

import math
from datetime import datetime, timezone


def to_iso_z(dt: datetime) -> str:
    """Render a datetime as UTC ISO-8601 with a ``Z`` suffix.

    The fraction is rendered as exactly three digits (milliseconds)
    when the instant has any, and omitted otherwise; digits below a
    millisecond are dropped before that decision, so an instant 500
    microseconds past the second renders with no fraction rather than
    as ``.000``. That is the one policy both languages can express byte
    for byte: JavaScript's ``Date`` carries milliseconds and never
    more, and ``isoformat()`` would otherwise render six digits for the
    same instant. The TypeScript twin is ``toIsoZ`` (``utils/dates.ts``).

    Args:
        dt (datetime): the instant; a naive value is taken as UTC.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    spec = "milliseconds" if dt.microsecond // 1000 else "seconds"
    return dt.isoformat(timespec=spec).replace("+00:00", "Z")


def now_iso() -> str:
    return to_iso_z(datetime.now(timezone.utc))


def epoch_to_iso(seconds: float) -> str:
    """Convert unix epoch seconds to a second-precision UTC ISO-8601 string.

    Floored to whole seconds (matching the TypeScript ``Math.floor``) so
    the two converters produce byte-identical output for negative
    (pre-1970) fractional timestamps as well.

    Args:
        seconds (float): unix epoch seconds (sub-second part is dropped).
    """
    return to_iso_z(
        datetime.fromtimestamp(math.floor(seconds), tz=timezone.utc))


def iso_to_epoch(iso: str) -> int:
    """Convert an ISO-8601 string to whole unix epoch seconds.

    The inverse of epoch_to_iso; a naive stamp (no offset, e.g. a
    ``touch -t`` overlay time) is read as UTC so Python and TypeScript
    agree. Floored to whole seconds (matching the TypeScript
    ``Math.floor``) so a negative fractional epoch yields the same value
    in both languages.

    Args:
        iso (str): ISO-8601 timestamp, with or without a ``Z``/offset.
    """
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.floor(dt.timestamp())
