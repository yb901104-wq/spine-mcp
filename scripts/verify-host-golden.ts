import { writeFile } from 'node:fs/promises';
import { validateHostGolden } from '../src/goldenValidation.js';
const result=await validateHostGolden();
await writeFile('docs/plans/host-golden-20261022.json',JSON.stringify({verifiedAt:new Date().toISOString(),...result},null,2)+'\n');
console.log(JSON.stringify(result));if(result.goldenPassed!==true)process.exitCode=1;
