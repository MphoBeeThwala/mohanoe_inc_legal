import React, { type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  label?: string;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'Something went wrong.',
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (!import.meta.env.PROD) {
      console.error('[ErrorBoundary]', this.props.label, error, info);
    }
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="panel error-boundary" role="alert">
          <p className="panel-kicker">{this.props.label || 'Component'}</p>
          <h2>Unable to render this section</h2>
          <p className="muted">
            {this.state.message} Reload the page or select a different matter to continue.
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => this.setState({ hasError: false, message: '' })}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
