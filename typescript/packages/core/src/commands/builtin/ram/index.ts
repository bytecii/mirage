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
import type { RAMAccessor } from '../../../accessor/ram.ts'
import { read as ramRead } from '../../../core/ram/read.ts'
import { stat as ramStat } from '../../../core/ram/stat.ts'
import { ResourceName } from '../../../types.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { RAM_AWK } from './awk.ts'
import { RAM_BASE64 } from './base64_cmd.ts'
import { RAM_BASENAME } from './basename.ts'
import { RAM_CAT } from './cat/cat.ts'
import { RAM_CMP } from './cmp.ts'
import { RAM_COLUMN } from './column.ts'
import { RAM_COMM } from './comm.ts'
import { RAM_CP } from './cp.ts'
import { RAM_CSPLIT } from './csplit.ts'
import { RAM_CUT } from './cut/cut.ts'
import { RAM_DIFF } from './diff.ts'
import { RAM_DIRNAME } from './dirname.ts'
import { RAM_DU } from './du.ts'
import { RAM_EXPAND } from './expand.ts'
import { RAM_FILE } from './file/file.ts'
import { RAM_FIND } from './find.ts'
import { RAM_FMT } from './fmt.ts'
import { RAM_FOLD } from './fold.ts'
import { RAM_GREP } from './grep/grep.ts'
import { RAM_GUNZIP } from './gunzip.ts'
import { RAM_GZIP } from './gzip.ts'
import { RAM_HEAD } from './head/head.ts'
import { RAM_ICONV } from './iconv.ts'
import { RAM_JOIN } from './join.ts'
import { RAM_JQ } from './jq.ts'
import { RAM_LN } from './ln.ts'
import { RAM_LOOK } from './look.ts'
import { RAM_LS } from './ls/ls.ts'
import { RAM_MD5 } from './md5.ts'
import { RAM_MKDIR } from './mkdir.ts'
import { RAM_MKTEMP } from './mktemp.ts'
import { RAM_MV } from './mv.ts'
import { RAM_NL } from './nl.ts'
import { RAM_PASTE } from './paste.ts'
import { RAM_PATCH } from './patch.ts'
import { RAM_READLINK } from './readlink.ts'
import { RAM_REALPATH } from './realpath.ts'
import { RAM_REV } from './rev.ts'
import { RAM_RG } from './rg.ts'
import { RAM_RM } from './rm.ts'
import { RAM_SED } from './sed.ts'
import { RAM_SHA256SUM } from './sha256sum.ts'
import { RAM_SHUF } from './shuf.ts'
import { RAM_SORT } from './sort.ts'
import { RAM_SPLIT } from './split.ts'
import { RAM_STAT } from './stat/stat.ts'
import { RAM_STRINGS } from './strings.ts'
import { RAM_TAC } from './tac.ts'
import { RAM_TAIL } from './tail/tail.ts'
import { RAM_TAR } from './tar.ts'
import { RAM_TEE } from './tee.ts'
import { RAM_TOUCH } from './touch.ts'
import { RAM_TR } from './tr.ts'
import { RAM_TREE } from './tree.ts'
import { RAM_TSORT } from './tsort.ts'
import { RAM_UNEXPAND } from './unexpand.ts'
import { RAM_UNIQ } from './uniq.ts'
import { RAM_UNZIP } from './unzip.ts'
import { RAM_WC } from './wc/wc.ts'
import { RAM_XXD } from './xxd.ts'
import { RAM_ZCAT } from './zcat.ts'
import { RAM_ZGREP } from './zgrep.ts'
import { RAM_ZIP } from './zip_cmd.ts'

export const RAM_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<RAMAccessor>({
    resource: ResourceName.RAM,
    readBytes: ramRead,
    statEntry: ramStat,
  }),
  ...RAM_AWK,
  ...RAM_BASE64,
  ...RAM_BASENAME,
  ...RAM_CAT,
  ...RAM_CMP,
  ...RAM_COLUMN,
  ...RAM_COMM,
  ...RAM_CP,
  ...RAM_CSPLIT,
  ...RAM_CUT,
  ...RAM_DIFF,
  ...RAM_DIRNAME,
  ...RAM_DU,
  ...RAM_EXPAND,
  ...RAM_FILE,
  ...RAM_FIND,
  ...RAM_FMT,
  ...RAM_FOLD,
  ...RAM_GREP,
  ...RAM_GUNZIP,
  ...RAM_GZIP,
  ...RAM_HEAD,
  ...RAM_ICONV,
  ...RAM_JOIN,
  ...RAM_JQ,
  ...RAM_LN,
  ...RAM_LOOK,
  ...RAM_LS,
  ...RAM_MD5,
  ...RAM_MKDIR,
  ...RAM_MKTEMP,
  ...RAM_MV,
  ...RAM_NL,
  ...RAM_PASTE,
  ...RAM_PATCH,
  ...RAM_READLINK,
  ...RAM_REALPATH,
  ...RAM_REV,
  ...RAM_RG,
  ...RAM_RM,
  ...RAM_SED,
  ...RAM_SHA256SUM,
  ...RAM_SHUF,
  ...RAM_SORT,
  ...RAM_SPLIT,
  ...RAM_STAT,
  ...RAM_STRINGS,
  ...RAM_TAC,
  ...RAM_TAIL,
  ...RAM_TAR,
  ...RAM_TEE,
  ...RAM_TOUCH,
  ...RAM_TR,
  ...RAM_TREE,
  ...RAM_TSORT,
  ...RAM_UNEXPAND,
  ...RAM_UNIQ,
  ...RAM_UNZIP,
  ...RAM_WC,
  ...RAM_XXD,
  ...RAM_ZCAT,
  ...RAM_ZGREP,
  ...RAM_ZIP,
]
