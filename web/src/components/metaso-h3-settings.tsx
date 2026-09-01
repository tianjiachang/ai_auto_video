import { Input, Segmented, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { type AiConfig, type H3GenerationMode, type H3InputMode } from "@/stores/use-config-store";

type MetasoH3SettingsProps = {
    config: AiConfig;
    onConfigChange: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    compact?: boolean;
};

export function MetasoH3Settings({ config, onConfigChange, compact = false }: MetasoH3SettingsProps) {
    const { t } = useTranslation();
    const mode = config.h3GenerationMode || "generate";

    return (
        <div className={compact ? "space-y-2.5 border-t border-stone-200 pt-3 dark:border-stone-800" : "space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800"}>
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{t("videoWorkbench.h3.title")}</span>
                <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{t("videoWorkbench.h3.contextIr")}</span>
                <Switch size="small" checked={config.h3ContextIrEnabled !== "false"} onChange={(checked) => onConfigChange("h3ContextIrEnabled", String(checked))} />
            </div>
            <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400">{t("videoWorkbench.h3.generationMode")}</span>
                <Segmented
                    block
                    size="small"
                    value={mode}
                    options={[
                        { value: "generate", label: t("videoWorkbench.h3.generate") },
                        { value: "regenerate-task", label: t("videoWorkbench.h3.regenerateTask") },
                        { value: "regenerate-video", label: t("videoWorkbench.h3.regenerateVideo") },
                    ]}
                    onChange={(value) => onConfigChange("h3GenerationMode", value as H3GenerationMode)}
                />
            </label>
            {mode === "regenerate-task" ? (
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400">{t("videoWorkbench.h3.sourceTaskId")}</span>
                    <Input value={config.h3SourceTaskId} placeholder={t("videoWorkbench.h3.sourceTaskPlaceholder")} onChange={(event) => onConfigChange("h3SourceTaskId", event.target.value)} />
                </label>
            ) : (
                <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-stone-500 dark:text-stone-400">{t("videoWorkbench.h3.inputMode")}</span>
                    <Segmented
                        block
                        size="small"
                        value={config.h3InputMode || "auto"}
                        options={[
                            { value: "auto", label: t("videoWorkbench.h3.inputAuto") },
                            { value: "frames", label: t("videoWorkbench.h3.inputFrames") },
                            { value: "references", label: t("videoWorkbench.h3.inputReferences") },
                        ]}
                        onChange={(value) => onConfigChange("h3InputMode", value as H3InputMode)}
                    />
                </label>
            )}
            {mode === "regenerate-video" ? <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("videoWorkbench.h3.sourceVideoHint")}</p> : null}
        </div>
    );
}
