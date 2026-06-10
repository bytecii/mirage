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

import type { DropboxAccessor } from '../../../accessor/dropbox.ts'
import { stat as dropboxStat } from '../../../core/dropbox/stat.ts'
import { ResourceName } from '../../../types.ts'
import { command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { realpathGeneric } from '../generic/realpath.ts'

export const DROPBOX_REALPATH = command({
  name: 'realpath',
  resource: ResourceName.DROPBOX,
  spec: specOf('realpath'),
  fn: (accessor: DropboxAccessor, paths, texts, opts) =>
    realpathGeneric(paths, texts, opts, (p) => dropboxStat(accessor, p, opts.index ?? undefined)),
})
