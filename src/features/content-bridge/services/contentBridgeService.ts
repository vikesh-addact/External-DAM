import { contentTree, dependencyFindings, environments, transfers } from '../mockData';
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

const wait = (duration = 220) =>
    new Promise((resolve) => {
        window.setTimeout(resolve, duration);
    });

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
            await wait();
            const live = await getLiveEnvironments();
            return live ?? environments;
        },

        async getContentTree(environmentId) {
            await wait();
            const live = await getLiveContentTree(environmentId);
            return live ?? contentTree;
        },

        async validateDependencies(itemIds) {
            await wait(280);
            if (itemIds.length === 0) {
                return [];
            }

            return dependencyFindings.filter((finding) =>
                itemIds.some((id) => finding.id.endsWith('1') || id.includes('products'))
            );
        },

        async createContentTransfer(draft) {
            await wait(420);

            const live = await createLiveContentTransfer(draft);
            if (live) return live;

            const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

            return {
                id: `tr-${Math.floor(Math.random() * 9000) + 1000}`,
                name: draft.name,
                sourceEnvironmentId: draft.sourceEnvironmentId,
                destinationEnvironmentId: draft.destinationEnvironmentId,
                selectedItemIds: draft.selectedItemIds,
                strategy: draft.strategy,
                status: 'queued',
                progress: 8,
                createdBy: 'Current user',
                createdAt: now,
                updatedAt: now,
                contentTransferRequestId: `ct-${Math.floor(Math.random() * 90000) + 10000}`,
                itemTransferJobId: `it-${Math.floor(Math.random() * 90000) + 10000}`,
                blobUrl: 'pending-content-transfer-blob.zip',
                auditLog: [
                    {
                        id: 'audit-new-1',
                        timestamp: now,
                        actor: 'Current user',
                        action: 'Created transfer request',
                        detail: 'Content Transfer API request prepared for Item Transfer blob consumption.',
                    },
                ],
            };
        },

        async getTransfers() {
            await wait();
            const live = await getLiveTransfers();
            return live ?? transfers;
        },

        async retryTransfer(id) {
            await wait(360);

            const live = await retryLiveTransfer(id);
            if (live) return live;

            const transfer = transfers.find((item) => item.id === id) ?? transfers[0];

            return {
                ...transfer,
                status: 'queued',
                progress: 5,
                failureReason: undefined,
                updatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
                auditLog: [
                    {
                        id: `audit-retry-${Date.now()}`,
                        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
                        actor: 'Current user',
                        action: 'Retried transfer',
                        detail: 'Item Transfer API consumption was queued again.',
                    },
                    ...transfer.auditLog,
                ],
            };
        },
    };
}
