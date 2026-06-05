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

import {
  ResourceName,
  command,
  jqGeneric,
  jqProvisionGeneric,
  specOf,
} from '@struktoai/mirage-core'
import { stream as diskStream } from '../../../core/disk/stream.ts'
import { stat as diskStat } from '../../../core/disk/stat.ts'
import type { DiskAccessor } from '../../../accessor/disk.ts'

export const DISK_JQ = command({
  name: 'jq',
  resource: ResourceName.DISK,
  spec: specOf('jq'),
  fn: (accessor: DiskAccessor, paths, texts, opts) =>
    jqGeneric(paths, texts, opts, (p) => diskStream(accessor, p)),
  provision: (accessor: DiskAccessor, paths, texts, _opts) =>
    jqProvisionGeneric(paths, texts, (p) => diskStat(accessor, p)),
})
