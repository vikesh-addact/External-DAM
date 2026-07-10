import { contentTree, dependencyFindings, environments, transfers } from '../mockData';
import type { ContentEnvironment, ContentTreeItem, DependencyFinding, TransferDraft, TransferRecord } from '../types';

const sitecoreApiBaseUrl = process.env.NEXT_PUBLIC_SITECORE_CONTENT_TRANSFER_API_BASE_URL ?? '';
const sitecoreOAuthToken = process.env.NEXT_PUBLIC_SITECORE_OAUTH_TOKEN ?? '';

export interface ContentBridgeService {
    getEnvironments(): Promise<ContentEnvironment[]>;
    getContentTree(environmentId: string): Promise<ContentTreeItem[]>;
    validateDependencies(itemIds: string[]): Promise<DependencyFinding[]>;
    createContentTransfer(draft: TransferDraft): Promise<TransferRecord>;
    getTransfers(): Promise<TransferRecord[]>;
    retryTransfer(id: string): Promise<TransferRecord>;
}

const wait = (duration = 220) =>
    new Promise((resolve) => {
        window.setTimeout(resolve, duration);
    });

async function requestJson<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
        const response = await fetch(url, {
            ...init,
            headers: {
                Accept: 'application/json',
                Authorization: sitecoreOAuthToken ? `Bearer ${sitecoreOAuthToken}` : '',
                ...(init?.headers ?? {}),
            },
        });

        if (!response.ok) {
            return null;
        }

        return (await response.json()) as T;
    } catch {
        return null;
    }
}

async function getLiveEnvironments(): Promise<ContentEnvironment[] | null> {
    if (!sitecoreApiBaseUrl || !sitecoreOAuthToken) {
        return null;
    }

    const payload = await requestJson<ContentEnvironment[]>(`${sitecoreApiBaseUrl}/environments`);
    return Array.isArray(payload) ? payload : null;
}

async function getLiveContentTree(environmentId: string): Promise<ContentTreeItem[] | null> {
    if (!sitecoreApiBaseUrl || !sitecoreOAuthToken) {
        return null;
    }

    const payload = await requestJson<ContentTreeItem[]>(`${sitecoreApiBaseUrl}/content-tree?environmentId=${encodeURIComponent(environmentId)}`);
    return Array.isArray(payload) ? payload : null;
}

export function createContentBridgeService(): ContentBridgeService {
    return {
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

            return dependencyFindings.filter((finding) => itemIds.some((id) => finding.id.endsWith('1') || id.includes('products')));
        },
        async createContentTransfer(draft) {
            await wait(420);
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
            return transfers;
        },
        async retryTransfer(id) {
            await wait(360);
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
