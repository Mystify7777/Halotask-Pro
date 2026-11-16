import { useState, type ChangeEvent } from 'react';
import styles from './PasswordInput.module.css';

type PasswordInputProps = {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  'aria-label'?: string;
};

export default function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  required,
  minLength,
  'aria-label': ariaLabel,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span className={styles.wrapper}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
