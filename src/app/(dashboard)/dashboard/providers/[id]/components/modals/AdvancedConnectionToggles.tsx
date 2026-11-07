"use client";

import { Toggle } from "@/shared/components";
import { providerText, type ProviderMessageTranslator } from "../../providerCredentialText";

type AdvancedToggleValues = {
  importFreeModelsOnly: boolean;
  disableCooling: boolean;
  keepMidConversationSystem: boolean;
  requireUserLastMessage: boolean;
};

type Props = {
  values: AdvancedToggleValues;
  onChange: (patch: Partial<AdvancedToggleValues>) => void;
  t: ProviderMessageTranslator;
  showFreeModelsToggle: boolean;
  isPlainAnthropicCompatible: boolean;
};

export default function AdvancedConnectionToggles({
  values,
  onChange,
  t,
  showFreeModelsToggle,
  isPlainAnthropicCompatible,
}: Props) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border/50 bg-surface/20 p-4">
      {showFreeModelsToggle && (
        <Toggle
          checked={values.importFreeModelsOnly}
          onChange={(checked) => onChange({ importFreeModelsOnly: checked })}
          label={t("importFreeModelsOnlyLabel")}
          description={t("importFreeModelsOnlyHint")}
        />
      )}
      <Toggle
        checked={values.disableCooling}
        onChange={(checked) => onChange({ disableCooling: checked })}
        label={t("disableCoolingLabel")}
        description={t("disableCoolingDescription")}
      />
      {isPlainAnthropicCompatible && (
        <Toggle
          checked={values.requireUserLastMessage}
          onChange={(checked) => onChange({ requireUserLastMessage: checked })}
          label={providerText(
            t,
            "requireUserLastMessageLabel",
            "Require a user message last (drop assistant prefill)"
          )}
          description={providerText(
            t,
            "requireUserLastMessageDescription",
            'Drop trailing assistant turns before sending, for relays that reject assistant prefill with "The conversation must end with a user message". The model may regenerate an answer the client already has.'
          )}
        />
      )}
      {isPlainAnthropicCompatible && (
        <Toggle
          checked={values.keepMidConversationSystem}
          onChange={(checked) => onChange({ keepMidConversationSystem: checked })}
          label={providerText(
            t,
            "keepMidConversationSystemLabel",
            "Keep mid-conversation system messages in place"
          )}
          description={providerText(
            t,
            "keepMidConversationSystemDescription",
            'Leave system messages sent mid-conversation inside the message list instead of moving them into the top-level system prompt, so the prompt cache keeps hitting across turns. Enable only if this upstream accepts role "system" inside messages (otherwise it answers 400).'
          )}
        />
      )}
    </div>
  );
}
