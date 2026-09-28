const fs=require('fs');
const path='reports/gtopen-validation/9max-cold-solve-v1/hero-allin-explain.json';
const j=JSON.parse(fs.readFileSync(path,'utf8'));
for(const r of j.preflopRaise){ if(/逐尺寸 EV|逐尺寸响应|资金口径|条件权益|被再加注/.test(r.label)) console.log(r.label+'\n'+r.value+'\n'); }
