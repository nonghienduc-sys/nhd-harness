const path=require('path');
const os=require('os');
const{Service}=require('node-windows');
const root=path.resolve(__dirname,'..');
const bundledRuntime=path.join(root,'node_modules','electron','dist','electron.exe');
const account=process.env.WORKSTATION_SERVICE_ACCOUNT;
const password=process.env.WORKSTATION_SERVICE_PASSWORD;
const domain=process.env.WORKSTATION_SERVICE_DOMAIN||os.hostname();
if((!account||!password)&&process.env.ALLOW_LOCAL_SYSTEM!=='1'){
  console.error('Refusing to install as LocalSystem. Use scripts/install-service-user.ps1 or set ALLOW_LOCAL_SYSTEM=1 explicitly.');
  process.exit(2);
}
if(!require('fs').existsSync(bundledRuntime)){
  console.error('Bundled Electron/Node runtime is missing. Run npm install before installing the service.');
  process.exit(3);
}
const svc=new Service({
  name:'ChatGPT Workstation MCP Bridge',
  description:'Local MCP, file index, PowerShell and tunnel bridge for ChatGPT Web.',
  script:path.join(root,'dist','server.js'),
  execPath:bundledRuntime,
  env:{name:'ELECTRON_RUN_AS_NODE',value:'1'},
  nodeOptions:[],
  workingDirectory:root,
  allowServiceLogon:true,
  stopparentfirst:true,
  stoptimeout:20,
});
if(account&&password){svc.logOnAs.domain=domain;svc.logOnAs.account=account;svc.logOnAs.password=password;}
svc.on('install',()=>{console.log('Service installed.');svc.start()});
svc.on('alreadyinstalled',()=>console.log('Service is already installed.'));
svc.on('error',e=>{console.error(e);process.exitCode=1});
svc.install();
