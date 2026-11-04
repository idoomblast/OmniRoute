"use client";

import { useEffect, useRef, useState } from "react";
import {
  PAYLOAD_EDITOR_FAILURE_MESSAGE,
  PAYLOAD_TREE_MAX_CHARS,
  createReadOnlyEditorOptions,
  isBlockedMutationShortcut,
  resolvePayloadEditorMode,
} from "@/shared/utils/payloadEditorMode";
import { loadPayloadTreeMaxChars } from "@/shared/utils/payloadEditorConfig";
import PayloadJsonEditorFallback from "./PayloadJsonEditorFallback";
import "jsoneditor/dist/jsoneditor.css";
import "./payloadJsonEditor.css";

export interface PayloadJsonEditorProps {
  jsonText: string;
}

interface JSONEditorInstance {
  set(json: unknown): void;
  setText(text: string): void;
  destroy(): void;
}

type ViewerStatus = "loading" | "ready" | "failed";

export default function PayloadJsonEditorImpl({ jsonText }: PayloadJsonEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const [maxChars, setMaxChars] = useState<number | null>(null);
  const mode = resolvePayloadEditorMode(jsonText, maxChars ?? PAYLOAD_TREE_MAX_CHARS);

  useEffect(() => {
    let active = true;
    loadPayloadTreeMaxChars()
      .then((value) => {
        if (active) setMaxChars(value);
      })
      .catch(() => {
        if (active) setMaxChars(PAYLOAD_TREE_MAX_CHARS);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (maxChars === null) return;
    let active = true;
    let editor: JSONEditorInstance | null = null;
    const container = containerRef.current;

    const blockMutationKeys = (event: Event) => {
      if (event instanceof KeyboardEvent && isBlockedMutationShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const blockInteraction = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (container) {
      container.addEventListener("keydown", blockMutationKeys, true);
      container.addEventListener("contextmenu", blockInteraction, true);
      container.addEventListener("dragstart", blockInteraction, true);
      container.addEventListener("drop", blockInteraction, true);
    }

    async function init() {
      try {
        const jsonEditorModule = await import("jsoneditor");
        if (!active || !containerRef.current) return;

        const JSONEditor =
          (
            jsonEditorModule as unknown as {
              default?: new (...args: unknown[]) => JSONEditorInstance;
            }
          ).default ||
          (jsonEditorModule as unknown as new (...args: unknown[]) => JSONEditorInstance);

        editor = new JSONEditor(containerRef.current, {
          ...createReadOnlyEditorOptions(mode),
          onError: () => {
            // Fixed category only: never log the payload or a raw parse error.
            console.error(PAYLOAD_EDITOR_FAILURE_MESSAGE);
          },
        });

        if (mode === "tree") {
          editor.set(JSON.parse(jsonText));
        } else {
          editor.setText(jsonText ?? "");
        }
        if (active) setStatus("ready");
      } catch {
        if (editor) {
          try {
            editor.destroy();
          } catch {
            // ignore destroy errors
          }
          editor = null;
        }
        // Remove any partially initialized DOM left by a failed constructor.
        containerRef.current?.replaceChildren();
        if (active) {
          console.error(PAYLOAD_EDITOR_FAILURE_MESSAGE);
          setStatus("failed");
        }
      }
    }

    init();

    return () => {
      active = false;
      if (container) {
        container.removeEventListener("keydown", blockMutationKeys, true);
        container.removeEventListener("contextmenu", blockInteraction, true);
        container.removeEventListener("dragstart", blockInteraction, true);
        container.removeEventListener("drop", blockInteraction, true);
        // Flush any pending textarea callbacks before the instance is destroyed.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && container.contains(focused)) {
          focused.blur();
        }
      }
      if (editor) {
        try {
          editor.destroy();
        } catch {
          // ignore destroy errors
        }
        editor = null;
      }
      container?.replaceChildren();
    };
  }, [jsonText, mode, attempt, maxChars]);

  return (
    <>
      <div
        ref={containerRef}
        data-testid="payload-json-editor"
        data-mode={mode}
        className={`payload-jsoneditor-wrapper w-full h-150 rounded-xl border border-border overflow-hidden${status === "failed" ? " hidden" : ""}`}
        title={mode === "text" ? "Rendered in read-only text mode" : undefined}
      />
      {status === "failed" && (
        <PayloadJsonEditorFallback
          text={jsonText}
          reason="Viewer unavailable"
          onRetry={() => {
            setStatus("loading");
            setAttempt((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
