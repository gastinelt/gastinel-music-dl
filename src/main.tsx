import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-shell">
          <section className="card">
            <div className="alert alert-err" style={{ marginBottom: 14 }}>
              <span>
                Erreur d&apos;affichage détectée : {this.state.error.message || 'Erreur inconnue'}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              Recharger l&apos;interface
            </button>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
