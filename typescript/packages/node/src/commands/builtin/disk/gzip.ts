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
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { stream as diskStream } from '../../../core/disk/stream.ts'
import { writeBytes as diskWrite } from '../../../core/disk/write.ts'
import { unlink as diskUnlink } from '../../../core/disk/unlink.ts'

export const DISK_GZIP = command({
  name: 'gzip',
  resource: ResourceName.DISK,
  spec: specOf('gzip'),
  fn: (accessor: DiskAccessor, paths, _texts, opts) =>
    gzipGeneric(
      paths,
      opts,
      (p) => diskStream(accessor, p),
      (p, d) => diskWrite(accessor, p, d),
      (p) => diskUnlink(accessor, p),
    ),
  write: true,
})
