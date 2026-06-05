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

import { du as ramDu, duAll as ramDuAll } from '../../../core/ram/du.ts'
import type { RAMAccessor } from '../../../accessor/ram.ts'
import { ResourceName } from '../../../types.ts'
import { command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { duGeneric } from '../generic/du.ts'

export const RAM_DU = command({
  name: 'du',
  resource: ResourceName.RAM,
  spec: specOf('du'),
  fn: (accessor: RAMAccessor, paths, _texts, opts) =>
    duGeneric(
      paths,
      opts,
      (p) => ramDu(accessor, p),
      (p) => ramDuAll(accessor, p),
    ),
})
