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

import pytest

from mirage.cache.index import IndexCacheStore


@pytest.mark.asyncio
async def test_a_store_that_cannot_tell_answers_that_it_holds_a_subtree():
    # The conservative answer: a caller then drops the whole subtree,
    # which costs a refetch but never serves a removed folder's contents.
    assert await IndexCacheStore().holds_subtree("/a") is True
