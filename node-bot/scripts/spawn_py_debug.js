const { spawn } = require('child_process');
const path = require('path');
const PY_SCRIPT = path.join(__dirname,'..','tools','python_token_cache.py');
const PY_BIN = process.env.PYTHON || 'python';
console.log('spawning', PY_BIN, PY_SCRIPT, '--serve-stdio');
const w = spawn(PY_BIN, [PY_SCRIPT, '--serve-stdio'], { stdio: ['pipe','pipe','pipe'] });

w.stdout.on('data', (c)=>{ console.log('STDOUT:', String(c)); });
w.stderr.on('data', (c)=>{ console.error('STDERR:', String(c)); });
w.on('error',(e)=>{ console.error('ERROR EVENT', e); });
w.on('exit',(code, signal)=>{ console.log('EXIT', code, signal); });
setTimeout(()=>{
  try{ w.kill(); }catch(e){}
  console.log('killed after 5s');
},5000);
