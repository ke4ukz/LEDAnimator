import { writeFileSync } from 'fs'
import { rp2040MainPy } from './src/export/rp2040'
const out = process.argv[2] || '/tmp/leda_main.py'
writeFileSync(out, rp2040MainPy('dev+test'))
console.log('wrote', out, rp2040MainPy('dev+test').length, 'chars')
