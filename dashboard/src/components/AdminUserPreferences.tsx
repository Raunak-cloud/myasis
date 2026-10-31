import type { AdminPreferenceSection } from '../admin-user-preferences';

export function AdminUserPreferences({ sections }: { sections: AdminPreferenceSection[] }) {
  return <div className="admin-user-preferences">
    {sections.map(section => <section className="section" key={section.title} aria-label={section.title}>
      <h3>{section.title}</h3>
      {section.fields.length ? <dl className="admin-facts admin-preference-facts">
        {section.fields.map((field, index) => <div className="admin-preference-field" key={`${field.label}-${index}`}>
          <dt>{field.label}</dt>
          <dd>{field.value}{field.note && <p className="job-meta">{field.note}</p>}</dd>
        </div>)}
      </dl> : <p className="job-meta">None saved.</p>}
    </section>)}
  </div>;
}
