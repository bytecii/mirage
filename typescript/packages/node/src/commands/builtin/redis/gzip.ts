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

import { ResourceName, command, specOf, gzipGeneric } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../../accessor/redis.ts'
import { stream as redisStream } from '../../../core/redis/stream.ts'
import { writeBytes as redisWrite } from '../../../core/redis/write.ts'
import { unlink as redisUnlink } from '../../../core/redis/unlink.ts'

export const REDIS_GZIP = command({
  name: 'gzip',
  resource: ResourceName.REDIS,
  spec: specOf('gzip'),
  fn: (accessor: RedisAccessor, paths, _texts, opts) =>
    gzipGeneric(
      paths,
      opts,
      (p) => redisStream(accessor, p),
      (p, d) => redisWrite(accessor, p, d),
      (p) => redisUnlink(accessor, p),
    ),
  write: true,
})
