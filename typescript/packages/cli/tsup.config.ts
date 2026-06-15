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

import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/mirage.ts'],
  format: ['esm'],
  define: {
    __CLI_VERSION__: JSON.stringify(version),
  },
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
})
