"use client";

import dynamic from "next/dynamic";
import PayloadJsonEditorBoundary from "./PayloadJsonEditorBoundary";
import type { PayloadJsonEditorProps } from "./PayloadJsonEditorImpl";

const PayloadJsonEditorImpl = dynamic<PayloadJsonEditorProps>(
  () => import("./PayloadJsonEditorImpl"),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="payload-json-editor"
        data-mode="loading"
        className="payload-jsoneditor-wrapper w-full h-150 rounded-xl border border-border bg-black/5 dark:bg-black/30 flex items-center justify-center text-xs text-text-muted font-mono"
      >
        Loading payload viewer...
      </div>
    ),
  }
);

export default function PayloadJsonEditor({ jsonText }: PayloadJsonEditorProps) {
  return (
    <PayloadJsonEditorBoundary jsonText={jsonText}>
      <PayloadJsonEditorImpl jsonText={jsonText} />
    </PayloadJsonEditorBoundary>
  );
}

export type { PayloadJsonEditorProps };
