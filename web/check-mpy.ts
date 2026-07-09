// Build-time guard: fail if src/export/firmwareMpy.generated.ts is stale relative
// to rp2040.ts (someone edited the firmware but forgot to rebuild the .mpy blob).
// Hash-only — needs no mpy-cross, so the normal `npm run build` stays Python-free.
import { createHash } from 'crypto'
import { rp2040ModulePy } from './src/export/rp2040'
import { FIRMWARE_MPY } from './src/export/firmwareMpy.generated'

const cur = createHash('sha256').update(rp2040ModulePy('__VERSION__')).digest('hex')
if (cur !== FIRMWARE_MPY.sourceSha) {
  console.error(
    '\n  ✗ firmware blob is STALE: rp2040.ts changed since leda.mpy was built.\n' +
      '    Rebuild it:  npm run gen:mpy\n',
  )
  process.exit(1)
}
console.log(`firmware blob current (${FIRMWARE_MPY.arch}, ${FIRMWARE_MPY.build})`)
