const {spawnSync}=require('node:child_process');
const path=require('node:path');
for(const name of ['integration.cjs','product-integration.cjs']){
 const result=spawnSync(process.execPath,[path.join(__dirname,name)],{stdio:'inherit',env:process.env});
 if(result.status!==0)process.exit(result.status||1);
}
