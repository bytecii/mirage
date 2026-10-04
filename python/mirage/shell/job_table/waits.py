# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.shell.job_table.types import Job


class JobWaits:
    """The background jobs started inside a capture (``$( )``, a pipe
    stage), which the capture waits for before it ends: bash reads the
    pipe until every writer has closed it, and a job holds it open."""

    def __init__(self) -> None:
        self.jobs: list[Job] = []

    def add(self, job: Job) -> None:
        """Count a job the capture has to outlast.

        Args:
            job (Job): the job.
        """
        self.jobs.append(job)

    async def join(self) -> None:
        """Return once every job, including any a job started, has ended."""
        # A job added while this waits is still reached: the loop reads
        # the list as it grows.
        for job in self.jobs:
            await job.console.wait_finished()
