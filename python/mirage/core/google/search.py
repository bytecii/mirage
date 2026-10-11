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

import logging
from typing import TypeVar

import aiohttp

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.google.constants import RENDERED_WORDS, TOP_LEVEL_DIRS
from mirage.core.google.drive import search_files
from mirage.core.hierarchy.probe import ReaddirFn, entries_under
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)

A = TypeVar("A", bound=GoogleApiAccessor)


def _no_folder(entry: IndexEntry) -> bool:
    return False


def searchable(text: str, vocabulary: frozenset[str]) -> bool:
    """Whether Drive's full-text index can stand in for grep on ``text``
    over an app mount's JSON: a word with no digit (the JSON's indices,
    sizes, colours and ids hold them) that is none of its API's property
    names or enum values, nor a word every rendering may carry.

    Args:
        text (str): the whole word grep searches for.
        vocabulary (frozenset[str]): the app's API words, lowercased.
    """
    folded = text.lower()
    return (
        not any(char.isdigit() for char in text)
        and folded not in vocabulary
        and folded not in RENDERED_WORDS
    )


async def files_containing(
    accessor: A,
    readdir: ReaddirFn[A],
    mime: str,
    vocabulary: frozenset[str],
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The Docs, Sheets or Slides files under ``under`` Drive full-text
    search names.

    One query asks for every file of the app's MIME type holding the
    word, and the answer is matched by id against the owned and shared
    listings grep walks next. None for a word ``searchable`` turns down,
    a scope below a corpus, a listing or search that fails or that Drive
    did not finish, or an empty answer.

    Drive searches a file's text, so the answer can leave out one whose
    JSON holds the word only in a value that is not text: a font, a time
    zone, a link or image address, a tab title, an id or a formula.

    Args:
        accessor (GoogleApiAccessor): backend handle.
        readdir (ReaddirFn): the app's readdir.
        mime (str): the app's MIME type.
        vocabulary (frozenset[str]): the app's API words, lowercased.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the mount's index.
    """
    if not searchable(text, vocabulary):
        return None
    corpora: list[PathSpec] = []
    for directory in under:
        key = directory.vfs_path.strip("/")
        if not key:
            corpora.extend(
                mounted_path(directory, f"/{corpus}")
                for corpus in TOP_LEVEL_DIRS
            )
        elif key in TOP_LEVEL_DIRS:
            corpora.append(directory)
        else:
            return None
    found: list[PathSpec] = []
    try:
        ids, complete = await search_files(
            accessor.token_manager, text, [], mime
        )
        if not complete:
            return None
        named = set(ids)
        for corpus in corpora:
            walked = await entries_under(
                readdir, accessor, corpus, index, _no_folder
            )
            if walked is None:
                return None
            found.extend(path for path, entry in walked if entry.id in named)
    except (OSError, aiohttp.ClientError) as exc:
        logger.warning("drive search failed (%s); reading every file", exc)
        return None
    return found or None
