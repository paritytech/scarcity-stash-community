// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/** Catches any render error, so the app shows a calm "couldn't load" panel
 *  instead of a blank screen. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[error-boundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="state-screen state-screen--fatal" role="alert">
        <p className="state-title">Your collection couldn’t be displayed</p>
        <p className="state-copy">Something went wrong on this screen.</p>
        <button type="button" className="ui-primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }
}
