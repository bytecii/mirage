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

import { makeFiletypeCommands, ResourceName, type RegisteredCommand } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { read as redisRead } from '../../../core/redis/read.ts'
import { stat as redisStat } from '../../../core/redis/stat.ts'
import { REDIS_AWK } from './awk.ts'
import { REDIS_BASE64 } from './base64_cmd.ts'
import { REDIS_BASENAME } from './basename.ts'
import { REDIS_CAT } from './cat/cat.ts'
import { REDIS_CMP } from './cmp.ts'
import { REDIS_COLUMN } from './column.ts'
import { REDIS_COMM } from './comm.ts'
import { REDIS_CP } from './cp.ts'
import { REDIS_CSPLIT } from './csplit.ts'
import { REDIS_CUT } from './cut/cut.ts'
import { REDIS_DIFF } from './diff.ts'
import { REDIS_DIRNAME } from './dirname.ts'
import { REDIS_DU } from './du.ts'
import { REDIS_EXPAND } from './expand.ts'
import { REDIS_FILE } from './file/file.ts'
import { REDIS_FIND } from './find.ts'
import { REDIS_FMT } from './fmt.ts'
import { REDIS_FOLD } from './fold.ts'
import { REDIS_GREP } from './grep/grep.ts'
import { REDIS_GUNZIP } from './gunzip.ts'
import { REDIS_GZIP } from './gzip.ts'
import { REDIS_HEAD } from './head/head.ts'
import { REDIS_ICONV } from './iconv.ts'
import { REDIS_JOIN } from './join.ts'
import { REDIS_JQ } from './jq.ts'
import { REDIS_LN } from './ln.ts'
import { REDIS_LOOK } from './look.ts'
import { REDIS_LS } from './ls/ls.ts'
import { REDIS_MD5 } from './md5.ts'
import { REDIS_MKDIR } from './mkdir.ts'
import { REDIS_MKTEMP } from './mktemp.ts'
import { REDIS_MV } from './mv.ts'
import { REDIS_NL } from './nl.ts'
import { REDIS_PASTE } from './paste.ts'
import { REDIS_PATCH } from './patch.ts'
import { REDIS_READLINK } from './readlink.ts'
import { REDIS_REALPATH } from './realpath.ts'
import { REDIS_REV } from './rev.ts'
import { REDIS_RG } from './rg.ts'
import { REDIS_RM } from './rm.ts'
import { REDIS_SED } from './sed.ts'
import { REDIS_SHA256SUM } from './sha256sum.ts'
import { REDIS_SHUF } from './shuf.ts'
import { REDIS_SORT } from './sort.ts'
import { REDIS_SPLIT } from './split.ts'
import { REDIS_STAT } from './stat/stat.ts'
import { REDIS_STRINGS } from './strings.ts'
import { REDIS_TAC } from './tac.ts'
import { REDIS_TAIL } from './tail/tail.ts'
import { REDIS_TAR } from './tar.ts'
import { REDIS_TEE } from './tee.ts'
import { REDIS_TOUCH } from './touch.ts'
import { REDIS_TR } from './tr.ts'
import { REDIS_TREE } from './tree.ts'
import { REDIS_TSORT } from './tsort.ts'
import { REDIS_UNEXPAND } from './unexpand.ts'
import { REDIS_UNIQ } from './uniq.ts'
import { REDIS_UNZIP } from './unzip.ts'
import { REDIS_WC } from './wc/wc.ts'
import { REDIS_XXD } from './xxd.ts'
import { REDIS_ZCAT } from './zcat.ts'
import { REDIS_ZGREP } from './zgrep.ts'
import { REDIS_ZIP } from './zip_cmd.ts'

export const REDIS_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<RedisAccessor>({
    resource: ResourceName.REDIS,
    readBytes: redisRead,
    statEntry: redisStat,
  }),
  ...REDIS_AWK,
  ...REDIS_BASE64,
  ...REDIS_BASENAME,
  ...REDIS_CAT,
  ...REDIS_CMP,
  ...REDIS_COLUMN,
  ...REDIS_COMM,
  ...REDIS_CP,
  ...REDIS_CSPLIT,
  ...REDIS_CUT,
  ...REDIS_DIFF,
  ...REDIS_DIRNAME,
  ...REDIS_DU,
  ...REDIS_EXPAND,
  ...REDIS_FILE,
  ...REDIS_FIND,
  ...REDIS_FMT,
  ...REDIS_FOLD,
  ...REDIS_GREP,
  ...REDIS_GUNZIP,
  ...REDIS_GZIP,
  ...REDIS_HEAD,
  ...REDIS_ICONV,
  ...REDIS_JOIN,
  ...REDIS_JQ,
  ...REDIS_LN,
  ...REDIS_LOOK,
  ...REDIS_LS,
  ...REDIS_MD5,
  ...REDIS_MKDIR,
  ...REDIS_MKTEMP,
  ...REDIS_MV,
  ...REDIS_NL,
  ...REDIS_PASTE,
  ...REDIS_PATCH,
  ...REDIS_READLINK,
  ...REDIS_REALPATH,
  ...REDIS_REV,
  ...REDIS_RG,
  ...REDIS_RM,
  ...REDIS_SED,
  ...REDIS_SHA256SUM,
  ...REDIS_SHUF,
  ...REDIS_SORT,
  ...REDIS_SPLIT,
  ...REDIS_STAT,
  ...REDIS_STRINGS,
  ...REDIS_TAC,
  ...REDIS_TAIL,
  ...REDIS_TAR,
  ...REDIS_TEE,
  ...REDIS_TOUCH,
  ...REDIS_TR,
  ...REDIS_TREE,
  ...REDIS_TSORT,
  ...REDIS_UNEXPAND,
  ...REDIS_UNIQ,
  ...REDIS_UNZIP,
  ...REDIS_WC,
  ...REDIS_XXD,
  ...REDIS_ZCAT,
  ...REDIS_ZGREP,
  ...REDIS_ZIP,
]
