const NAMES: Record<string,string> = {seek:'SEEK',indeed:'Indeed',jora:'Jora'};

/** Original source artwork, served locally. The containing control supplies its accessible name. */
export function BoardLogo({board}:{board:string}) {
 if(!NAMES[board])return null;
 return <span className={`board-brand-logo board-brand-logo-${board}`} aria-hidden="true"><img src={`/platforms/${board}.svg`} alt="" width="56" height="26" /></span>;
}

export function BoardBrand({board,label,compact=false}:{board:string;label?:string;compact?:boolean}) {
 const name=label??NAMES[board]??board;
 const hasLogo=Boolean(NAMES[board]);
 return <span className={`board-brand${compact?' board-brand-compact':''}`} role={hasLogo?'img':undefined} aria-label={hasLogo?name:undefined}>{hasLogo?<BoardLogo board={board}/>:<span>{name}</span>}</span>;
}
