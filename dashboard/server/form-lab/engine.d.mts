export interface FormDefinition {key:string;name:string;company:string;pages:number;description:string;account:boolean}
export const formCatalog: FormDefinition[];
export function materials(email:string): {text:string;profile:Record<string,unknown>;files:Record<string,{name:string;bytes:Buffer}>};
export function pagesFor(key:string,email:string): any[];
export class FormLab {
 constructor(options:{key:string;email:string;seed:number;id:string;secret:string;state?:any});
 state:any;pages:any[];base:string;materials:ReturnType<typeof materials>;definition:FormDefinition;
 request(request:{method:string;path:string;query?:string;body?:Buffer;contentType?:string},sendCode:(message:{to:string;subject:string;text:string})=>Promise<void>):Promise<{status:number;headers:Record<string,string>;body:string}>;
 summary():{pagesCompleted:number;totalPages:number;checksPassed:number;checksSaved:number;submitted:boolean;receipt:string|null;accountVerified:boolean;verificationCodesAccepted:number;emailsSent:number;recoveredServiceFailures:number;validationErrors:unknown[];events:unknown[]};
}
