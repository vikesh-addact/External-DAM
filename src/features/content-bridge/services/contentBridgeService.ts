import type { ContentEnvironment, ContentTreeItem, DependencyFinding, TransferDraft, TransferRecord } from '../types';

const contentTransferApiBase = process.env.NEXT_PUBLIC_SITECORE_CONTENT_TRANSFER_API_BASE_URL ?? '';
const itemTransferApiBase = process.env.NEXT_PUBLIC_SITECORE_ITEM_TRANSFER_API_BASE_URL ?? '';

interface CachedToken {
    accessToken: string;
    expiresAt: number;
}

export interface AuthState {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    clientId?: string;
}

export interface ContentBridgeService {
    getEnvironments(): Promise<ContentEnvironment[]>;
    getContentTree(environmentId: string): Promise<ContentTreeItem[]>;
    validateDependencies(itemIds: string[]): Promise<DependencyFinding[]>;
    createContentTransfer(draft: TransferDraft): Promise<TransferRecord>;
    getTransfers(): Promise<TransferRecord[]>;
    retryTransfer(id: string): Promise<TransferRecord>;
    isLiveMode(): boolean;
    getApiStatus(): { contentTransfer: boolean; itemTransfer: boolean; authenticated: boolean };
    getAuthState(): AuthState;
    connect(clientId: string, clientSecret: string): Promise<void>;
    disconnect(): void;
    loadSavedCredentials(): boolean;
}

const STORAGE_KEY_CLIENT_ID = 'contentbridge_client_id';
const STORAGE_KEY_CLIENT_SECRET = 'contentbridge_client_secret';

let cachedToken: CachedToken | null = null;
let currentClientId: string | null = null;
let currentClientSecret: string | null = null;
let authState: AuthState = { status: 'disconnected' };



function getTokenFromStorage(): { clientId: string; clientSecret: string } | null {
    try {
        const clientId = localStorage.getItem(STORAGE_KEY_CLIENT_ID);
        const clientSecret = localStorage.getItem(STORAGE_KEY_CLIENT_SECRET);
        if (clientId && clientSecret) {
            return { clientId, clientSecret };
        }
    } catch {
        // localStorage not available
    }
    return null;
}

function saveCredentialsToStorage(clientId: string, clientSecret: string): void {
    try {
        localStorage.setItem(STORAGE_KEY_CLIENT_ID, clientId);
        localStorage.setItem(STORAGE_KEY_CLIENT_SECRET, clientSecret);
    } catch {
        // localStorage not available
    }
}

function clearCredentialsFromStorage(): void {
    try {
        localStorage.removeItem(STORAGE_KEY_CLIENT_ID);
        localStorage.removeItem(STORAGE_KEY_CLIENT_SECRET);
    } catch {
        // localStorage not available
    }
}

async function fetchAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const response = await fetch('/api/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || data.error || `Authentication failed (${response.status})`);
    }

    const data = await response.json();
    cachedToken = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000, // Refresh 60s before expiry
    };
    return data.access_token;
}

async function getValidToken(): Promise<string | null> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.accessToken;
    }

    if (currentClientId && currentClientSecret) {
        try {
            return await fetchAccessToken(currentClientId, currentClientSecret);
        } catch {
            authState = { status: 'error', error: 'Token refresh failed', clientId: currentClientId ?? undefined };
            return null;
        }
    }

    return null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
        const token = await getValidToken();
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...(init?.headers as Record<string, string> ?? {}),
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(url, {
            ...init,
            headers,
        });

        if (response.status === 401 && currentClientId && currentClientSecret) {
            cachedToken = null;
            const retryToken = await getValidToken();
            if (retryToken) {
                headers['Authorization'] = `Bearer ${retryToken}`;
                const retryResponse = await fetch(url, { ...init, headers });
                if (!retryResponse.ok) return null;
                return (await retryResponse.json()) as T;
            }
        }

        if (!response.ok) {
            console.warn(`API request failed: ${response.status} ${response.statusText} for ${url}`);
            return null;
        }

        return (await response.json()) as T;
    } catch (error) {
        console.warn(`API request error for ${url}:`, error);
        return null;
    }
}

async function getLiveEnvironments(): Promise<ContentEnvironment[] | null> {
    if (!contentTransferApiBase || authState.status !== 'connected') {
        return null;
    }

    const payload = await requestJson<ContentEnvironment[] | { environments: ContentEnvironment[] }>(
        `${contentTransferApiBase}/environments`
    );

    if (!payload) return null;

    if (Array.isArray(payload)) return payload;
    if ('environments' in payload && Array.isArray(payload.environments)) return payload.environments;

    return null;
}

async function getLiveContentTree(environmentId: string): Promise<ContentTreeItem[] | null> {
    if (!contentTransferApiBase || authState.status !== 'connected') {
        return null;
    }

    const payload = await requestJson<ContentTreeItem[] | { items: ContentTreeItem[] }>(
        `${contentTransferApiBase}/content-tree?environmentId=${encodeURIComponent(environmentId)}`
    );

    if (!payload) return null;

    if (Array.isArray(payload)) return payload;
    if ('items' in payload && Array.isArray(payload.items)) return payload.items;

    return null;
}

async function getLiveTransfers(): Promise<TransferRecord[] | null> {
    if (!contentTransferApiBase || authState.status !== 'connected') {
        return null;
    }

    const payload = await requestJson<TransferRecord[] | { transfers: TransferRecord[] }>(
        `${contentTransferApiBase}/transfers`
    );

    if (!payload) return null;

    if (Array.isArray(payload)) return payload;
    if ('transfers' in payload && Array.isArray(payload.transfers)) return payload.transfers;

    return null;
}

async function createLiveContentTransfer(draft: TransferDraft): Promise<TransferRecord | null> {
    if (!contentTransferApiBase || authState.status !== 'connected') {
        return null;
    }

    const payload = await requestJson<TransferRecord>(
        `${contentTransferApiBase}/transfers`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: draft.name,
                sourceEnvironmentId: draft.sourceEnvironmentId,
                destinationEnvironmentId: draft.destinationEnvironmentId,
                selectedItemIds: draft.selectedItemIds,
                strategy: draft.strategy,
            }),
        }
    );

    return payload;
}

async function retryLiveTransfer(id: string): Promise<TransferRecord | null> {
    if (!contentTransferApiBase || authState.status !== 'connected') {
        return null;
    }

    const payload = await requestJson<TransferRecord>(
        `${contentTransferApiBase}/transfers/${encodeURIComponent(id)}/retry`,
        { method: 'POST' }
    );

    return payload;
}

export function createContentBridgeService(): ContentBridgeService {
    return {
        isLiveMode() {
            return authState.status === 'connected';
        },

        getApiStatus() {
            return {
                contentTransfer: Boolean(contentTransferApiBase),
                itemTransfer: Boolean(itemTransferApiBase),
                authenticated: authState.status === 'connected',
            };
        },

        getAuthState() {
            return authState;
        },

        async connect(clientId, clientSecret) {
            authState = { status: 'connecting', clientId };

            try {
                await fetchAccessToken(clientId, clientSecret);
                currentClientId = clientId;
                currentClientSecret = clientSecret;
                saveCredentialsToStorage(clientId, clientSecret);
                authState = { status: 'connected', clientId };
            } catch (err) {
                authState = {
                    status: 'error',
                    error: err instanceof Error ? err.message : 'Connection failed',
                    clientId,
                };
                throw err;
            }
        },

        disconnect() {
            cachedToken = null;
            currentClientId = null;
            currentClientSecret = null;
            authState = { status: 'disconnected' };
            clearCredentialsFromStorage();
        },

        loadSavedCredentials() {
            const saved = getTokenFromStorage();
            if (saved) {
                currentClientId = saved.clientId;
                currentClientSecret = saved.clientSecret;
                authState = { status: 'connected', clientId: saved.clientId };
                return true;
            }
            return false;
        },

        async getEnvironments() {
            const live = await getLiveEnvironments();
            if (!live) throw new Error('Failed to load environments from Sitecore API. Check your connection and try again.');
            return live;
        },

        async getContentTree(environmentId) {
            const live = await getLiveContentTree(environmentId);
            if (!live) throw new Error('Failed to load content tree from Sitecore API. Check your connection and try again.');
            return live;
        },

        async validateDependencies(itemIds) {
            if (itemIds.length === 0) return [];

            const payload = await requestJson<DependencyFinding[] | { findings: DependencyFinding[] }>(
                `${contentTransferApiBase}/validate-dependencies`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ itemIds }),
                }
            );

            if (!payload) throw new Error('Failed to validate dependencies. The Content Transfer API may not support this endpoint yet.');

            if (Array.isArray(payload)) return payload;
            if ('findings' in payload && Array.isArray(payload.findings)) return payload.findings;

            throw new Error('Unexpected response format from dependency validation API.');
        },

        async createContentTransfer(draft) {
            const live = await createLiveContentTransfer(draft);
            if (!live) throw new Error('Failed to create content transfer. Check your connection and try again.');
            return live;
        },

        async getTransfers() {
            const live = await getLiveTransfers();
            if (!live) throw new Error('Failed to load transfers from Sitecore API. Check your connection and try again.');
            return live;
        },

        async retryTransfer(id) {
            const live = await retryLiveTransfer(id);
            if (!live) throw new Error('Failed to retry transfer. Check your connection and try again.');
            return live;
        },
    };
}
