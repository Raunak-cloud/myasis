export function FieldLabel({ label, help, optional = false }: {
  label: string;
  help: string;
  optional?: boolean;
}) {
  return (
    <span className="field-label field-label-with-info">
      <span>
        {label}{optional && <span className="optional"> optional</span>}
      </span>
      <span className="field-info" tabIndex={0} aria-label={`${label}: ${help}`}>
        i
        <span className="field-tooltip" role="tooltip">{help}</span>
      </span>
    </span>
  );
}
