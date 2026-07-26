import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  /**
   * Fallback UI shown when a descendant throws during render. Either a node, or
   * a function receiving the error and a `reset` callback to retry rendering.
   * When omitted, nothing is rendered (the failing subtree is isolated so the
   * rest of the app keeps working instead of unmounting to a blank screen).
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Optional side-effect hook for logging/telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * When any value in this array changes, the boundary clears its error and
   * retries rendering. Useful so a transient streaming error recovers on the
   * next content update without a manual page refresh.
   */
  resetKeys?: unknown[];
}

interface State {
  error: Error | null;
}

/**
 * Generic error boundary. React unmounts the entire tree when a render throws
 * with no boundary above it — which is what produced the "blank screen during
 * streaming" symptom. Wrapping volatile subtrees (chat messages, markdown)
 * keeps a single bad render from taking down the whole UI.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && this.props.resetKeys && !shallowEqual(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render error:', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') return fallback(error, this.reset);
      return fallback ?? null;
    }
    return this.props.children;
  }
}

function shallowEqual(a?: unknown[], b?: unknown[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}
