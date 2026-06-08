import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || 'Something went wrong.',
    };
  }

  componentDidCatch(error, info) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary]', this.props.label, error, info);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="panel error-boundary" role="alert">
          <p className="panel-kicker">{this.props.label || 'Component'}</p>
          <h2>Unable to render this section</h2>
          <p className="muted">
            {this.state.message} Reload the page or select a different matter to
            continue.
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
