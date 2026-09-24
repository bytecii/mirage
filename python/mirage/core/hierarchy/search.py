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

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import ScopeMatch


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """One qualified grep/rg push-down request.

    Args:
        pattern (str): the resolved pattern list, as the line typed it.
        ignore_case (bool): -i.
        fixed_string (bool): -F.
        whole_word (bool): -w.
        basic (bool): a basic regular expression, which is what grep
            reads unless -E says otherwise; rg's are extended.
    """
    pattern: str
    ignore_case: bool = False
    fixed_string: bool = False
    whole_word: bool = False
    basic: bool = False


def query_matcher(query: SearchQuery) -> re.Pattern[str]:
    """The matcher the generic scan would compile for this request.

    A searcher that has to decide a line itself (a candidate the service
    returned, or a line it rendered) decides it with this, so what it
    prints is what grep over the same file would print.

    Args:
        query (SearchQuery): the qualified request.
    """
    return compile_pattern(query.pattern,
                           ignore_case=query.ignore_case,
                           fixed_string=query.fixed_string,
                           whole_word=query.whole_word,
                           basic=query.basic)


Searcher = Callable[[A, ScopeMatch, SearchQuery], Awaitable[list[str]]]
