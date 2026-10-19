const JOB_SOURCES = [
  { id: 'seek', name: 'Seek', caption: 'Job board', width: 166, height: 65 },
  { id: 'indeed', name: 'Indeed', caption: 'Job board', width: 75, height: 20 },
  { id: 'apsjobs', name: 'APSJobs', caption: 'Government job portals', width: 790, height: 165 },
] as const;

/** Official source artwork identifies the sites; it does not label them as partners. */
export function JobSourceLogos() {
  return (
    <ul className="home-job-sources" aria-label="Job boards and career sites">
      {JOB_SOURCES.map((source) => (
        <li key={source.id} className={`home-job-source home-job-source-${source.id}`}>
          <span className="home-job-source-logo">
            <img src={`/platforms/${source.id}.svg`} alt={source.name} width={source.width} height={source.height} />
          </span>
          <span className="home-job-source-caption">{source.caption}</span>
        </li>
      ))}
      <li className="home-job-source home-job-source-employers">
        <span className="home-job-source-logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 28V8l10-4 10 4v20M3 28h26M13 28v-6h6v6M11 12h2m6 0h2M11 17h2m6 0h2" />
          </svg>
        </span>
        <span className="home-job-source-caption">Employer career sites</span>
      </li>
    </ul>
  );
}
