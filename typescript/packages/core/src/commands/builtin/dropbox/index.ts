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
import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { read as dropboxRead } from '../../../core/dropbox/read.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { ResourceName } from '../../../types.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { DROPBOX_AWK } from './awk.ts'
import { DROPBOX_BASE64 } from './base64_cmd.ts'
import { DROPBOX_BASENAME } from './basename.ts'
import { DROPBOX_CAT } from './cat.ts'
import { DROPBOX_CMP } from './cmp.ts'
import { DROPBOX_CUT } from './cut.ts'
import { DROPBOX_DIFF } from './diff.ts'
import { DROPBOX_DIRNAME } from './dirname.ts'
import { DROPBOX_DU } from './du.ts'
import { DROPBOX_FILE } from './file.ts'
import { DROPBOX_FIND } from './find.ts'
import { DROPBOX_GREP } from './grep.ts'
import { DROPBOX_HEAD } from './head.ts'
import { DROPBOX_JQ } from './jq.ts'
import { DROPBOX_LS } from './ls.ts'
import { DROPBOX_NL } from './nl.ts'
import { DROPBOX_REALPATH } from './realpath.ts'
import { DROPBOX_RG } from './rg.ts'
import { DROPBOX_SED } from './sed.ts'
import { DROPBOX_SORT } from './sort.ts'
import { DROPBOX_STAT } from './stat.ts'
import { DROPBOX_TAIL } from './tail.ts'
import { DROPBOX_TREE } from './tree.ts'
import { DROPBOX_UNIQ } from './uniq.ts'
import { DROPBOX_WC } from './wc.ts'

export const DROPBOX_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<DropboxAccessor>({
    resource: ResourceName.DROPBOX,
    readBytes: dropboxRead,
    statEntry: dropboxStat,
  }),
  ...DROPBOX_AWK,
  ...DROPBOX_BASE64,
  ...DROPBOX_BASENAME,
  ...DROPBOX_CAT,
  ...DROPBOX_CMP,
  ...DROPBOX_CUT,
  ...DROPBOX_DIFF,
  ...DROPBOX_DIRNAME,
  ...DROPBOX_DU,
  ...DROPBOX_FILE,
  ...DROPBOX_FIND,
  ...DROPBOX_GREP,
  ...DROPBOX_HEAD,
  ...DROPBOX_JQ,
  ...DROPBOX_LS,
  ...DROPBOX_NL,
  ...DROPBOX_REALPATH,
  ...DROPBOX_RG,
  ...DROPBOX_SED,
  ...DROPBOX_SORT,
  ...DROPBOX_STAT,
  ...DROPBOX_TAIL,
  ...DROPBOX_TREE,
  ...DROPBOX_UNIQ,
  ...DROPBOX_WC,
]
