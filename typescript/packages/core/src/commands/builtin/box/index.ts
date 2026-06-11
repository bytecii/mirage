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
import type { BoxAccessor } from '../../../accessor/box.ts'
import { read as boxRead } from '../../../core/box/read.ts'
import { stat as boxStat } from '../../../core/box/stat.ts'
import { ResourceName } from '../../../types.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { BOX_AWK } from './awk.ts'
import { BOX_BASE64 } from './base64_cmd.ts'
import { BOX_BASENAME } from './basename.ts'
import { BOX_CAT } from './cat.ts'
import { BOX_CMP } from './cmp.ts'
import { BOX_CUT } from './cut.ts'
import { BOX_DIFF } from './diff.ts'
import { BOX_DIRNAME } from './dirname.ts'
import { BOX_DU } from './du.ts'
import { BOX_FILE } from './file.ts'
import { BOX_FIND } from './find.ts'
import { BOX_GREP } from './grep.ts'
import { BOX_HEAD } from './head.ts'
import { BOX_JQ } from './jq.ts'
import { BOX_LS } from './ls.ts'
import { BOX_NL } from './nl.ts'
import { BOX_REALPATH } from './realpath.ts'
import { BOX_RG } from './rg.ts'
import { BOX_SED } from './sed.ts'
import { BOX_SORT } from './sort.ts'
import { BOX_STAT } from './stat.ts'
import { BOX_TAIL } from './tail.ts'
import { BOX_TREE } from './tree.ts'
import { BOX_UNIQ } from './uniq.ts'
import { BOX_WC } from './wc.ts'

export const BOX_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<BoxAccessor>({
    resource: ResourceName.BOX,
    readBytes: boxRead,
    statEntry: boxStat,
  }),
  ...BOX_AWK,
  ...BOX_BASE64,
  ...BOX_BASENAME,
  ...BOX_CAT,
  ...BOX_CMP,
  ...BOX_CUT,
  ...BOX_DIFF,
  ...BOX_DIRNAME,
  ...BOX_DU,
  ...BOX_FILE,
  ...BOX_FIND,
  ...BOX_GREP,
  ...BOX_HEAD,
  ...BOX_JQ,
  ...BOX_LS,
  ...BOX_NL,
  ...BOX_REALPATH,
  ...BOX_RG,
  ...BOX_SED,
  ...BOX_SORT,
  ...BOX_STAT,
  ...BOX_TAIL,
  ...BOX_TREE,
  ...BOX_UNIQ,
  ...BOX_WC,
]
