import fs from 'node:fs'
import { createHash } from 'node:crypto'

export class Journal {
  constructor(file) {
    this.file = file
    this.cache = new Map()
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const { key, result } = JSON.parse(line); this.cache.set(key, result)
    }
  }
  async step(label, prompt, fn) {
    const key = `${label}:${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`
    if (this.cache.has(key)) return this.cache.get(key)
    const result = await fn()
    this.cache.set(key, result)
    fs.appendFileSync(this.file, JSON.stringify({ key, result }) + '\n')
    return result
  }
}
