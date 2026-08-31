export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  optional?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="aias-field">
      {props.label}
      {props.optional ? <span className="aias-field-optional">optional</span> : null}
      <input
        className="aias-input"
        disabled={props.disabled}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
