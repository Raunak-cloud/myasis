const NAMES: Record<string,string> = {seek:'SEEK',indeed:'Indeed',jora:'Jora',pageup:'PageUp',workday:'Workday',greenhouse:'Greenhouse',smartrecruiters:'SmartRecruiters'};

export function EmployerSitesLabel() {
 return <span className="board-brand employer-sites-label"><svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 28V8l10-4 10 4v20M3 28h26M13 28v-6h6v6M11 12h2m6 0h2M11 17h2m6 0h2"/></svg><span>Employer sites</span></span>;
}

/** Original source artwork, served locally. Adjacent text supplies the accessible name. */
export function BoardLogo({board}:{board:string}) {
 if(!NAMES[board])return null;
 return <span className={`board-brand-logo board-brand-logo-${board}`} aria-hidden="true"><img src={`/platforms/${board}.svg`} alt="" width="56" height="26" /></span>;
}

export function BoardBrand({board,label,compact=false}:{board:string;label?:string;compact?:boolean}) {
 const name=label??NAMES[board]??board;
 const hasLogo=Boolean(NAMES[board]);
 return <span className={`board-brand${compact?' board-brand-compact':''}`} role={hasLogo?'img':undefined} aria-label={hasLogo?name:undefined}>{hasLogo?<BoardLogo board={board}/>:<span>{name}</span>}</span>;
}
