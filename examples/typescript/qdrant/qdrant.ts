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

import { pipeline } from '@huggingface/transformers'
import { QdrantClient } from '@qdrant/js-client-rest'
import { MountMode, QdrantResource, Workspace } from '@struktoai/mirage-node'

// The ONNX export of the sentence-transformers model Python's fastembed
// runs, so both examples build the same vector space.
const MODEL = 'Xenova/all-MiniLM-L6-v2'

const PRODUCTS: [string, string, string, string][] = [
  ['Men', 'Tshirts', 'Blue', 'Roadster Men Blue Casual Tshirt'],
  ['Men', 'Tshirts', 'Black', 'HRX Men Black Sports Tshirt'],
  ['Men', 'Shoes', 'White', 'Nike Men White Running Sneakers'],
  ['Men', 'Shoes', 'Black', 'Puma Men Black Formal Shoes'],
  ['Men', 'Jeans', 'Blue', 'Levis Men Blue Casual Jeans'],
  ['Women', 'Tshirts', 'Red', 'Roadster Women Red Casual Tshirt'],
  ['Women', 'Shoes', 'Red', 'Steve Madden Women Red Heels'],
  ['Women', 'Shoes', 'White', 'Adidas Women White Running Sneakers'],
  ['Women', 'Dress', 'Black', 'Zara Women Black Formal Dress'],
  ['Women', 'Jeans', 'Blue', 'H&M Women Blue Summer Jeans'],
]

// (source document, page, chunk text): LangChain-style points whose
// lineage lives in a nested `metadata` payload.
const CHUNKS: [string, string, string][] = [
  [
    's3://docs/policies/refund-2026.pdf',
    '001',
    'Refund policy. An order may be returned within 30 days of delivery.',
  ],
  [
    's3://docs/policies/refund-2026.pdf',
    '004',
    'Refunds are processed within 14 days of the return reaching the warehouse.',
  ],
  [
    's3://docs/hr/leave-policy.pdf',
    '002',
    'Employees accrue 1.5 days of paid leave per month of service.',
  ],
]

type Embed = (texts: string[]) => Promise<number[][]>

async function loadEmbedder(): Promise<Embed> {
  const extractor = await pipeline('feature-extraction', MODEL)
  return async (texts) => {
    const out = await extractor(texts, { pooling: 'mean', normalize: true })
    return out.tolist() as number[][]
  }
}

function client(): QdrantClient {
  const url = process.env.QDRANT_URL
  if (url !== undefined) return new QdrantClient({ url, apiKey: process.env.QDRANT_API_KEY })
  return new QdrantClient({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
  })
}

async function recreate(qc: QdrantClient, collection: string, size: number): Promise<void> {
  if ((await qc.collectionExists(collection)).exists) await qc.deleteCollection(collection)
  await qc.createCollection(collection, { vectors: { size, distance: 'Cosine' } })
}

async function buildCollection(qc: QdrantClient, embed: Embed, collection: string): Promise<void> {
  const vectors = await embed(PRODUCTS.map(([, , , name]) => name))
  await recreate(qc, collection, vectors[0].length)
  const enc = new TextEncoder()
  await qc.upsert(collection, {
    wait: true,
    points: PRODUCTS.map(([gender, articleType, baseColour, name], i) => ({
      id: i + 1,
      vector: vectors[i],
      payload: {
        gender,
        articleType,
        baseColour,
        productDisplayName: name,
        image_b64: Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, ...enc.encode(name)])).toString(
          'base64',
        ),
      },
    })),
  })
  for (const field of ['gender', 'articleType', 'baseColour']) {
    await qc.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword', wait: true })
  }
}

async function buildLineageCollection(
  qc: QdrantClient,
  embed: Embed,
  collection: string,
): Promise<void> {
  const vectors = await embed(CHUNKS.map(([, , text]) => text))
  await recreate(qc, collection, vectors[0].length)
  await qc.upsert(collection, {
    wait: true,
    points: CHUNKS.map(([source, page, text], i) => ({
      id: 101 + i,
      vector: vectors[i],
      payload: { page_content: text, metadata: { source, page } },
    })),
  })
  // Qdrant spells a nested payload path with a dot, in filters and in
  // index names alike; the mount config spells it the same way.
  await qc.createPayloadIndex(collection, {
    field_name: 'metadata.source',
    field_schema: 'keyword',
    wait: true,
  })
}

const DEC = new TextDecoder()

async function show(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n=== ${cmd} ===`)
  const r = await ws.execute(cmd)
  console.log(DEC.decode(r.stdout).trimEnd())
}

async function main(): Promise<void> {
  const embed = await loadEmbedder()
  const qc = client()
  await buildCollection(qc, embed, 'fashion')
  await buildLineageCollection(qc, embed, 'company_docs')

  const connection = {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
    // `search` vectorizes its query through this hook, in-process, so a
    // self-hosted Qdrant with no inference works and mirage itself
    // depends on no model runtime.
    embed: async (text: string): Promise<number[]> => (await embed([text]))[0],
  }
  const fashion = new QdrantResource({
    config: {
      ...connection,
      collection: 'fashion',
      groupBy: ['gender', 'articleType', 'baseColour'],
      idField: 'id',
      textField: 'productDisplayName',
      blobField: 'image_b64',
      blobExt: 'jpg',
      searchLimit: 4,
    },
  })
  // Chunks grouped by the document they came from: `metadata.source` is
  // a nested payload path, `basenameFields` lists it by file name, and
  // `nameField` puts the page label in front of the point id.
  const docs = new QdrantResource({
    config: {
      ...connection,
      collection: 'company_docs',
      groupBy: ['metadata.source'],
      basenameFields: ['metadata.source'],
      nameField: 'metadata.page',
      textField: 'page_content',
      searchLimit: 2,
    },
  })
  const ws = new Workspace({ '/fashion/': fashion, '/docs/': docs }, { mode: MountMode.READ })

  console.log("=== mounted Qdrant collection 'fashion' at /fashion/ ===")

  await show(ws, 'ls /fashion/')
  await show(ws, 'tree -L 2 /fashion/')
  await show(ws, 'ls /fashion/Men/Shoes/White')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.txt')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.json')

  console.log('\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===')
  const s = await ws.execute("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
  console.log(`  image size: ${DEC.decode(s.stdout).trim()} bytes`)

  await show(ws, 'search "white running sneakers" /fashion')

  await show(ws, 'grep -ril blue /fashion/Women')
  await show(ws, 'rg -li running /fashion/Men')

  console.log("\n=== find /fashion -name '*.txt' | wc -l ===")
  const f = await ws.execute("find /fashion -name '*.txt' | wc -l")
  console.log(`  products: ${DEC.decode(f.stdout).trim()}`)

  console.log("\n=== mounted Qdrant collection 'company_docs' at /docs/ ===")
  // One directory per source document, named by its basename; each
  // chunk is `<page>__<point-id>.txt` beside its `.json` payload.
  await show(ws, 'tree /docs/')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.txt')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.json')
  await show(ws, 'search "how long does a refund take" /docs')

  await fashion.close()
  await docs.close()
}

void main()
