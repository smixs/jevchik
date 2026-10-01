// Copies the coverage report to the path the quality gate asks for in $QG_LCOV.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

const target = process.env.QG_LCOV
if (target) {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync('coverage/lcov.info', target)
}
