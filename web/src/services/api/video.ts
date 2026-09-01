import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, isMetasoH3VideoModel, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationInput = {
    images?: ReferenceImage[];
    videos?: ReferenceVideo[];
    audios?: ReferenceAudio[];
};

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; providerTaskId?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "plugin" | "metaso-h3"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, input: VideoGenerationInput | ReferenceImage[] = {}, options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, input, options);
    const maxAttempts = task.provider === "metaso-h3" ? 240 : 120;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === maxAttempts - 1) throw new Error(apiText("videoTimeout", { provider: "" }));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, input: VideoGenerationInput | ReferenceImage[] = {}, options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    const references = normalizeVideoInput(input);
    if (isMetasoH3VideoModel(config, selectedModel)) return createMetasoH3VideoTask(requestConfig, selectedModel, prompt, references, options);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references.images, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references.images, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    if (task.provider === "metaso-h3") return pollMetasoH3VideoTask(requestConfig, task, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return { ...(await uploadMediaFile(result.blob, "video")), providerTaskId: result.providerTaskId };
    if (result.url) {
        try {
            return { ...(await uploadMediaFile(result.url, "video")), providerTaskId: result.providerTaskId };
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4", providerTaskId: result.providerTaskId };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

type MetasoTask = {
    id?: string | number;
    status?: string;
    content?: { url?: string; video_url?: string } | null;
    base_resp?: { status_code?: number | string; status_msg?: string; message?: string };
};

type MetasoContent =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" | "reference_image" }
    | { type: "video_url"; video_url: { url: string }; role: "reference_video" | "base_video" }
    | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

const METASO_MAX_REQUEST_BYTES = 64 * 1024 * 1024;

function normalizeVideoInput(input: VideoGenerationInput | ReferenceImage[]): Required<VideoGenerationInput> {
    return Array.isArray(input) ? { images: input, videos: [], audios: [] } : { images: input.images || [], videos: input.videos || [], audios: input.audios || [] };
}

function metasoUrl(config: AiConfig, path: string) {
    return `${config.baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

async function createMetasoH3VideoTask(config: AiConfig, model: string, prompt: string, input: Required<VideoGenerationInput>, options?: RequestOptions): Promise<VideoGenerationTask> {
    assertVideoConfig(config, model);
    const generationMode = config.h3GenerationMode || "generate";
    let body: Record<string, unknown>;
    let path: string;

    if (generationMode === "regenerate-task") {
        const sourceTaskId = (config.h3SourceTaskId || input.videos.find((video) => video.providerTaskId)?.providerTaskId || "").trim();
        if (!sourceTaskId) throw new Error(i18n.t("videoWorkbench.h3.sourceTaskRequired"));
        path = "/v2/video_regeneration";
        body = {
            model: modelOptionName(model),
            source_task_id: sourceTaskId,
            resolution: normalizeMetasoResolution(config.vquality),
            context_ir_enabled: boolConfig(config.h3ContextIrEnabled, true),
            aigc_watermark: boolConfig(config.videoWatermark, false),
        };
    } else {
        const content = await buildMetasoContent(prompt, input, config, generationMode === "regenerate-video", options?.signal);
        path = generationMode === "regenerate-video" ? "/v2/video_regeneration" : "/v2/video_generation";
        body = {
            model: modelOptionName(model),
            content,
            resolution: normalizeMetasoResolution(config.vquality),
            duration: normalizeMetasoDuration(config.videoSeconds),
            ratio: normalizeMetasoRatio(config.size),
            context_ir_enabled: boolConfig(config.h3ContextIrEnabled, true),
            aigc_watermark: boolConfig(config.videoWatermark, false),
        };
    }

    if (new Blob([JSON.stringify(body)]).size > METASO_MAX_REQUEST_BYTES) throw new Error(i18n.t("videoWorkbench.h3.requestTooLarge"));
    try {
        const payload = (await axios.post<unknown>(metasoUrl(config, path), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data;
        assertMetasoSuccess(payload);
        const taskId = readMetasoTaskId(payload);
        if (!taskId) throw new Error(apiText("noVideoTaskId"));
        return { id: taskId, provider: "metaso-h3", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function buildMetasoContent(prompt: string, input: Required<VideoGenerationInput>, config: AiConfig, sourceVideoRegeneration: boolean, signal?: AbortSignal): Promise<MetasoContent[]> {
    const images = await Promise.all(input.images.map(async (image) => ({ image, url: await imageToMetasoUrl(image) })));
    if (images.some(({ url }) => !url)) throw new Error(apiText("referenceImageReadFailed"));
    const videoUrls = await Promise.all(input.videos.map((video) => mediaToMetasoUrl(video, "video", signal)));
    const audioUrls = await Promise.all(input.audios.map((audio) => mediaToMetasoUrl(audio, "audio", signal)));
    const content: MetasoContent[] = [{ type: "text", text: prompt }];
    const useFrames = config.h3InputMode === "frames" || (config.h3InputMode !== "references" && images.length <= 2 && !videoUrls.length && !audioUrls.length);

    if (useFrames) {
        images.slice(0, 2).forEach(({ url }, index) => content.push({ type: "image_url", image_url: { url }, role: index === 0 ? "first_frame" : "last_frame" }));
    } else {
        images.forEach(({ url }) => content.push({ type: "image_url", image_url: { url }, role: "reference_image" }));
    }

    if (sourceVideoRegeneration) {
        const [baseVideo, ...referenceVideos] = videoUrls;
        if (!baseVideo) throw new Error(i18n.t("videoWorkbench.h3.sourceVideoRequired"));
        referenceVideos.forEach((url) => content.push({ type: "video_url", video_url: { url }, role: "reference_video" }));
        audioUrls.forEach((url) => content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" }));
        content.push({ type: "video_url", video_url: { url: baseVideo }, role: "base_video" });
        return content;
    }

    videoUrls.forEach((url) => content.push({ type: "video_url", video_url: { url }, role: "reference_video" }));
    audioUrls.forEach((url) => content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" }));
    return content;
}

async function imageToMetasoUrl(image: ReferenceImage) {
    const url = image.url || image.dataUrl || "";
    return /^(https?:|data:|mm_file:\/\/)/i.test(url) ? url : imageToDataUrl(image);
}

async function mediaToMetasoUrl(reference: ReferenceVideo | ReferenceAudio, kind: "video" | "audio", signal?: AbortSignal) {
    const url = reference.url?.trim() || "";
    if (/^(https?:|data:|mm_file:\/\/)/i.test(url)) return url;
    let blob: Blob | null = null;
    if (reference.storageKey) blob = await getMediaBlob(reference.storageKey);
    if (!blob && url) {
        try {
            blob = (await axios.get<Blob>(url, { responseType: "blob", signal })).data;
        } catch {
            // The user may have revoked an old object URL; give a useful provider-specific error below.
        }
    }
    if (!blob) throw new Error(apiText(kind === "video" ? "invalidReferenceVideo" : "invalidReferenceAudio"));
    return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("localAssetReadFailed")));
        reader.readAsDataURL(blob);
    });
}

async function pollMetasoH3VideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(metasoUrl(config, `/v2/query/video_generation/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        assertMetasoSuccess(payload);
        const remoteTask = readMetasoTask(payload);
        const url = remoteTask.content?.url || remoteTask.content?.video_url;
        if (url) return { status: "completed", result: { ...(await videoResultFromUrl(url, options)), providerTaskId: String(remoteTask.id || task.id) } };
        const status = String(remoteTask.status || "").toLowerCase();
        if (["failed", "fail", "cancelled", "canceled", "rejected"].includes(status)) return { status: "failed", error: readMetasoError(payload) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function normalizeMetasoDuration(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return Math.max(4, Math.min(15, seconds));
}

function normalizeMetasoResolution(value: string) {
    return /^2k$/i.test(value.trim()) || value.trim() === "2048" ? "2K" : "768P";
}

function normalizeMetasoRatio(value: string) {
    if (!value || value === "auto") return "adaptive";
    if (value === "16:9" || value === "9:16" || value === "1:1") return value;
    const dimensions = value.match(/^(\d+)x(\d+)$/i);
    if (!dimensions) return "adaptive";
    const width = Number(dimensions[1]);
    const height = Number(dimensions[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    return (["16:9", "9:16", "1:1"] as const).reduce((closest, candidate) => {
        const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
        return Math.abs(candidateWidth / candidateHeight - ratio) < Math.abs(Number(closest.split(":")[0]) / Number(closest.split(":")[1]) - ratio) ? candidate : closest;
    });
}

function readMetasoTaskId(payload: unknown) {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    const value = record?.task_id || data?.task_id || record?.id || data?.id;
    return value === undefined || value === null ? "" : String(value);
}

function readMetasoTask(payload: unknown): MetasoTask {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    return (asRecord(record?.task) || asRecord(data?.task) || data || record || {}) as MetasoTask;
}

function assertMetasoSuccess(payload: unknown) {
    const error = readMetasoError(payload);
    if (error) throw new Error(error);
}

function readMetasoError(payload: unknown) {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    const baseResponse = asRecord(record?.base_resp) || asRecord(data?.base_resp);
    const code = baseResponse?.status_code;
    return code !== undefined && code !== 0 && code !== "0" ? readApiErrorMessage(baseResponse?.status_msg || baseResponse?.message || record?.message || record?.msg) || apiText("requestFailed") : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
