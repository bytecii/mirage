import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readZipEntries } from '../unzip.ts'
import { readArchive, updateArchive } from './zip_update.ts'
import { ZipUpdateError } from './errors.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../../../integ/fixtures/zip/update.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>
const data = (key: string): Uint8Array => new Uint8Array(Buffer.from(fixture[key] ?? '', 'base64'))
const dec = new TextDecoder()

it.each([
  ['original', ''],
  ['original', 'self-extracting stub'],
  ['streamed', ''],
])('preserves opaque members and metadata: %s %s', async (kind, prefix) => {
  const original = readArchive(new Uint8Array(Buffer.concat([Buffer.from(prefix), data(kind)])))
  const result = updateArchive(original, readArchive(data('additions')).records)
  const after = readArchive(result)
  expect(dec.decode(after.prefix)).toBe(prefix)
  expect(after.comment).toEqual(original.comment)
  expect(after.records.map((r) => r.name)).toEqual([
    ...original.records.map((r) => r.name),
    ...['new.xml', 'target.xml', 'café.txt'].filter(
      (name) => !original.records.some((r) => r.name === name),
    ),
  ])
  for (const entry of original.records) {
    if (['target.xml', 'café.txt'].includes(entry.name)) continue
    const kept = after.records.find((r) => r.name === entry.name)
    expect(kept?.local).toEqual(entry.local)
    expect(kept?.central.subarray(0, 42)).toEqual(entry.central.subarray(0, 42))
    expect(kept?.central.subarray(46)).toEqual(entry.central.subarray(46))
  }
  const entries = readZipEntries(result).entries
  for (const [name, value] of [
    ['target.xml', 'updated'],
    ['new.xml', 'new'],
    ['café.txt', 'unicode'],
  ]) {
    expect(dec.decode(await entries.find((r) => r.name === name)?.content())).toBe(value)
  }
})

it.each([
  [4, 1],
  [8, 0xffff],
  [10, 0xffff],
  [12, 0xffffffff],
  [16, 0xffffffff],
])('refuses unsupported end records: %s', (offset, value) => {
  const raw = data('streamed')
  const view = new DataView(raw.buffer)
  if (offset < 12) view.setUint16(raw.length - 22 + offset, value, true)
  else view.setUint32(raw.length - 22 + offset, value, true)
  expect(() => readArchive(raw)).toThrow(ZipUpdateError)
})

it.each(['truncated', 'bad-local', 'bad-central', 'bad-offset'])(
  'refuses corrupt archives: %s',
  (kind) => {
    let raw = data('streamed')
    const central = Buffer.from(raw).indexOf('PK\x01\x02', 0, 'binary')
    if (kind === 'truncated') raw = raw.slice(0, -10)
    else if (kind === 'bad-local') raw[0] = 0
    else if (kind === 'bad-central') raw[central] = 0
    else new DataView(raw.buffer).setUint32(central + 42, central, true)
    expect(() => readArchive(raw)).toThrow(ZipUpdateError)
  },
)

it('preserves leading BOM in member names', () => {
  const original = readArchive(data('bom'))
  const result = readArchive(updateArchive(original, readArchive(data('additions')).records))
  expect(result.records.find((r) => r.name === '\ufefftarget.xml')?.local).toEqual(
    original.records[0]?.local,
  )
  expect(result.records.filter((r) => r.name === 'target.xml')).toHaveLength(1)
  expect(result.records.find((r) => r.name === 'target.xml')?.local).toEqual(
    readArchive(data('additions')).records.find((r) => r.name === 'target.xml')?.local,
  )
})

it.each(['name', 'flags', 'method', 'crc', 'size', 'local-extra', 'central-extra', 'local-zip64'])(
  'refuses inconsistent or ZIP64 local records: %s',
  (kind) => {
    const raw = data(kind === 'local-zip64' ? 'local-zip64' : 'original')
    const view = new DataView(raw.buffer)
    const central = Buffer.from(raw).indexOf('PK\x01\x02', 0, 'binary')
    const offsets: Record<string, number> = { name: 30, flags: 6, method: 8, crc: 14 }
    const offset = offsets[kind]
    if (offset !== undefined) view.setUint8(offset, view.getUint8(offset) ^ 1)
    else if (kind === 'size') view.setUint32(22, 0xffffffff, true)
    else if (kind === 'local-extra') view.setUint16(38, 1, true)
    else if (kind === 'central-extra') view.setUint16(central + 54, 1, true)
    expect(() => readArchive(raw)).toThrow(ZipUpdateError)
  },
)
