(async ()=>{
  try{
    const { countTokensForText, countTokensForPath } = require('../tools/python_token_cache.async');
    console.log('counting text...');
    const t = await countTokensForText("print('hello')\n" + 'x'.repeat(200), '.py', true);
    console.log('tokens for text:', t);
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `mana-test-${Date.now()}.py`);
    fs.writeFileSync(tmp, "print('hi')\n" + 'y'.repeat(500), 'utf8');
    const p1 = await countTokensForPath(tmp, true);
    console.log('countTokensForPath first:', p1);
    const p2 = await countTokensForPath(tmp, false);
    console.log('countTokensForPath second:', p2);
    fs.unlinkSync(tmp);
  }catch(e){
    console.error('ERROR', e && e.message, e && e.stack);
  }
})();
