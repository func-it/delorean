import { logout } from "@/app/actions";

import styles from "./Header.module.css";

interface Props {
  username: string;
  backends: string[];
  backend: string;
  onBackendChange: (backend: string) => void;
}

export function Header({ username, backends, backend, onBackendChange }: Props) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <p className={styles.brand}>
          <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 17.5V26M16 17.5 8.5 8M16 17.5 23.5 8" />
          </svg>
          Delorean
        </p>
        <div className={styles.session}>
          {backends.length > 1 && (
            <label className={styles.backend}>
              Backend
              <select className="field" value={backend} onChange={(event) => onBackendChange(event.target.value)}>
                {backends.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className={styles.user}>
            <span className="visually-hidden">Connecté en tant que </span>
            {username}
          </p>
          <form action={logout}>
            <button type="submit" className="button button-quiet">
              Se déconnecter
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
