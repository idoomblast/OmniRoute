"use client";

import React from "react";
import PayloadJsonEditorFallback from "./PayloadJsonEditorFallback";
import { PAYLOAD_EDITOR_FAILURE_MESSAGE } from "@/shared/utils/payloadEditorMode";

interface PayloadJsonEditorBoundaryProps {
  jsonText: string;
  children: React.ReactNode;
}

interface PayloadJsonEditorBoundaryState {
  failed: boolean;
}

/**
 * Catches a rejected `next/dynamic` chunk load. Without this boundary the
 * payload disappears entirely after a stale-asset or transient chunk error.
 */
export default class PayloadJsonEditorBoundary extends React.Component<
  PayloadJsonEditorBoundaryProps,
  PayloadJsonEditorBoundaryState
> {
  state: PayloadJsonEditorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PayloadJsonEditorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    // Fixed category only: never log the payload or the raw error message.
    console.error(PAYLOAD_EDITOR_FAILURE_MESSAGE);
  }

  render() {
    if (this.state.failed) {
      return (
        <PayloadJsonEditorFallback
          text={this.props.jsonText}
          reason="Viewer failed to load"
          retryLabel="Reload page"
          onRetry={() => {
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      );
    }
    return this.props.children;
  }
}
