// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { RegisteredCommand } from '../../config.ts'
import { CHROMA_AWK } from './awk.ts'
import { CHROMA_CAT } from './cat.ts'
import { CHROMA_CUT } from './cut.ts'
import { CHROMA_FIND } from './find.ts'
import { CHROMA_GREP } from './grep.ts'
import { CHROMA_HEAD } from './head.ts'
import { CHROMA_LS } from './ls.ts'
import { CHROMA_RG } from './rg.ts'
import { CHROMA_SEARCH } from './search.ts'
import { CHROMA_SED } from './sed.ts'
import { CHROMA_SORT } from './sort.ts'
import { CHROMA_STAT } from './stat.ts'
import { CHROMA_TAIL } from './tail.ts'
import { CHROMA_TREE } from './tree.ts'
import { CHROMA_UNIQ } from './uniq.ts'
import { CHROMA_WC } from './wc.ts'

export const CHROMA_COMMANDS: readonly RegisteredCommand[] = [
  ...CHROMA_AWK,
  ...CHROMA_CAT,
  ...CHROMA_CUT,
  ...CHROMA_FIND,
  ...CHROMA_GREP,
  ...CHROMA_HEAD,
  ...CHROMA_LS,
  ...CHROMA_RG,
  ...CHROMA_SEARCH,
  ...CHROMA_SED,
  ...CHROMA_SORT,
  ...CHROMA_STAT,
  ...CHROMA_TAIL,
  ...CHROMA_TREE,
  ...CHROMA_UNIQ,
  ...CHROMA_WC,
]
