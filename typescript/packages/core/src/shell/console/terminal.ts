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

import { concat } from '../../io/cachable_iterator.ts'
import { JobConsole } from './job_console.ts'
import { Channel } from './types.ts'

/**
 * A shell's screen: what its lines and its background jobs wrote, in the
 * order it arrived, until a line takes it.
 *
 * A line writes here through the sink it runs with, a background job
 * through `jobs`, the line's own `JobOutput`. A job that writes while no
 * line runs waits here for the next one, as bash's job prints to the
 * terminal whenever it likes. With a reader attached (a caller streaming
 * the line), every chunk goes straight on to it. A session has one (`tty`),
 * shared by every fork of it.
 */
export class Terminal extends JobConsole {
  chunks: [Channel, Uint8Array, boolean][] = []
  reader: JobConsole | null = null
  readonly jobs: JobOutput = new JobOutput(new JobSide(this))

  /** Take what the line wrote. */
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await this.put(channel, data, false)
  }

  /** Pass a chunk to the reader, or keep it for the line; `job` says a job wrote it. */
  async put(channel: Channel, data: Uint8Array, job: boolean): Promise<void> {
    if (data.byteLength === 0) return
    if (this.reader !== null) {
      await this.reader.emit(channel, data)
      return
    }
    this.chunks.push([channel, data, job])
  }

  /** Start a line, handing a streaming caller (`reader`) what waited for it. */
  async attach(reader: JobConsole | null): Promise<void> {
    this.reader = reader
    if (reader === null) return
    const waiting = this.chunks
    this.chunks = []
    for (const [channel, data] of waiting) await reader.emit(channel, data)
  }

  /** What reached the terminal so far, taken out to be bounded and put back. */
  drain(): [Uint8Array, Uint8Array] {
    const chunks = this.chunks
    this.chunks = []
    const out = concat(chunks.filter(([c]) => c === Channel.STDOUT).map(([, data]) => data))
    const err = concat(chunks.filter(([c]) => c === Channel.STDERR).map(([, data]) => data))
    return [out, err]
  }

  /** Return drained output ahead of whatever arrived meanwhile. */
  putBack(out: Uint8Array, err: Uint8Array): void {
    const returned: [Channel, Uint8Array, boolean][] = []
    if (out.byteLength > 0) returned.push([Channel.STDOUT, out, false])
    if (err.byteLength > 0) returned.push([Channel.STDERR, err, false])
    this.chunks = [...returned, ...this.chunks]
  }

  /** End a line: its stdout and stderr, jobs' output among them. */
  take(): [Uint8Array, Uint8Array] {
    this.reader = null
    return this.drain()
  }

  /** End an abandoned line: what it wrote goes, its jobs' stays. */
  dropLine(): void {
    this.chunks = this.chunks.filter(([, , job]) => job)
    this.reader = null
  }
}

/** Where the background jobs write on a terminal. */
export class JobSide extends JobConsole {
  constructor(readonly terminal: Terminal) {
    super()
  }

  /** Take what a job wrote. */
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await this.terminal.put(channel, data, true)
  }
}

/**
 * Where the background jobs one shell (a line, a subshell, a job, a
 * substitution, a pipe stage) starts write.
 *
 * Into the statement that shell is running, among what the statement
 * writes, so the two keep the order they were written in; when it runs
 * none (between statements, or once it has ended), on to where the shell
 * itself writes (`target`). A session's `jobOutput` is null in a typed
 * line, whose jobs write through its terminal's `jobs`.
 */
export class JobOutput extends JobConsole {
  recorder: JobConsole | null = null

  constructor(readonly target: JobConsole) {
    super()
  }

  /** Write what a job wrote where it belongs now. */
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.recorder !== null) {
      await this.recorder.emit(channel, data)
      return
    }
    await this.target.emit(channel, data)
  }
}

/**
 * A job's output, kept in its own console and copied to where the shell
 * that started it writes.
 */
export class Tee extends JobConsole {
  constructor(
    readonly console: JobConsole,
    readonly copy: JobConsole,
  ) {
    super()
  }

  /** Write to both. */
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await this.console.emit(channel, data)
    await this.copy.emit(channel, data)
  }
}
