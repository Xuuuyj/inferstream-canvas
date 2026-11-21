import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { isCanvasTabSuperseded } from "@/lib/canvas-tab-guard";
import { localForageStorage } from "@/lib/localforage-storage";
import { STORAGE_SYNC_FAILED_EVENT, deleteImagePreviews } from "@/services/image-storage";
import { listCanvasProjects, saveCanvasProject, syncCanvasProjects } from "@/services/api/canvas-tasks";
import { saveRetryDelayMs } from "@/services/api/request";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAgentConfig, CanvasAssistantSession, CanvasConnection, CanvasNodeData, CanvasPendingAgentRequest, ViewportTransform } from "../types";

export type CanvasSidePanelState = {
    open: boolean;
    width: number;
};

export const DEFAULT_CANVAS_SIDE_PANEL: CanvasSidePanelState = { open: true, width: 280 };
export const DEFAULT_CANVAS_AGENT_PANEL: CanvasSidePanelState = { open: false, width: 464 };

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    agentConfig: CanvasAgentConfig | null;
    autoTitlePending: boolean;
    pendingAgentRequest?: CanvasPendingAgentRequest;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    sidePanel: CanvasSidePanelState;
    agentPanel: CanvasSidePanelState;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, options?: { agentConfig?: CanvasAgentConfig; pendingAgentRequest?: CanvasPendingAgentRequest }) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "agentConfig" | "autoTitlePending" | "backgroundMode" | "showImageInfo" | "viewport" | "sidePanel" | "agentPanel" | "pendingAgentRequest">>) => void;
    syncWithRemote: (token: string, syncEnabled: boolean) => Promise<void>;
    setSyncEnabled: (enabled: boolean) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
let accountCanvasSyncEnabled = false;
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingProjectSaves = new Map<string, { token: string; project: CanvasProject }>();
const savingProjects = new Set<string>();
const PROJECT_SAVE_DEBOUNCE_MS = 2000;
const PROJECT_SAVE_MAX_BACKOFF_MS = 60_000;
// 画布保存接口按账号限流，所有画布共用一个额度：429 后全部画布都等到这个时间点再发。
let projectSaveBlockedUntil = 0;
let projectSaveBackoffMs = 0;

function waitForUserStoreHydration() {
    if (useUserStore.persist.hasHydrated()) return Promise.resolve();

    return new Promise<void>((resolve) => {
        let unsubscribe = () => { };
        unsubscribe = useUserStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
        if (useUserStore.persist.hasHydrated()) {
            unsubscribe();
            resolve();
        }
    });
}

function allowsCanvasSync(token: string) {
    const session = useUserStore.getState();
    return !!token && token === session.token && !session.canvasSyncDisabled;
}

async function flushProjectSave(id: string) {
    if (savingProjects.has(id) || projectSaveTimers.has(id)) return;
    const pending = pendingProjectSaves.get(id);
    if (!pending) return;
    if (!accountCanvasSyncEnabled || !allowsCanvasSync(pending.token)) {
        pendingProjectSaves.delete(id);
        return;
    }
    if (Date.now() < projectSaveBlockedUntil) {
        scheduleProjectSave(id, 0);
        return;
    }

    pendingProjectSaves.delete(id);
    savingProjects.add(id);
    try {
        await saveCanvasProject(pending.token, pending.project);
        projectSaveBackoffMs = 0;
    } catch (error) {
        projectSaveBackoffMs = Math.min(PROJECT_SAVE_MAX_BACKOFF_MS, Math.max(5000, projectSaveBackoffMs * 2));
        const delay = saveRetryDelayMs(error, projectSaveBackoffMs);
        const { hydrated, projects } = useCanvasStore.getState();
        if (!allowsCanvasSync(pending.token)) {
            // 保存途中退出或换了账号：这一版不再发。
        } else if (delay === null) {
            console.error("Failed to save canvas project", error);
            window.dispatchEvent(new CustomEvent(STORAGE_SYNC_FAILED_EVENT, { detail: `画布「${pending.project.title}」保存失败${error instanceof Error ? `：${error.message}` : ""}` }));
        } else if (!hydrated || projects.some((project) => project.id === id)) {
            // 429、断网、5xx：等一会儿重发；等待期间又改过就发最新的那版，画布已删除就不再发。
            if (!pendingProjectSaves.has(id)) pendingProjectSaves.set(id, pending);
            projectSaveBlockedUntil = Math.max(projectSaveBlockedUntil, Date.now() + delay);
            scheduleProjectSave(id, delay);
        }
    } finally {
        savingProjects.delete(id);
    }
    void flushProjectSave(id);
}

function scheduleProjectSave(id: string, delayMs: number) {
    const previous = projectSaveTimers.get(id);
    if (previous) clearTimeout(previous);
    projectSaveTimers.set(
        id,
        setTimeout(() => {
            projectSaveTimers.delete(id);
            void flushProjectSave(id);
        }, Math.max(delayMs, projectSaveBlockedUntil - Date.now())),
    );
}

function queueProjectSave(project: CanvasProject) {
    if (isCanvasTabSuperseded()) return;
    const token = useUserStore.getState().token;
    if (!allowsCanvasSync(token) || !accountCanvasSyncEnabled) {
        cancelProjectSaves([project.id]);
        return;
    }
    pendingProjectSaves.set(project.id, { token, project });
    scheduleProjectSave(project.id, PROJECT_SAVE_DEBOUNCE_MS);
}

function cancelProjectSaves(ids: string[]) {
    ids.forEach((id) => {
        pendingProjectSaves.delete(id);
        const timer = projectSaveTimers.get(id);
        if (!timer) return;
        clearTimeout(timer);
        projectSaveTimers.delete(id);
    });
}

async function reconcileCanvasProjects(
    token: string,
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
) {
    const remoteById = new Map(
        remoteProjects.map((project) => [project.id, project]),
    );
    const missingProjects = localProjects.filter(
        (project) => !remoteById.has(project.id),
    );
    const existingLocalProjects = localProjects.filter((project) =>
        remoteById.has(project.id),
    );
    const projects = missingProjects.length
        ? await syncCanvasProjects(token, missingProjects)
            .then((syncedProjects) =>
                mergeCanvasProjects(
                    syncedProjects,
                    existingLocalProjects,
                ),
            )
            .catch(() =>
                mergeCanvasProjects(remoteProjects, localProjects),
            )
        : mergeCanvasProjects(remoteProjects, existingLocalProjects);

    if (!allowsCanvasSync(token)) return localProjects;
    localProjects.forEach((project) => {
        const remote = remoteById.get(project.id);
        if (
            remote &&
            Date.parse(project.updatedAt || "") >
            Date.parse(remote.updatedAt || "")
        ) {
            queueProjectSave(project);
        }
    });

    return projects;
}

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        await waitForUserStoreHydration();
        const localValue = await localForageStorage.getItem(name);
        const token = useUserStore.getState().token;
        const localParsed = localValue
            ? (JSON.parse(localValue) as StorageValue<CanvasStore>)
            : null;
        const localProjects =
            (localParsed?.state as PersistedCanvasState)?.projects || [];
        const localHasData =
            Array.isArray(localProjects) && localProjects.length > 0;

        if (allowsCanvasSync(token)) {
            try {
                const [userConfig, remoteProjects] = await Promise.all([
                    fetchUserConfig(token),
                    listCanvasProjects(token),
                ]);
                if (!allowsCanvasSync(token)) return localParsed;
                accountCanvasSyncEnabled =
                    userConfig.syncCapabilities?.userData === true;

                if (accountCanvasSyncEnabled && localHasData) {
                    const projects = await reconcileCanvasProjects(
                        token,
                        remoteProjects,
                        localProjects,
                    );

                    if (!allowsCanvasSync(token)) return localParsed;
                    const nextState = { projects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }

                if (
                    remoteProjects.length > 0 &&
                    (accountCanvasSyncEnabled || !localHasData)
                ) {
                    const nextState = { projects: remoteProjects };
                    const parsed = {
                        state: nextState,
                        version: 0,
                    } as StorageValue<CanvasStore>;
                    queuedPersistState = nextState;
                    await localForageStorage.setItem(
                        name,
                        JSON.stringify(parsed),
                    );
                    return parsed;
                }
            } catch (error) {
                console.error(
                    "Failed to hydrate canvas projects from remote",
                    error,
                );
            }
        }

        if (!localParsed) return null;
        queuedPersistState = localParsed.state as PersistedCanvasState;
        return localParsed;
    },

    setItem: (name, value) => {
        // 另一个画布页面打开后本页不再存盘，免得拿本页的旧项目盖掉那边的改动（lib/canvas-tab-guard.ts）
        if (isCanvasTabSuperseded()) return;
        const nextState = value.state as PersistedCanvasState;
        if (
            queuedPersistState &&
            queuedPersistState.projects === nextState.projects
        ) {
            return;
        }
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            if (isCanvasTabSuperseded()) return;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = "未命名画布", options) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    agentConfig: options?.agentConfig || null,
                    autoTitlePending: true,
                    pendingAgentRequest: options?.pendingAgentRequest,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                    sidePanel: DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: options?.pendingAgentRequest ? { ...DEFAULT_CANVAS_AGENT_PANEL, open: true } : DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || "导入画布",
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: (source.chatSessions || []).map((session) => ({ ...session, codexThreadId: undefined, codexServiceId: undefined })),
                    activeChatId: source.activeChatId || null,
                    agentConfig: source.agentConfig || null,
                    autoTitlePending: false,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                    sidePanel: source.sidePanel || DEFAULT_CANVAS_SIDE_PANEL,
                    agentPanel: source.agentPanel || DEFAULT_CANVAS_AGENT_PANEL,
                };
                set((state) => ({
                    projects: [project, ...state.projects],
                }));
                queueProjectSave(project);
                return project.id;
            },
            openProject: (id) =>
                get().projects.find((item) => item.id === id) || null,
            renameProject: (id, title) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    title: title.trim() || project.title,
                    autoTitlePending: false,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            deleteProjects: (ids) => {
                cancelProjectSaves(ids);
                void deleteImagePreviews(
                    get().projects
                        .filter((project) => ids.includes(project.id))
                        .flatMap((project) => project.nodes.map((node) => `canvas-node:${project.id}:${node.id}`)),
                );
                set((state) => ({
                    projects: state.projects.filter(
                        (project) => !ids.includes(project.id),
                    ),
                }));
            },
            updateProject: (id, patch) => {
                const project = get().projects.find(
                    (item) => item.id === id,
                );
                if (!project) return;
                const nextProject = {
                    ...project,
                    ...patch,
                    updatedAt: new Date().toISOString(),
                };
                set((state) => ({
                    projects: state.projects.map((item) =>
                        item.id === id ? nextProject : item,
                    ),
                }));
                queueProjectSave(nextProject);
            },
            syncWithRemote: async (token, syncEnabled) => {
                accountCanvasSyncEnabled = syncEnabled;
                if (!syncEnabled || !allowsCanvasSync(token) || isCanvasTabSuperseded()) return;
                const localProjects = get().projects;
                const remoteProjects = await listCanvasProjects(token).catch(
                    () => null,
                );
                if (!remoteProjects || !allowsCanvasSync(token)) return;
                const projects = await reconcileCanvasProjects(
                    token,
                    remoteProjects,
                    localProjects,
                );
                if (!allowsCanvasSync(token)) return;
                if (saveTimer) {
                    clearTimeout(saveTimer);
                    saveTimer = null;
                }
                const nextState = { projects };
                queuedPersistState = nextState;
                set(nextState);
                await localForageStorage.setItem(
                    CANVAS_STORE_KEY,
                    JSON.stringify({ state: nextState, version: 0 }),
                );
            },
            setSyncEnabled: (enabled) => {
                accountCanvasSyncEnabled = enabled;
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function mergeCanvasProjects(
    remoteProjects: CanvasProject[],
    localProjects: CanvasProject[],
): CanvasProject[] {
    const projects = new Map<string, CanvasProject>();
    [...localProjects, ...remoteProjects].forEach((project) => {
        const previous = projects.get(project.id);
        if (
            !previous ||
            Date.parse(project.updatedAt || "") >=
            Date.parse(previous.updatedAt || "")
        ) {
            projects.set(project.id, project);
        }
    });
    return Array.from(projects.values()).sort(
        (a, b) =>
            Date.parse(b.updatedAt || "") -
            Date.parse(a.updatedAt || ""),
    );
}
