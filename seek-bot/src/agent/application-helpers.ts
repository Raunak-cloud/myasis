import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {convertDocument} from '../resume.js';
import {chromium,type Page} from 'patchright';
import {applicationModelEnvironment,withApplicationModel} from '../application-model.js';
import {AgentFiles} from './agent-files.js';
import type {ToolSchema} from './celeris.js';
import {failedToolResult,ok,type ToolResult} from './context.js';
import {browserTarget} from './browser-target.js';
import {nativeInspect,nativeReadback,evaluateBrowser,waitAfterAction,nativeScroll} from './native-browser.js';
import {observe} from './observe.js';
import {toolInputIssue} from './tool-input.js';

type ObjectValue=Record<string,unknown>;
export interface HelperDefinition {
  name:string;description:string;parameters:ObjectValue;
  steps:Array<{tool:string;args:ObjectValue}>;
  tests:Array<{html:string;input:ObjectValue;assertions:Array<{step:number;path:string;equals:unknown}>}>;
}
type Prepared={definition:HelperDefinition;schema:ToolSchema;digest:string};
type Pending={name:string;next:number;results:unknown[]};
type Executor=(name:string,args:ObjectValue)=>Promise<ToolResult>;
const forbiddenKeys=new Set(['__proto__','constructor','prototype']);
const allowedTools=new Set(['browser_action','create_file','convert_file']);
const allowedActions=new Set(['fill','type','click','check','select','press','inspect','script','wait','hover','scroll','set_input_files']);
const objectSchema={type:'object',additionalProperties:true};
const inputSchema={type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['object']},properties:objectSchema,required:{type:'array',maxItems:30,items:{type:'string',maxLength:100}},additionalProperties:{type:'boolean',enum:[false]}},required:['properties']};
/** A complete executable reference teaches the composition contract to the
 * same small applying models, rather than relying on prose about a new DSL. */
export const helperRecipeExample={name:'join_document',description:'Create one text document from two supplied text sections separated by a blank line.',
 parameters:{properties:{first:{type:'string'},second:{type:'string'}},required:['first','second']},
 steps:[{tool:'create_file',args:{name:'Combined.txt',format:'txt',text:{$concat:[{$input:'first'},'\n\n',{$input:'second'}]}}}],
 tests:[{html:'<main>Isolated document fixture</main>',input:{first:'Letter',second:'CV'},assertions:[{step:0,path:'name',equals:'Combined.txt'},{step:0,path:'bytes',equals:10}]}]};
const schemaKeys=new Set(['type','properties','required','additionalProperties','items','enum','minLength','maxLength','minimum','maximum','minItems','maxItems','description']);
/** Models commonly supply a field dictionary or omit mechanical size bounds.
 * Canonicalize those equivalent forms and impose bounds locally, rather than
 * spending model turns repairing schema boilerplate. No new capability or
 * executable schema extension is accepted. */
function normalizeParameters(raw:unknown):ObjectValue{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Helper parameters must describe named inputs.');
  const root=structuredClone(raw) as ObjectValue;
  const schema: ObjectValue=root.type===undefined&&root.properties===undefined?{type:'object',properties:root}:root;
  const visit=(node:unknown,depth=0)=>{
    if(depth>6||!node||typeof node!=='object'||Array.isArray(node))throw Error('Use small typed helper inputs.');
    const item=node as ObjectValue;
    if(item.type===undefined&&item.properties)item.type='object';
    if(item.type==='object'){
      item.additionalProperties??=false;
      if(item.properties&&typeof item.properties==='object')Object.values(item.properties).forEach(child=>visit(child,depth+1));
    }
    if(item.type==='string')item.maxLength??=40000;
    if(item.type==='array'){item.maxItems??=32;visit(item.items,depth+1);}
  };
  schema.type??='object';visit(schema);return schema;
}
function parameterSchema(schema:unknown,depth=0):void{
  if(depth>6||!schema||typeof schema!=='object'||Array.isArray(schema))throw Error('Use a small, explicit helper parameter schema.');
  const s=schema as ObjectValue;
  if(Object.keys(s).some(k=>!schemaKeys.has(k))||!['object','array','string','integer','number','boolean','null'].includes(String(s.type)))throw Error('Helper parameters support typed properties, required, enums and size bounds; executable patterns, references and schema extensions are unavailable.');
  if(s.description!==undefined&&(typeof s.description!=='string'||s.description.length>1200))throw Error('Parameter description is too large.');
  if(s.type==='object'){
    if(s.additionalProperties!==false||!s.properties||typeof s.properties!=='object'||Array.isArray(s.properties))throw Error('Object parameters need explicit properties and additionalProperties=false.');
    const props=s.properties as ObjectValue,keys=Object.keys(props);if(keys.length>30||keys.some(k=>forbiddenKeys.has(k)))throw Error('Too many or forbidden helper properties.');
    Object.values(props).forEach(child=>parameterSchema(child,depth+1));
    if(s.required!==undefined&&(!Array.isArray(s.required)||s.required.some(k=>typeof k!=='string'||!Object.hasOwn(props,k))))throw Error('Required names must identify declared helper inputs.');
  }
  if(s.type==='array'){parameterSchema(s.items,depth+1);if(!Number.isInteger(s.maxItems)||Number(s.maxItems)>32||Number(s.maxItems)<0)throw Error('Array inputs need maxItems between 0 and 32.');}
  if(s.type==='string'&&(!Number.isInteger(s.maxLength)||Number(s.maxLength)>40000||Number(s.maxLength)<1))throw Error('String inputs need maxLength between 1 and 40000.');
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||s.enum.length>50||s.enum.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v))))throw Error('Use small scalar parameter enums.');
}
export const helperBuilderTool:ToolSchema={name:'test_application_helper',description:
  'Build and test a temporary helper for a genuinely missing operation. Compose the advertised browser_action/create_file/convert_file tools; no host code, new account access, auth, recursion or application sends. Templates: {"$input":"field.path"}, {"$result":"0.field.path"}, {"$concat":[...]}, {"$json":template}. Literal text is a normal JSON string, without a $literal wrapper. Each step has tool and args. Test the actual returned object: create_file returns file_id/name/bytes/format; inspecting one input returns value directly. Tests use only dummy inputs in a separate cookie-free, network-blocked browser and temporary document inventory. Only passing definitions become callable. A test proves the fixture, not employer acceptance. Complete working example (adapt this exact structure): '+JSON.stringify(helperRecipeExample),
  parameters:{type:'object',additionalProperties:false,properties:{
    name:{type:'string',pattern:'^[a-z][a-z0-9_]{1,38}$'},description:{type:'string',minLength:10,maxLength:1200},parameters:{...inputSchema,description:'Input schema example: {"properties":{"letter":{"type":"string"},"resume":{"type":"string"}},"required":["letter","resume"]}. Object type and closed properties are applied automatically. String maxLength defaults to 40000, array maxItems to 32; smaller bounds are welcome. Only typed properties, required, enums and scalar size/range constraints. No patterns or refs.'},
    steps:{type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,properties:{tool:{type:'string',enum:[...allowedTools]},args:objectSchema},required:['tool','args']}},
    tests:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,properties:{html:{type:'string',maxLength:40000},input:objectSchema,
      assertions:{type:'array',minItems:1,maxItems:12,items:{type:'object',additionalProperties:false,properties:{step:{type:'integer',minimum:0,maximum:11},path:{type:'string',maxLength:200},equals:{}},required:['step','path','equals']}}},required:['html','input','assertions']}},
  },required:['name','description','parameters','steps','tests']}};

function at(value:unknown,path:string):unknown {
  let current=value;
  for(const key of path?path.split('.'):[]){
    if(forbiddenKeys.has(key)||!current||typeof current!=='object'||!Object.hasOwn(current,key))throw Error(`Missing or forbidden helper path ${path}`);
    current=(current as ObjectValue)[key];
  }
  return current;
}
function expand(value:unknown,input:ObjectValue,results:unknown[],depth=0):unknown {
  if(depth>16)throw Error('Helper template nesting exceeded.');
  if(Array.isArray(value))return value.map(item=>expand(item,input,results,depth+1));
  if(value&&typeof value==='object'){
    const obj=value as ObjectValue,keys=Object.keys(obj);
    if(keys.some(key=>forbiddenKeys.has(key)))throw Error('Forbidden helper object key.');
    if(keys.length===1&&keys[0]==='$input'&&typeof obj.$input==='string')return structuredClone(at(input,obj.$input));
    if(keys.length===1&&keys[0]==='$result'&&typeof obj.$result==='string')return structuredClone(at(results,obj.$result));
    if(keys.length===1&&keys[0]==='$json')return JSON.stringify(expand(obj.$json,input,results,depth+1));
    if(keys.length===1&&keys[0]==='$concat'&&Array.isArray(obj.$concat)){
      let text='';for(const item of obj.$concat){const part=expand(item,input,results,depth+1);if(!['string','number','boolean'].includes(typeof part))throw Error(`Concat parts must resolve to text/number/boolean; received ${part===null?'null':typeof part} with keys ${JSON.stringify(part&&typeof part==='object'?Object.keys(part):[])}. Literal text is a normal string; named input is {"$input":"first"}. Use $json only to encode a structured script argument.`);if(text.length+String(part).length>64000)throw Error('Expanded helper text is too large.');text+=String(part);}return text;
    }
    if(keys.some(key=>key.startsWith('$')))throw Error(`Unsupported helper template keys ${JSON.stringify(keys)}. Use only $input, $result, $concat, $json as in the complete example; literal text needs no wrapper.`);
    return Object.fromEntries(keys.map(key=>[key,expand(obj[key],input,results,depth+1)]));
  }
  return value;
}
const decoded=(result:ToolResult):unknown=>{
  if(result.kind!=='ok')return result.outcome;
  try{return JSON.parse(result.message);}catch{return result.message;}
};

/** Attempt-local capability composition, not a host-code execution service.
 * Every live primitive re-enters the parent's ordinary executor and checks. */
export class ApplicationHelpers {
  private ready=new Map<string,Prepared>();
  private pending=new Map<string,Pending>();
  private testing=false;
  constructor(private readonly base:ToolSchema[]){}
  schemas():ToolSchema[]{return [...this.ready.values()].map(item=>structuredClone(item.schema));}
  has(name:string){return this.ready.has(name);}
  catalog(){return this.base.filter(t=>allowedTools.has(t.name));}
  private command(step:{tool:string;args:ObjectValue},input:ObjectValue,results:unknown[]){
    if(!allowedTools.has(step.tool))throw Error('Helpers may only compose the advertised browser and document primitives.');
    const args=expand(step.args,input,results) as ObjectValue;
    if(JSON.stringify(args).length>100000)throw Error('Expanded helper arguments are too large.');
    if(step.tool==='browser_action'&&(!allowedActions.has(String(args.action))||args.sends_application===true||args.target_mode==='coordinates'))throw Error('A helper must prepare or inspect, never submit, accept dialogs or change browser ownership.');
    const schema=this.base.find(t=>t.name===step.tool);if(!schema)throw Error('Helper primitive unavailable in this mode.');
    const issue=toolInputIssue(args,schema.parameters);if(issue)throw Error(`${step.tool}: ${issue}`);
    return {name:step.tool,args};
  }
  async test(raw:unknown):Promise<ObjectValue>{
    if(this.testing)throw Error('Another helper test is already running.');
    if(JSON.stringify(raw).length>100000)throw Error('Helper definition is too large.');
    const definition=structuredClone(raw) as HelperDefinition;
    if(definition&&typeof definition==='object')definition.parameters=normalizeParameters(definition.parameters);
    const issue=toolInputIssue(definition,helperBuilderTool.parameters);if(issue)throw Error(issue);
    if(definition.parameters.type!=='object')throw Error('Helper parameters must be an object JSON schema.');
    parameterSchema(definition.parameters);
    const digest=createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    const name=`helper_${definition.name}_${digest.slice(0,8)}`;
    if(this.ready.has(name))return {name,status:'already-tested',tests:definition.tests.length};
    if(this.ready.size>=4)throw Error('Four tested helpers are already available for this application. Reuse them or the original tools.');
    // Validate capabilities before creating any test browser or document.
    for(const step of definition.steps)if(!allowedTools.has(step.tool))throw Error('Unavailable helper capability.');
    this.testing=true;
    try{
      for(const test of definition.tests){
        if(!test.assertions.some(assertion=>assertion.step===definition.steps.length-1))throw Error('Each fixture must assert a returned value from the final operation.');
        const inputIssue=toolInputIssue(test.input,definition.parameters);if(inputIssue)throw Error(`Test input: ${inputIssue}`);
        const directory=mkdtempSync(join(tmpdir(),'owtomate-helper-'));
        // A separate native browser process keeps a broken helper's renderer
        // or infinite script away from the live candidate browser entirely.
        const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),args:['--js-flags=--max-old-space-size=64','--disable-gpu']});
        const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1280,height:900}});
        const abort=new AbortController();
        const timer=setTimeout(()=>{abort.abort();void browser.close().catch(()=>{});},12000);
        try{
          await context.routeWebSocket('**/*',socket=>socket.close());
          let initial=true;
          await context.route('**/*',route=>{
            if(initial&&route.request().url()==='https://helper-test.invalid/'&&route.request().isNavigationRequest()){
              initial=false;return route.fulfill({contentType:'text/html',body:test.html});
            }
            return route.abort();
          });
          writeFileSync(join(directory,'resumes.json'),'[]',{mode:0o600});
          const page=await context.newPage();page.setDefaultTimeout(2000);await page.goto('https://helper-test.invalid/');
          const files=new AgentFiles('synthetic-helper-test',undefined,(file,format)=>convertDocument(file,format,{timeoutMs:8000,signal:abort.signal,profile:join(directory,'office-profile')}));
          const results:unknown[]=[];
          await withApplicationModel({...applicationModelEnvironment(),DATA_DIR:directory},async()=>{
            for(const step of definition.steps){
              await observe(page);
              const command=this.command(step,test.input,results);
              results.push(await testPrimitive(page,files,command.name,command.args));
            }
          });
          for(const assertion of test.assertions){
            if(assertion.step>=results.length||JSON.stringify(at(results[assertion.step],assertion.path))!==JSON.stringify(assertion.equals))throw Error(`Test assertion failed at step ${assertion.step}, path ${assertion.path}. Helper not published.`);
          }
        }finally{clearTimeout(timer);await browser.close().catch(()=>{});rmSync(directory,{recursive:true,force:true});}
      }
      const schema:ToolSchema={name,description:`Tested temporary helper: ${definition.description} Tested on ${definition.tests.length} isolated synthetic fixture(s), not the live employer. Inspect actual results. If interrupted, use returned continuation to avoid replaying completed steps.`,parameters:{type:'object',additionalProperties:false,properties:{input:definition.parameters,continuation:{type:'string'}},required:['input']}};
      this.ready.set(name,{definition,schema,digest});
      return {name,status:'fixture-tested',tests:definition.tests.length,steps:definition.steps.length,scope:'current application only',liveEmployerAcceptanceVerified:false};
    }finally{this.testing=false;}
  }
  async execute(name:string,args:ObjectValue,run:Executor,budgetAvailable:()=>boolean):Promise<ToolResult>{
    const helper=this.ready.get(name);if(!helper)throw Error('Only a successfully tested helper is callable.');
    if(JSON.stringify(args).length>100000)throw Error('Helper input is too large.');
    const issue=toolInputIssue(args,helper.schema.parameters);if(issue)throw Error(issue);
    const token=typeof args.continuation==='string'?args.continuation:undefined;
    const prior=token?this.pending.get(token):undefined;
    if(token&&(!prior||prior.name!==name))throw Error('Unknown or consumed helper continuation. Do not rerun completed browser actions.');
    if(token)this.pending.delete(token);
    const progress=prior??{name,next:0,results:[]};
    for(let index=progress.next;index<helper.definition.steps.length;index++){
      if(!budgetAvailable())return ok(JSON.stringify({helper:name,completedSteps:index,note:'Shared application budget exhausted. No further operation ran; do not replay completed operations.'}),'failed');
      let result:ToolResult;
      try{const command=this.command(helper.definition.steps[index],args.input as ObjectValue,progress.results);result=await run(command.name,command.args);}
      catch(error){result=ok(`Helper step ${index} failed: ${(error as Error).message}`,'failed');}
      if(result.kind==='terminal')return result;
      const failed=failedToolResult(result);
      if(!failed)progress.results[index]=decoded(result);
      if(failed)return ok(JSON.stringify({helper:name,completedSteps:index,stoppedStep:index,result:decoded(result),
        note:'The failed operation may have changed the live page. Inspect it and repair using the ordinary tools; do not restart the helper or replay completed operations.'}),'failed');
      if(result.disposition==='reobserve'){
        progress.next=index+1;
        const continuation=randomUUID();
        if(this.pending.size>=16)this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(continuation,progress);
        return ok(JSON.stringify({helper:name,completedSteps:progress.next,stoppedStep:index,result:decoded(result),continuation,
          note:'Inspect the live page. Continue with this token and fresh input targets to resume after completed operations; do not blindly start again.'}),result.disposition);
      }
      progress.next=index+1;
    }
    const last=progress.results.at(-1),text=JSON.stringify(last)??'';
    return ok(JSON.stringify({helper:name,completedSteps:progress.next,result:text.length>12000?{preview:text.slice(0,12000),truncated:true}:last,note:'Helper operations completed. The applying agent must inspect live saved values, acceptance and any final employer receipt.'}));
  }
}

/** Same native primitives on synthetic inputs only; no candidate profile,
 * authentication connection, approval or live browser executor is available. */
async function testPrimitive(page:Page,files:AgentFiles,name:string,args:ObjectValue):Promise<unknown>{
  if(name==='create_file')return files.create(String(args.name),String(args.text),args.format as never);
  if(name==='convert_file')return files.convert(String(args.file_id),args.format as never);
  if(args.action==='script')return evaluateBrowser(page,args);
  if(args.action==='scroll'){await nativeScroll(page,args);return {action:'scroll'};}
  if(args.action==='wait'){const note=await waitAfterAction(page,args);if(note)throw Error(note);return {action:'wait'};}
  const target=browserTarget(page,args),value=String(args.value??'');
  if(args.action==='inspect')return nativeInspect(target);
  switch(args.action){
    case 'fill':await target.fill(value,{timeout:2000});break;
    case 'type':await target.pressSequentially(value,{timeout:2000});break;
    case 'click':await target.click({timeout:2000});break;
    case 'check':await target.setChecked(value!=='false',{timeout:2000});break;
    case 'select':await target.selectOption({label:value},{timeout:1000}).catch(()=>target.selectOption(value,{timeout:1000}));break;
    case 'press':await target.press(value,{timeout:2000});break;
    case 'hover':await target.hover({timeout:2000});break;
    case 'set_input_files':await target.setInputFiles((args.file_ids as string[]).map(id=>files.resolve(id).path),{timeout:2000});break;
    default:throw Error('Unsupported helper test action.');
  }
  const note=await waitAfterAction(page,args);if(note)throw Error(note);
  return {action:args.action,current:await nativeReadback(target)};
}
