import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function AuthPanel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="aap-auth-panel">
      <div className="aap-auth-art" aria-hidden="true">
        <span className="aap-auth-mark">A</span>
      </div>
      <section className="aap-auth-content">
        <div className="aap-auth-content__inner">
          {children}
          <p className="aap-auth-terms">
            继续即表示你同意我们的 <Link to="/terms">Terms of Service</Link> 和{' '}
            <Link to="/acceptable-use">Acceptable Use Policy</Link>。
          </p>
        </div>
      </section>
    </div>
  );
}
