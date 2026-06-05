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

import { stat as ramStat } from '../../../../core/ram/stat.ts'
import { read as ramRead } from '../../../../core/ram/read.ts'
import type { RAMAccessor } from '../../../../accessor/ram.ts'
import { ResourceName } from '../../../../types.ts'
import { command } from '../../../config.ts'
import { specOf } from '../../../spec/builtins.ts'
import { fileGeneric } from '../../generic/file.ts'

export const RAM_FILE = command({
  name: 'file',
  resource: ResourceName.RAM,
  spec: specOf('file'),
  fn: (accessor: RAMAccessor, paths, _texts, opts) =>
    fileGeneric(
      paths,
      opts,
      (p) => ramStat(accessor, p),
      (p) => ramRead(accessor, p),
    ),
})
