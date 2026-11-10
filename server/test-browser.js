const {spawn}=require('node:child_process');
const net=require('node:net');
const mongoose=require('mongoose');
async function main(){
  const name=`velathier_test_${Date.now()}_${process.pid}`;
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const env={...process.env,NODE_ENV:'development',MONGO_URI:`mongodb://127.0.0.1:27017/${name}`,PORT:String(port),TEST_BASE_URL:`http://127.0.0.1:${port}`,PUBLIC_URL:`http://127.0.0.1:${port}`,SMTP_HOST:'',SMTP_USER:'',VNP_TMN_CODE:'',VNP_HASH_SECRET:'',DISABLE_RATE_LIMIT:'1'};
  Object.assign(env,{PRIVATE_STORAGE_PROVIDER:'local',PRIVATE_STORAGE_ROOT:require('node:path').resolve('server/private/test-storage',name),JWT_SECRET:'isolated-test-jwt-secret-never-production',VNP_REFUND_AUTOMATION_ENABLED:'0'});
  const run=args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{env,windowsHide:true,stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(`Test command exited ${c}`)));});
  let server;
  try{
    await run(['server/seed.js']);await run(['server/migrate-custom-print.js']);await run(['server/migrate-print-srs.js']);
    server=spawn(process.execPath,['server/server.js'],{env,windowsHide:true,stdio:'ignore'});
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(env.TEST_BASE_URL+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('Browser test server did not start');
    await run([require.resolve('@playwright/test/cli'),'test','--config=playwright.config.cjs',...process.argv.slice(2)]);
  }finally{
    if(server?.exitCode===null){const exited=new Promise(r=>server.once('exit',r));server.kill();await exited;}
    await mongoose.connect(env.MONGO_URI);if(mongoose.connection.name!==name)throw Error('Unsafe cleanup');await mongoose.connection.dropDatabase();await mongoose.disconnect();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
