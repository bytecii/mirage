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

# Entries and listings must go cold together when the cache format changes.
# v3: the entry payload is the one snake_case document both languages write;
# the TypeScript releases before it wrote camelCase under v2, and a v3 reader
# never opens a v2 row, so no worker has to decode two formats.
ENTRY_PREFIX = "mirage:idx:entry:v3:"
CHILDREN_PREFIX = "mirage:idx:directory:v3:"

# Invalidation tokens are shared across payload formats. Keep this key stable.
GENERATION_KEY = "mirage:idx:children:!generation"
