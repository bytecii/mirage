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

import { ResourceName, command, specOf, tarGeneric } from '@struktoai/mirage-core'
import { stream as opfsStream } from '../../../core/opfs/stream.ts'
import { writeBytes as opfsWrite } from '../../../core/opfs/write.ts'
import { mkdir as opfsMkdir } from '../../../core/opfs/mkdir.ts'
import type { OPFSAccessor } from '../../../accessor/opfs.ts'

export const OPFS_TAR = command({
  name: 'tar',
  resource: ResourceName.OPFS,
  spec: specOf('tar'),
  fn: (accessor: OPFSAccessor, paths, _texts, opts) =>
    tarGeneric(
      paths,
      opts,
      (p) => opfsStream(accessor, p),
      (p, data) => opfsWrite(accessor, p, data),
      (p) => opfsMkdir(accessor, p),
    ),
  write: true,
})
