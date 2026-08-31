export function Segmented(props: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="aias-segmented">
      <button
        type="button"
        disabled={props.disabled}
        className={!props.value ? "active" : ""}
        onClick={() => props.onChange(false)}
      >
        Auto
      </button>
      <button
        type="button"
        disabled={props.disabled}
        className={props.value ? "active" : ""}
        onClick={() => props.onChange(true)}
      >
        Custom
      </button>
    </div>
  );
}
