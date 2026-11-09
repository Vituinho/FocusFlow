import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './store'
import { createLogger } from './logger'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'focusflow-store-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('JsonStore', () => {
  it('returns none when no file exists', () => {
    expect(new JsonStore({ directory: dir }).load()).toEqual({ source: 'none', raw: null })
  })

  it('writes atomically without leaving temporary files and skips identical writes', () => {
    const store = new JsonStore({ directory: dir })
    expect(store.writeNow({ a: 1 })).toBe(true)
    expect(store.writeNow({ a: 1 })).toBe(true)
    expect(store.writes).toBe(1)
    expect(fs.readdirSync(dir)).toEqual(['focusflow.json'])
    expect(new JsonStore({ directory: dir }).load()).toEqual({ source: 'primary', raw: { a: 1 } })
  })

  it('coalesces scheduled writes and flushes the latest value synchronously', () => {
    const store = new JsonStore({ directory: dir, debounceMs: 10_000 })
    let value = 1
    store.schedule(() => ({ value }))
    value = 2
    store.schedule(() => ({ value }))
    expect(fs.existsSync(store.file)).toBe(false)
    store.flush()
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8'))).toEqual({ value: 2 })
    expect(store.writes).toBe(1)
    store.dispose()
  })

  it('quarantines a corrupt file instead of overwriting it and falls back to the backup', () => {
    fs.writeFileSync(path.join(dir, 'focusflow.json'), '{"ok":true}')
    const first = new JsonStore({ directory: dir, now: () => 1 })
    first.load(); first.refreshBackup()
    fs.writeFileSync(path.join(dir, 'focusflow.json'), '{ broken json')
    const store = new JsonStore({ directory: dir, now: () => 2 })
    const result = store.load()
    expect(result).toMatchObject({ source: 'backup', raw: { ok: true } })
    expect(fs.existsSync(path.join(dir, 'focusflow.corrupt.2.json'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'focusflow.corrupt.2.json'), 'utf8')).toBe('{ broken json')
  })

  it('reports none (not defaults) when a corrupt file has no backup, preserving the evidence', () => {
    fs.writeFileSync(path.join(dir, 'focusflow.json'), 'garbage')
    const result = new JsonStore({ directory: dir, now: () => 7 }).load()
    expect(result.source).toBe('none')
    expect(fs.existsSync(path.join(dir, 'focusflow.corrupt.7.json'))).toBe(true)
  })

  it('accepts a UTF-8 BOM and keeps only a bounded number of migration backups', () => {
    fs.writeFileSync(path.join(dir, 'focusflow.json'), '﻿{"x":1}')
    let tick = 0
    const store = new JsonStore({ directory: dir, now: () => ++tick })
    expect(store.load().raw).toEqual({ x: 1 })
    for (let index = 0; index < 8; index++) store.backupForMigration('v1')
    expect(fs.readdirSync(dir).filter(name => name.includes('.v1.')).length).toBe(5)
  })
})

describe('createLogger', () => {
  it('rotates by size and keeps recent warnings in memory', () => {
    const logger = createLogger({ directory: dir, maxBytes: 300, maxFiles: 3 })
    for (let index = 0; index < 20; index++) logger.warn(`message ${index}`)
    const files = fs.readdirSync(dir).sort()
    expect(files).toEqual(['focusflow.log', 'focusflow.log.1', 'focusflow.log.2'])
    expect(logger.recent().at(-1)?.message).toBe('message 19')
    expect(fs.statSync(path.join(dir, 'focusflow.log')).size).toBeLessThanOrEqual(300)
  })

  it('never throws when the directory is unusable', () => {
    const blocker = path.join(dir, 'file')
    fs.writeFileSync(blocker, '')
    const logger = createLogger({ directory: path.join(blocker, 'sub') })
    expect(() => logger.error('boom', new Error('x'))).not.toThrow()
  })
})
