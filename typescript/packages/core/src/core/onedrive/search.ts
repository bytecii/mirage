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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { filesContaining as graphFiles } from '../msgraph/search.ts'
import { driveLoc } from './client.ts'
import { readdir } from './readdir.ts'

/**
 * The files under `under` OneDrive search names. See the msgraph
 * `filesContaining` for the files the answer can leave out. Mirrors Python's
 * `files_containing`.
 */
export function filesContaining(
  accessor: OneDriveAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const scopes = under.map((d) => [d, driveLoc(accessor.config, d.vfsPath)] as const)
  return graphFiles(accessor.config, readdir, accessor, scopes, text, index)
}
