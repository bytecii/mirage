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

from mirage.utils.generated.google_vocabulary import (
    DOCS_WORDS,
    SHEETS_WORDS,
    SLIDES_WORDS,
)


def test_each_app_holds_the_names_its_rendering_carries():
    assert {"paragraph", "textrun", "normal_text"} <= DOCS_WORDS
    assert {"formattedvalue", "spreadsheetid"} <= SHEETS_WORDS
    assert {"pageelements", "objectid"} <= SLIDES_WORDS


def test_every_word_is_lowercase_and_free_of_request_types():
    for words in (DOCS_WORDS, SHEETS_WORDS, SLIDES_WORDS):
        assert all(word == word.lower() for word in words)
    assert "insertText".lower() not in DOCS_WORDS
