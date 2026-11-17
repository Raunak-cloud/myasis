const NAMES: Record<string,string> = {seek:'SEEK',indeed:'Indeed',jora:'Jora'};

/** Original source artwork, served locally. Adjacent text supplies the accessible name. */
export function BoardLogo({board}:{board:string}) {
 if(!NAMES[board])return null;
 return <span className={`board-brand-logo board-brand-logo-${board}`} aria-hidden="true"><img src={`/platforms/${board}.svg`} alt="" width="56" height="26" /></span>;
}

export function BoardBrand({board,label,compact=false}:{board:string;label?:string;compact?:boolean}) {
 return <span className={`board-brand${compact?' board-brand-compact':''}`}><BoardLogo board={board}/><span>{label??NAMES[board]??board}</span></span>;
}
