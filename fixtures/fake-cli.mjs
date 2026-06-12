#!/usr/bin/env node
// test/fixtures/fake-cli.mjs — pretends to be a worker CLI: writes a file, prints a token line.
import fs from 'node:fs'
fs.writeFileSync('generated.js', 'export const x = 1\n')
console.log('tokens used: 1234')
