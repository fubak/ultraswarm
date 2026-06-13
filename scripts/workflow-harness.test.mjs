import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(fs.readFileSync(path.join(root, 'hosts/host-contract.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(root, 'hosts/skills.lock.json'), 'utf8'))

test('all host skills are thin runner adapters with matching provenance', () => {
  assert.equal(lock.contract, contract.version)
  for (const config of Object.values(contract.hosts)) {
    const content = fs.readFileSync(path.join(root, config.skill), 'utf8')
    assert.match(content, new RegExp(contract.runner.replaceAll('.', '\\.')))
    assert.match(content, /separate merge approval/)
    assert.doesNotMatch(content, /```js/)
    assert.equal(createHash('sha256').update(content).digest('hex'), lock.files[config.skill])
  }
})

test('host contract exposes the complete durable command surface', () => {
  assert.deepEqual(contract.approvals, ['plan', 'merge'])
  for (const command of ['run', 'merge', 'status', 'logs', 'cancel', 'resume', 'doctor', 'workers', 'explain-routing', 'export']) {
    assert.ok(contract.commands.includes(command), `missing ${command}`)
  }
})
