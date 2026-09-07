import { startWandb } from './fake.ts'
const server = await startWandb(Number(process.argv[2] ?? 5093))
console.log(`WANDB_BASE_URL=${server.base}`)
