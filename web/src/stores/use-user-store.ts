"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, adminLogin, fetchCurrentUser, login, loginWithFit, register, type AuthPayload, type AuthUser, type FitLoginPayload } from "@/services/api/auth";

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    canvasSyncDisabled: boolean;
    setSession: (token: string, user: AuthUser, canvasSyncDisabled?: boolean) => void;
    clearSession: () => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    loginWithFit: (payload: FitLoginPayload) => Promise<AuthUser>;
    adminLogin: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            isReady: false,
            isLoading: false,
            canvasSyncDisabled: false,
            setSession: (token, user, canvasSyncDisabled = false) => set({ token, user, canvasSyncDisabled, isReady: true, isLoading: false }),
            clearSession: () => set({ token: "", user: null, canvasSyncDisabled: false, isReady: true, isLoading: false }),
            hydrateUser: async () => {
                const token = get().token;
                if (!token) {
                    set({ user: null, isReady: true });
                    return;
                }
                set({ isLoading: true });
                try {
                    const user = await fetchCurrentUser(token);
                    if (get().token !== token) return;
                    if (user.role === "guest") {
                        set({ token: "", user: null, canvasSyncDisabled: false, isReady: true, isLoading: false });
                        return;
                    }
                    set({ user, isReady: true, isLoading: false });
                } catch {
                    if (get().token !== token) return;
                    set({ token: "", user: null, canvasSyncDisabled: false, isReady: true, isLoading: false });
                }
            },
            login: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await login(payload);
                    set({ token: session.token, user: session.user, canvasSyncDisabled: false, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            loginWithFit: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await loginWithFit(payload);
                    set({ token: session.token, user: session.user, canvasSyncDisabled: false, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            adminLogin: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await adminLogin(payload);
                    set({ token: session.token, user: session.user, canvasSyncDisabled: false, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
            register: async (payload) => {
                set({ isLoading: true });
                try {
                    const session = await register(payload);
                    set({ token: session.token, user: session.user, canvasSyncDisabled: false, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    set({ isLoading: false });
                    throw error;
                }
            },
        }),
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token, canvasSyncDisabled: state.canvasSyncDisabled }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
