"use client";

import { Component, type ReactNode } from "react";
import { button } from "@/components/ui";

interface State {
  error: Error | null;
}

/**
 * Last line of defence: if WebGL is unavailable or rendering throws, show a message in place
 * of the canvas instead of taking the page down. The panel and the rest of the page keep working.
 */
export default class ViewerErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("3D viewer failed:", error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const webgl = /webgl|context/i.test(this.state.error.message);
    return (
      <div role="alert" data-testid="viewer-error" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h3 className="font-display text-xl font-medium">The 3D view couldn&apos;t start</h3>
        <p className="max-w-sm text-sm leading-relaxed text-muted">
          {webgl
            ? "This browser or device does not support 3D graphics (WebGL), or it is turned off. Try an up-to-date Chrome, Edge, Firefox or Safari."
            : "Something went wrong while drawing the model. The property details are still available."}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className={button("secondary")}
        >
          Try again
        </button>
      </div>
    );
  }
}
