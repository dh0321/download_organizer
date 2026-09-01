import { useState } from "react";

/**
 * A free-text input with a suggestion panel that (unlike a native
 * `<input list>` + `<datalist>`) always shows every option — not just the
 * ones that happen to prefix-match whatever's already typed — with the
 * option matching the current value highlighted, similar to a native
 * `<select>`. Typing anything is still always allowed; picking a row is a
 * shortcut, not a constraint.
 */
export function Combobox(props: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <input
        className="aias-input"
        style={{ margin: 0 }}
        disabled={props.disabled}
        value={props.value}
        placeholder={props.placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {open && props.options.length > 0 && (
        <div className="aias-combobox-panel">
          {props.options.map((option) => {
            const active = option.toLowerCase() === props.value.trim().toLowerCase();
            return (
              <div
                key={option}
                className={`aias-combobox-option${active ? " active" : ""}`}
                // Prevents the input from blurring (which would close this
                // panel) before the click below has a chance to register.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  props.onChange(option);
                  setOpen(false);
                }}
              >
                {option}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
