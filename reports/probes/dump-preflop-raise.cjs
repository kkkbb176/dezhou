const fs=require('fs');
const j=JSON.parse(fs.readFileSync('reports/gtopen-validation/9max-cold-solve-v1/analysis/raw-production-response.json','utf8'));
const d=j.raw.viewModel.debug;
for (const k of ['preflopRaise','preflopIso','betDecision','multiwayBetDecision']) {
  console.log('===',k,'===');
  console.log(JSON.stringify(d[k],null,2));
}
