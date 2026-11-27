import { existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,lstatSync,unlinkSync,openSync,closeSync,cpSync,rmdirSync } from 'node:fs';
import { join,resolve,relative,dirname,basename,isAbsolute,sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { collectPackage,validatePackage,writePackage,sha256 } from './package.mjs';
import { stopRuntimes } from './runtime-control.mjs';
import { configureLaunchers,restoreLaunchers,planLauncherChanges } from './launcher.mjs';
import { syncBundledAgyFast,cleanupBundledAgyFast,removePathSafe } from './agy-fast-bundle.mjs';
import { createModuleRegistry } from '../packages/core/module-registry.mjs';

export { removePathSafe };

export function installationPaths(home=homedir()){
  const root=join(resolve(home),'.gemini');
  return {home:resolve(home),root,config:join(root,'config','config.json'),installed:join(root,'config','plugins','agy-max'),data:join(root,'antigravity','plugin_data','agy-max'),sidecars:join(root,'antigravity','sidecar_data','agy-max'),brain:join(root,'antigravity','brain')};
}
export function assertOwnedPath(root,target){
  const rel=relative(resolve(root),resolve(target));if(!rel||isOutside(rel))throw Error('目标路径越界');
  let path=resolve(root);if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('目标目录不能是符号链接');
  for(const part of rel.split(/[\\/]/)){path=join(path,part);if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('目标路径包含符号链接');}
  return resolve(target);
}
function isOutside(rel){return rel==='..'||rel.startsWith('..'+sep)||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel);}
function assertTree(path){const stat=lstatSync(path,{throwIfNoEntry:false});if(!stat)return;if(stat.isSymbolicLink())throw Error('清理目录中包含符号链接');if(stat.isDirectory())for(const name of readdirSync(path))assertTree(join(path,name));}
function removeTree(root,path){assertOwnedPath(root,path);assertTree(path);removePathSafe(path);}
function isSameOrAncestor(parent,child){return !isOutside(relative(resolve(parent),resolve(child)));}
function removeTreePreserving(root,target,preserve){
  const resolvedTarget=resolve(target),relevant=preserve.filter(p=>isSameOrAncestor(resolvedTarget,p));
  if(!relevant.length){removeTree(root,target);return;}
  if(relevant.some(p=>relative(resolvedTarget,resolve(p))===''))return;
  assertOwnedPath(root,target);
  const stat=lstatSync(target,{throwIfNoEntry:false});if(!stat)return;
  if(stat.isSymbolicLink())throw Error('清理目录中包含符号链接');
  if(!stat.isDirectory())return;
  for(const name of readdirSync(target))removeTreePreserving(root,join(target,name),relevant);
}
async function move(from,to){for(let i=0;;i++){try{renameSync(from,to);return;}catch(error){if(i>=20||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}}}
function synchronize(from,to){
  assertTree(from);assertTree(to);
  function prepare(source,target){
    const directory=lstatSync(source).isDirectory();
    if(existsSync(target)&&lstatSync(target).isDirectory()!==directory)removeTree(to,target);
    if(directory){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))prepare(join(source,name),join(target,name));}
  }
  prepare(from,to);cpSync(from,to,{recursive:true,force:true});
  function prune(source,target){for(const name of readdirSync(target)){
    const path=join(target,name),original=join(source,name);
    if(existsSync(original)){if(lstatSync(path).isDirectory())prune(original,path);continue;}
    if(lstatSync(path).isDirectory()){prune(original,path);try{rmdirSync(path);}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;}}
    else unlinkSync(path);
  }}prune(from,to);
}
const retryableRename=error=>['EPERM','EACCES','EBUSY'].includes(error.code);
const renameWait=new Int32Array(new SharedArrayBuffer(4));
export function atomicJson(path,value,{beforeRename}={}){
  mkdirSync(dirname(path),{recursive:true});const temp=join(dirname(path),'.agy-'+randomUUID()+'.tmp');
  try{
    writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
    for(let attempt=0;;attempt++){
      beforeRename?.();
      try{renameSync(temp,path);break;}catch(error){
        if(process.platform!=='win32'||attempt>=5||!retryableRename(error))throw error;
        Atomics.wait(renameWait,0,0,20*(attempt+1));
      }
    }
  }finally{try{unlinkSync(temp);}catch{}}
}
function readConfigBytes(path){try{return readFileSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function readConfig(path,bytes=readConfigBytes(path)){
  if(!bytes)return{};
  const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('客户端配置格式无效');
  return value;
}
const configBackupRoot=paths=>join(paths.root,'antigravity','backups');
const hashBytes=bytes=>bytes===null?null:sha256(bytes);
const CONFIG_CHANGED=Symbol('config changed');
function configTransaction(paths){
  let backupDir=null;
  const files=[];
  function backup(path,bytes){
    if(bytes===null||files.some(file=>file.path===path))return;
    if(!backupDir){
      const stamp=new Date().toISOString().slice(0,19).replaceAll('-','').replaceAll(':','').replace('T','-');
      backupDir=join(configBackupRoot(paths),`agy-max-${stamp}-${randomUUID().slice(0,8)}`);
      assertOwnedPath(paths.home,backupDir);
      mkdirSync(dirname(backupDir),{recursive:true});mkdirSync(backupDir,{mode:0o700});
    }
    const entry={path,size:bytes.length,sha256:hashBytes(bytes)};
    writeFileSync(join(backupDir,basename(path)),bytes,{mode:0o600,flag:'wx'});
    atomicJson(join(backupDir,'manifest.json'),{files:[...files,entry]});
    files.push(entry);
  }
  return {
    get backupDir(){return backupDir;},
    change(path,mutate){
      for(let attempt=0;attempt<5;attempt++){
        assertOwnedPath(paths.home,path);
        const bytes=readConfigBytes(path),hash=hashBytes(bytes),config=readConfig(path,bytes);
        const before=JSON.stringify(config);
        mutate(config);
        if(before===JSON.stringify(config))return false;
        try{
          atomicJson(path,config,{beforeRename:()=>{
            assertOwnedPath(paths.home,path);
            if(hashBytes(readConfigBytes(path))!==hash)throw CONFIG_CHANGED;
            backup(path,bytes);
            if(hashBytes(readConfigBytes(path))!==hash)throw CONFIG_CHANGED;
          }});
          return true;
        }catch(error){
          if(error!==CONFIG_CHANGED)throw error;
          if(attempt<4)Atomics.wait(renameWait,0,0,40*(attempt+1));
        }
      }
      throw Error('客户端配置在更新期间已更改，请重试');
    }
  };
}
const CORRUPT_LOCK_GRACE_MS=2000;
function isProcessAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code!=='ESRCH';}
}
export function acquireLockFile(path,{busyMessage='已有操作正在进行',corruptGraceMs=CORRUPT_LOCK_GRACE_MS,now=Date.now,isAlive=isProcessAlive}={}){
  const nonce=randomUUID();let handle;
  for(let attempt=0;attempt<2;attempt++){
    try{handle=openSync(path,'wx');break;}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(attempt>0)throw Error(busyMessage);
      let raw,mtimeMs=0;
      try{mtimeMs=lstatSync(path).mtimeMs;raw=readFileSync(path,'utf8');}catch(readError){
        if(readError?.code==='ENOENT')continue;
        throw readError;
      }
      let lock=null,corrupt=false;
      try{lock=JSON.parse(raw);}catch{corrupt=true;}
      if(corrupt){
        if(now()-mtimeMs<corruptGraceMs)throw Error(busyMessage);
      }else{
        const pid=lock&&typeof lock==='object'?lock.pid:null;
        if(Number.isInteger(pid)&&pid>0&&isAlive(pid))throw Error(busyMessage);
      }
      try{unlinkSync(path);}catch(unlinkError){if(unlinkError?.code!=='ENOENT')throw unlinkError;}
    }
  }
  try{writeFileSync(handle,JSON.stringify({pid:process.pid,nonce}));closeSync(handle);}
  catch(error){try{closeSync(handle);}catch{}try{unlinkSync(path);}catch{}throw error;}
  return nonce;
}
export function releaseLockFile(path,nonce){
  if(!nonce)return;
  try{if(JSON.parse(readFileSync(path,'utf8')).nonce===nonce)unlinkSync(path);}catch{}
}
async function withLock(paths,fn){
  const path=join(dirname(paths.data),'.agy-max.lock');
  assertOwnedPath(paths.home,path);mkdirSync(dirname(path),{recursive:true});
  const nonce=acquireLockFile(path,{busyMessage:'已有安装或更新正在进行'});
  try{return await fn();}finally{releaseLockFile(path,nonce);}
}
function setPlugin(paths,changeConfig,value){changeConfig(paths.config,config=>{
  if(value===undefined)delete config.plugins?.['agy-max'];
  else{config.plugins||={};config.plugins['agy-max']=value;}
});}
function setPluginEnabled(paths,changeConfig,enabled,{existingOnly=false}={}){
  changeConfig(paths.config,config=>{
    const entry=config.plugins?.['agy-max'];
    if(existingOnly&&entry===undefined)return;
    config.plugins||={};config.plugins['agy-max']={...entry,enabled};
  });
}
function wantsAgyFast(paths){
  const settingsPath=assertOwnedPath(paths.home,join(paths.data,'settings.json'));
  const settings=readConfig(settingsPath);
  const modManifest=readConfig(assertOwnedPath(paths.home,join(paths.data,'modules-manifest.json')));
  const navDisabled=Array.isArray(modManifest?.installed)&&!modManifest.installed.includes('workspace-nav')&&Array.isArray(modManifest?.explicitlyUninstalled)&&modManifest.explicitlyUninstalled.includes('workspace-nav');
  return settings.enabled!==false&&settings.agyFast!==false&&!navDisabled;
}
const isMaxSidecar=key=>key==='agy-max'||key.startsWith('agy-max/');
const isMaxHook=key=>key==='agy-max-telemetry'||key.startsWith('agy-max/');

export function parseLifecycleArgs(args,{uninstall=false}={}){
  const options={home:{type:'string'},help:{type:'boolean',short:'h'},'dry-run':{type:'boolean'},json:{type:'boolean'},'skip-agy-fast':{type:'boolean'}};
  if(uninstall)options['keep-settings']={type:'boolean'};
  const {values,tokens}=parseArgs({args,options,tokens:true});
  if('home' in values&&(!values.home.trim()||values.home.startsWith('-')||tokens.filter(token=>token.name==='home').length!==1)){
    throw Error('--home 需要一个有效的目录路径');
  }
  return values;
}

export function planLifecycle({source,home=homedir(),uninstall=false,purge=true,skipAgyFast=false}={}){
  const paths=installationPaths(home),hooks=join(paths.root,'config','hooks.json');
  for(const path of [paths.config,hooks,paths.installed,paths.data,configBackupRoot(paths)])assertOwnedPath(paths.home,path);
  const config=readConfig(paths.config),hookConfig=uninstall?readConfig(hooks):{};
  const existing=Boolean(lstatSync(paths.installed,{throwIfNoEntry:false}));
  const agyFast={destination:join(dirname(paths.installed),'agy-fast'),action:'skip'};
  if(!skipAgyFast)agyFast.action=uninstall?'remove-managed-or-restore-parked':wantsAgyFast(paths)?'install-or-enable':'disable';
  const configKeys=uninstall?[
    ...(config.plugins?.['agy-max']!==undefined?['plugins.agy-max']:[]),
    ...Object.keys(config.sidecars||{}).filter(isMaxSidecar).map(key=>`sidecars.${key}`)
  ]:[
    'plugins.agy-max',
    ...(config.plugins?.['agy-powertools']?.enabled?['plugins.agy-powertools.enabled']:[])
  ];
  if(!skipAgyFast&&(!uninstall||config.plugins?.['agy-fast']!==undefined))configKeys.push('plugins.agy-fast');
  return {
    dryRun:true,action:uninstall?'uninstall':'install',home:paths.home,destination:paths.installed,dataDir:paths.data,
    ...(uninstall?{purge,retained:[join(paths.data,'archived-conversations')]}:{source}),
    backupDir:!uninstall&&existing?join(paths.data,'backups'):null,
    configBackupDir:configBackupRoot(paths),
    config:{path:paths.config,keys:configKeys},
    hooks:{path:hooks,keys:Object.keys(hookConfig).filter(isMaxHook),...(!uninstall?{deployedPath:join(paths.installed,'hooks.json'),deployedKeys:['agy-max-telemetry','agy-max-ssh-boundary']}: {})},
    shortcuts:planLauncherChanges({home:paths.home,dataDir:paths.data,uninstall}),agyFast
  };
}
async function migrateLegacyPowertools(paths,stop,changeConfig){
  const legacyData=join(paths.root,'antigravity','plugin_data','agy-powertools');
  assertOwnedPath(paths.home,legacyData);
  const cur=readConfig(paths.config);let tookOver=false;
  if(cur.plugins?.['agy-powertools']?.enabled){changeConfig(paths.config,c=>{if(c.plugins?.['agy-powertools'])c.plugins['agy-powertools']={...c.plugins['agy-powertools'],enabled:false};});tookOver=true;}
  const legacyStat=lstatSync(legacyData,{throwIfNoEntry:false});
  if(legacyStat&&!legacyStat.isSymbolicLink()&&existsSync(join(legacyData,'runtime'))){
    const runtime=assertOwnedPath(paths.home,join(legacyData,'runtime'));
    await stop(runtime).catch(()=>{});
  }
  if(!legacyStat||legacyStat.isSymbolicLink())return tookOver;
  for(const file of ['settings.json','goals.json','accounts.json']){
    const src=join(legacyData,file),dst=join(paths.data,file);
    const srcStat=lstatSync(src,{throwIfNoEntry:false}),dstStat=lstatSync(dst,{throwIfNoEntry:false});
    if(srcStat&&!srcStat.isSymbolicLink()&&!dstStat){mkdirSync(paths.data,{recursive:true});writeFileSync(dst,readFileSync(src),{mode:file==='accounts.json'?0o600:0o644});tookOver=true;}
  }
  return tookOver;
}

export async function installPlugin({source,bundle,home=homedir(),stop=stopRuntimes,verify,retainBackup=true,skipAgyFast=false}={}){
  const paths=installationPaths(home),payload=bundle?validatePackage(bundle):collectPackage(resolve(source));
  assertOwnedPath(paths.home,paths.installed);assertOwnedPath(paths.home,paths.data);
  return withLock(paths,async()=>{
    assertOwnedPath(paths.home,paths.config);
    const previous=readConfig(paths.config).plugins?.['agy-max'];
    const transaction=configTransaction(paths),{change:changeConfig}=transaction;
    const id=randomUUID(),stage=join(paths.data,'staging',id),backup=join(paths.data,'backups',id,'plugin');
    assertOwnedPath(paths.home,stage);assertOwnedPath(paths.home,backup);
    const runtime=assertOwnedPath(paths.home,join(paths.data,'runtime'));
    let moved=false,promoted=false,inPlace=false,registrationChanged=false,receipt;
    try{
      if(existsSync(paths.installed)&&JSON.parse(readFileSync(join(paths.installed,'plugin.json'),'utf8')).name!=='agy-max')throw Error('安装位置包含其他项目');
      const migratedLegacy=await migrateLegacyPowertools(paths,stop,changeConfig);
      receipt=writePackage(payload,stage);
      const previousReceipt=existsSync(join(paths.installed,'.agy-install.json'))?JSON.parse(readFileSync(join(paths.installed,'.agy-install.json'),'utf8')):{};
      receipt.sourceRoot=source?resolve(source):previousReceipt.sourceRoot;
      atomicJson(join(stage,'.agy-install.json'),receipt);
      setPluginEnabled(paths,changeConfig,false);registrationChanged=true;await stop(runtime);
      if(existsSync(paths.installed)){
        assertTree(paths.installed);assertOwnedPath(paths.home,backup);mkdirSync(dirname(backup),{recursive:true});
        try{await move(paths.installed,backup);}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;cpSync(paths.installed,backup,{recursive:true});inPlace=true;}moved=true;
      }
      mkdirSync(dirname(paths.installed),{recursive:true});
      if(inPlace)synchronize(stage,paths.installed);else await move(stage,paths.installed);promoted=true;
      for(const file of receipt.files)if(sha256(readFileSync(join(paths.installed,file.path)))!==file.sha256)throw Error('安装后校验失败');
      setPluginEnabled(paths,changeConfig,true);
      try{
        createModuleRegistry({home:paths.home,pluginRoot:paths.installed,installedPluginDir:paths.installed,dataDir:paths.data,version:payload.version,syncIntegrations:true}).ensureInitialized();
      }catch{}
      if(verify)await verify({paths,version:payload.version});
      const warnings=[];
      if(!skipAgyFast)try{
        syncBundledAgyFast({home:paths.home,enabled:wantsAgyFast(paths),vendorDir:join(paths.installed,'lib','vendor','agy-fast'),changeConfig});
      }catch(error){warnings.push(`agy-fast: ${error?.message||error}`);}
      let launcherResult=null;
      try{launcherResult=configureLaunchers({home:paths.home,dataDir:paths.data});}catch(error){warnings.push(`launchers: ${error?.message||error}`);}
      if(!retainBackup&&moved)removeTree(paths.data,dirname(backup));
      return{version:payload.version,destination:paths.installed,backup:moved&&retainBackup?backup:null,configBackupDir:transaction.backupDir,migratedLegacy,restartRequired:!verify,replacement:inPlace?'in-place':'directory',...(warnings.length?{warnings}:{}),...(process.platform==='darwin'?{macLauncherApp:launcherResult?.macApp||null,macLauncherIconConfigured:Boolean(launcherResult?.iconConfigured)}:{})};
    }catch(error){
      if(registrationChanged){setPluginEnabled(paths,changeConfig,false);await stop(runtime).catch(()=>{});}
      if(inPlace&&moved)synchronize(backup,paths.installed);
      else{if(promoted)removeTree(paths.root,paths.installed);if(moved){mkdirSync(dirname(paths.installed),{recursive:true});await move(backup,paths.installed);}}
      if(registrationChanged)setPlugin(paths,changeConfig,previous);
      error.rolledBack=true;throw error;
    }finally{if(lstatSync(stage,{throwIfNoEntry:false}))removeTree(paths.root,stage);}
  });
}

function ownTelemetry(path){
  try{const lines=readFileSync(path,'utf8').split('\n').filter(line=>line.trim());return lines.length>0&&lines.every(line=>{
    const value=JSON.parse(line);return value.pluginId==='agy-max'||['PreInvocation','PostInvocation'].includes(value.event)&&Number.isFinite(value.ts)&&typeof value.iso==='string'&&'invocationNum'in value&&'initialNumSteps'in value&&Object.keys(value).every(key=>['event','ts','iso','conversationId','invocationNum','initialNumSteps','modelName'].includes(key));
  });}catch{return false;}
}
function cleanBrain(paths){
  const retained=[];if(!existsSync(paths.brain))return retained;
  for(const id of readdirSync(paths.brain)){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))continue;
    for(const name of ['telemetry.jsonl','max-telemetry.jsonl']){
      const path=join(paths.brain,id,'.system_generated','logs',name);try{assertOwnedPath(paths.root,path);}catch{retained.push(path);continue;}
      if(existsSync(path)){if(ownTelemetry(path))unlinkSync(path);else retained.push(path);}
    }
  }
  return retained;
}

export async function uninstallPlugin({home=homedir(),purge=true,stop=stopRuntimes,skipAgyFast=false}={}){
  const paths=installationPaths(home);assertOwnedPath(paths.home,paths.installed);assertOwnedPath(paths.home,paths.data);
  return withLock(paths,async()=>{
    const wasInstalled=existsSync(paths.installed);
    if(wasInstalled&&JSON.parse(readFileSync(join(paths.installed,'plugin.json'),'utf8')).name!=='agy-max')throw Error('安装位置包含其他项目');
    assertTree(paths.installed);
    const hooks=assertOwnedPath(paths.home,join(paths.root,'config','hooks.json'));
    const runtime=assertOwnedPath(paths.home,join(paths.data,'runtime'));
    assertOwnedPath(paths.home,paths.config);readConfig(hooks);
    const previous=readConfig(paths.config).plugins?.['agy-max'];
    const transaction=configTransaction(paths),{change:changeConfig}=transaction;
    try{
      setPluginEnabled(paths,changeConfig,false,{existingOnly:true});
      await stop(runtime,{purge});
    }catch(error){
      if(previous!==undefined)changeConfig(paths.config,config=>{
        const entry=config.plugins?.['agy-max'];
        if(entry?.enabled!==false)return;
        if(previous&&Object.hasOwn(previous,'enabled'))entry.enabled=previous.enabled;
        else delete entry.enabled;
      });
      throw error;
    }
    removeTree(paths.root,paths.installed);
    changeConfig(paths.config,config=>{delete config.plugins?.['agy-max'];for(const key of Object.keys(config.sidecars||{}))if(isMaxSidecar(key))delete config.sidecars[key];});
    changeConfig(hooks,config=>{for(const key of Object.keys(config))if(isMaxHook(key))delete config[key];});
    const agyFastCleanup=skipAgyFast?null:cleanupBundledAgyFast({home:paths.home,changeConfig});
    const retained=[...(agyFastCleanup?.retained||[])];
    const launcherState=join(paths.data,'launcher-state.json');
    if(wasInstalled||lstatSync(launcherState,{throwIfNoEntry:false})){
      try{restoreLaunchers({home:paths.home,dataDir:paths.data});}catch{}
    }
    if(lstatSync(launcherState,{throwIfNoEntry:false}))retained.push(launcherState);
    if(purge){
      const archived=join(paths.data,'archived-conversations');
      if(lstatSync(archived,{throwIfNoEntry:false}))retained.push(archived);
      if(skipAgyFast){
        for(const name of ['parked-plugins','agy-fast-local-rules','agy-fast-managed.json']){
          const path=join(paths.data,name);if(lstatSync(path,{throwIfNoEntry:false}))retained.push(path);
        }
      }
      retained.push(...cleanBrain(paths));
      removeTree(paths.root,paths.sidecars);
      removeTreePreserving(paths.root,paths.data,retained);
    }
    return{removed:true,purged:purge,retained,configBackupDir:transaction.backupDir};
  });
}
