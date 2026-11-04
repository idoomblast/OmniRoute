"use client";

export interface PayloadJsonEditorFallbackProps {
  text: string;
  reason: string;
  onRetry: () => void;
  retryLabel?: string;
}

/**
 * Escaped, read-only fallback used when JSONEditor cannot initialize or its
 * dynamic chunk fails to load. React escapes `text`, so arbitrary payload
 * content can never become markup here.
 */
export default function PayloadJsonEditorFallback({
  text,
  reason,
  onRetry,
  retryLabel = "Retry",
}: PayloadJsonEditorFallbackProps) {
  return (
    <div
      data-testid="payload-json-editor-fallback"
      className="payload-jsoneditor-wrapper flex h-150 w-full flex-col overflow-hidden rounded-xl border border-border"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-3 py-2">
        <span className="text-[11px] text-text-muted">{reason} — showing raw payload.</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-border px-2 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-alt hover:text-text-primary"
        >
          {retryLabel}
        </button>
      </div>
      <pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-text-main">
        {text}
      </pre>
    </div>
  );
}
