import ts from 'typescript';
import { dirname } from 'node:path';

const normal=(path:string)=>path.replaceAll('\\','/');
const root='/__owtomate_repair__',file=root+'/source.ts',browser=root+'/patchright.d.ts';
const browserTypes=`export interface Page {frames():Frame[];mainFrame():Frame;locator(selector:string):Locator;}
export interface Frame {page():Page;parentFrame():Frame|null;locator(selector:string):Locator;}
export interface Locator {page():Page;elementHandle(...args:any[]):Promise<ElementHandle|null>;}
export interface ElementHandle {ownerFrame():Promise<Frame|null>;dispose():Promise<void>;}`;
const browserObjects=new Set(['Page','Frame','Locator','ElementHandle','Document','Element','Node','ShadowRoot']);
const cache=new Map<string,string>();

/** Classify references, not name prefixes. Only a browser type established by
 * the trusted baseline/imports can exempt an owner-prefixed identifier. Account
 * strings, unknown/any types, comments and literals remain conservative. The
 * compiler host reads supplied source and bundled compiler libs only. */
export function browserOwnershipMask(source:string):string {
  const prior=cache.get(source);if(prior!==undefined)return prior;
  if(!/\bowner/i.test(source))return source;
  const options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,strict:true,noEmit:true,types:[],skipLibCheck:true};
  const lib=normal(dirname(ts.getDefaultLibFilePath(options)));
  const canonical=(path:string)=>ts.sys.useCaseSensitiveFileNames?normal(path):normal(path).toLowerCase();
  const supplied=new Map([[canonical(file),source],[canonical(browser),browserTypes]]);
  const compilerLib=(path:string)=>canonical(dirname(normal(path)))===canonical(lib)&&/^lib\.[a-z0-9.]+\.d\.ts$/i.test(normal(path).split('/').at(-1)??'');
  const read=(path:string)=>supplied.get(canonical(path))??(compilerLib(path)?ts.sys.readFile(path):undefined);
  const host:ts.CompilerHost={
    getSourceFile:(path,language)=>{const text=read(path);return text===undefined?undefined:ts.createSourceFile(path,text,language,true);},
    getDefaultLibFileName:()=>ts.getDefaultLibFilePath(options),writeFile:()=>{throw Error('Source classification cannot write files.');},
    getCurrentDirectory:()=>root,getDirectories:()=>[],getCanonicalFileName:canonical,useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
    getNewLine:()=> '\n',fileExists:path=>supplied.has(canonical(path))||compilerLib(path)&&ts.sys.fileExists(path),readFile:read,
    resolveModuleNames:names=>names.map(name=>name==='patchright'?{resolvedFileName:browser,extension:ts.Extension.Dts,isExternalLibraryImport:true}:undefined),
  };
  const program=ts.createProgram([file],options,host),tree=program.getSourceFile(file)!;
  const checker=program.getTypeChecker(),chars=source.split('');
  const trustedDeclaration=(node:ts.Declaration)=>canonical(node.getSourceFile().fileName)===canonical(browser)||compilerLib(node.getSourceFile().fileName);
  const browserType=(type:ts.Type):boolean=>{
    type=checker.getNonNullableType(type);
    if(type.isUnion())return type.types.length>0&&type.types.every(browserType);
    if(checker.isArrayType(type))return checker.getTypeArguments(type as ts.TypeReference).every(browserType);
    const symbol=type.getSymbol();
    return !!symbol&&browserObjects.has(symbol.name)&&!!symbol.declarations?.length&&symbol.declarations.every(trustedDeclaration);
  };
  const browserOrigin=(node:ts.Node,depth=0):boolean=>{
    if(depth>12)return false;
    if(ts.isParenthesizedExpression(node)||ts.isNonNullExpression(node)||ts.isAwaitExpression(node))return browserOrigin(node.expression,depth+1);
    if(ts.isIdentifier(node)){
      const decl=checker.getSymbolAtLocation(node)?.valueDeclaration;
      if(decl&&ts.isParameter(decl))return browserType(checker.getTypeAtLocation(node));
      return !!decl&&ts.isVariableDeclaration(decl)&&!!decl.initializer&&browserOrigin(decl.initializer,depth+1);
    }
    if(ts.isElementAccessExpression(node))return browserOrigin(node.expression,depth+1)&&browserType(checker.getTypeAtLocation(node));
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
      const member=node.expression,symbol=checker.getSymbolAtLocation(member.name);
      const browserApi=!!symbol?.declarations?.length&&symbol.declarations.every(decl=>canonical(decl.getSourceFile().fileName)===canonical(browser));
      const arrayApi=['at','slice','filter'].includes(member.name.text)&&checker.isArrayType(checker.getNonNullableType(checker.getTypeAtLocation(member.expression)));
      return (browserApi||arrayApi)&&browserOrigin(member.expression,depth+1);
    }
    return false;
  };
  const visit=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)&&/^owner/i.test(node.text)){
      const symbol=checker.getSymbolAtLocation(node);
      const browserMember=!!symbol?.declarations?.length&&symbol.declarations.every(trustedDeclaration);
      if(browserMember||browserType(checker.getTypeAtLocation(node))&&browserOrigin(node)){
        for(let i=node.getStart(tree);i<node.end;i++)chars[i]=' ';
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(tree);
  const masked=chars.join('');if(cache.size>=12)cache.delete(cache.keys().next().value!);cache.set(source,masked);return masked;
}
