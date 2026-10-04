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

import type { Job } from './types.ts'

/**
 * The background jobs started inside a capture (`$( )`, a pipe stage),
 * which the capture waits for before it ends: bash reads the pipe until
 * every writer has closed it, and a job holds it open.
 */
export class JobWaits {
  readonly jobs: Job[] = []

  /** Count a job the capture has to outlast. */
  add(job: Job): void {
    this.jobs.push(job)
  }

  /** Return once every job, including any a job started, has ended. */
  async join(): Promise<void> {
    // A job added while this waits is still reached: the loop reads the
    // list as it grows.
    for (const job of this.jobs) await job.console.waitFinished()
  }
}
