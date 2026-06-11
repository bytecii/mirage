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
import type { GDriveAccessor } from '../../../accessor/gdrive.ts'
import { read as gdriveRead } from '../../../core/gdrive/read.ts'
import { stat as gdriveStat } from '../../../core/gdrive/stat.ts'
import { ResourceName } from '../../../types.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { GDOCS_COMMANDS } from '../gdocs/index.ts'
import { GSHEETS_COMMANDS } from '../gsheets/index.ts'
import { GSLIDES_COMMANDS } from '../gslides/index.ts'
import { GDRIVE_AWK } from './awk.ts'
import { GDRIVE_BASE64 } from './base64_cmd.ts'
import { GDRIVE_BASENAME } from './basename.ts'
import { GDRIVE_CAT } from './cat.ts'
import { GDRIVE_CMP } from './cmp.ts'
import { GDRIVE_CUT } from './cut.ts'
import { GDRIVE_DIFF } from './diff.ts'
import { GDRIVE_DIRNAME } from './dirname.ts'
import { GDRIVE_DU } from './du.ts'
import { GDRIVE_FILE } from './file.ts'
import { GDRIVE_FIND } from './find.ts'
import { GDRIVE_GREP } from './grep.ts'
import { GDRIVE_HEAD } from './head.ts'
import { GDRIVE_JQ } from './jq.ts'
import { GDRIVE_LS } from './ls.ts'
import { GDRIVE_NL } from './nl.ts'
import { GDRIVE_COLUMN } from './column.ts'
import { GDRIVE_COMM } from './comm.ts'
import { GDRIVE_EXPAND } from './expand.ts'
import { GDRIVE_FMT } from './fmt.ts'
import { GDRIVE_FOLD } from './fold.ts'
import { GDRIVE_JOIN } from './join.ts'
import { GDRIVE_LOOK } from './look.ts'
import { GDRIVE_MD5 } from './md5.ts'
import { GDRIVE_PASTE } from './paste.ts'
import { GDRIVE_READLINK } from './readlink.ts'
import { GDRIVE_REV } from './rev.ts'
import { GDRIVE_SHA256SUM } from './sha256sum.ts'
import { GDRIVE_SHUF } from './shuf.ts'
import { GDRIVE_STRINGS } from './strings.ts'
import { GDRIVE_TAC } from './tac.ts'
import { GDRIVE_TR } from './tr.ts'
import { GDRIVE_TSORT } from './tsort.ts'
import { GDRIVE_UNEXPAND } from './unexpand.ts'
import { GDRIVE_XXD } from './xxd.ts'
import { GDRIVE_ZCAT } from './zcat.ts'
import { GDRIVE_ZGREP } from './zgrep.ts'
import { GDRIVE_REALPATH } from './realpath.ts'
import { GDRIVE_RG } from './rg.ts'
import { GDRIVE_SED } from './sed.ts'
import { GDRIVE_SORT } from './sort.ts'
import { GDRIVE_STAT } from './stat.ts'
import { GDRIVE_TAIL } from './tail.ts'
import { GDRIVE_TREE } from './tree.ts'
import { GDRIVE_UNIQ } from './uniq.ts'
import { GDRIVE_WC } from './wc.ts'

const GDRIVE_NATIVE: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<GDriveAccessor>({
    resource: ResourceName.GDRIVE,
    readBytes: gdriveRead,
    statEntry: gdriveStat,
  }),
  ...GDRIVE_AWK,
  ...GDRIVE_BASE64,
  ...GDRIVE_BASENAME,
  ...GDRIVE_CAT,
  ...GDRIVE_CMP,
  ...GDRIVE_CUT,
  ...GDRIVE_DIFF,
  ...GDRIVE_DIRNAME,
  ...GDRIVE_DU,
  ...GDRIVE_FILE,
  ...GDRIVE_FIND,
  ...GDRIVE_GREP,
  ...GDRIVE_HEAD,
  ...GDRIVE_JQ,
  ...GDRIVE_LS,
  ...GDRIVE_NL,
  ...GDRIVE_REALPATH,
  ...GDRIVE_RG,
  ...GDRIVE_SED,
  ...GDRIVE_SORT,
  ...GDRIVE_STAT,
  ...GDRIVE_TAIL,
  ...GDRIVE_TREE,
  ...GDRIVE_UNIQ,
  ...GDRIVE_WC,
  ...GDRIVE_COLUMN,
  ...GDRIVE_COMM,
  ...GDRIVE_EXPAND,
  ...GDRIVE_FMT,
  ...GDRIVE_FOLD,
  ...GDRIVE_JOIN,
  ...GDRIVE_LOOK,
  ...GDRIVE_MD5,
  ...GDRIVE_PASTE,
  ...GDRIVE_READLINK,
  ...GDRIVE_REV,
  ...GDRIVE_SHA256SUM,
  ...GDRIVE_SHUF,
  ...GDRIVE_STRINGS,
  ...GDRIVE_TAC,
  ...GDRIVE_TR,
  ...GDRIVE_TSORT,
  ...GDRIVE_UNEXPAND,
  ...GDRIVE_XXD,
  ...GDRIVE_ZCAT,
  ...GDRIVE_ZGREP,
]

const GWS_FOR_GDRIVE: readonly RegisteredCommand[] = [
  ...GDOCS_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
  ...GSHEETS_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
  ...GSLIDES_COMMANDS.filter((c) => c.resource === ResourceName.GDRIVE),
  ...GDRIVE_COLUMN,
  ...GDRIVE_COMM,
  ...GDRIVE_EXPAND,
  ...GDRIVE_FMT,
  ...GDRIVE_FOLD,
  ...GDRIVE_JOIN,
  ...GDRIVE_LOOK,
  ...GDRIVE_MD5,
  ...GDRIVE_PASTE,
  ...GDRIVE_READLINK,
  ...GDRIVE_REV,
  ...GDRIVE_SHA256SUM,
  ...GDRIVE_SHUF,
  ...GDRIVE_STRINGS,
  ...GDRIVE_TAC,
  ...GDRIVE_TR,
  ...GDRIVE_TSORT,
  ...GDRIVE_UNEXPAND,
  ...GDRIVE_XXD,
  ...GDRIVE_ZCAT,
  ...GDRIVE_ZGREP,
]

export const GDRIVE_COMMANDS: readonly RegisteredCommand[] = [...GDRIVE_NATIVE, ...GWS_FOR_GDRIVE]
