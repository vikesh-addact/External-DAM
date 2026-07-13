import type { ClientSDK } from '@sitecore-marketplace-sdk/client';
import type { ApplicationContext } from '@sitecore-marketplace-sdk/client';
import type { ContentEnvironment, ContentTreeItem, DependencyFinding, MergeStrategy, TransferDraft, TransferRecord, TransferStatus } from '../types';

export interface ContentBridgeService {
    getEnvironments(): Promise<ContentEnvironment[]>;
    getContentTree(environmentId: string): Promise<ContentTreeItem[]>;
    validateDependencies(itemIds: string[], tree: ContentTreeItem[]): Promise<DependencyFinding[]>;
    createContentTransfer(draft: TransferDraft): Promise<TransferRecord>;
    getTransfers(): Promise<TransferRecord[]>;
    retryTransfer(id: string): Promise<TransferRecord>;
    isLiveMode(): boolean;
    getApiStatus(): { contentTransfer: boolean; itemTransfer: boolean; authenticated: boolean };
    setClient(client: ClientSDK): void;
    setApplicationContext(ctx: ApplicationContext | unknown): void;
}

let sdkClient: ClientSDK | null = null;
let appContextData: ApplicationContext | null = null;
let transferRecords: TransferRecord[] = [];
const itemIdToPath = new Map<string, string>();
const applyingTransfers = new Set<string>();

const STRATEGY_MAP: Record<MergeStrategy, string> = {
    overwrite: 'OverrideExistingItem',
    merge: 'LatestWin',
    skipExisting: 'KeepExistingItem',
};

function uid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function ts(date: Date): string {
    return date.toISOString().slice(0, 16).replace('T', ' ');
}

function unwrap<T>(raw: unknown): T | undefined {
    if (raw == null) return undefined;
    if (typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj)) return obj as unknown as T;
    if ('data' in obj && obj.data != null && typeof obj.data === 'object') {
        if (Array.isArray(obj.data)) return obj.data as unknown as T;
        return obj.data as T;
    }
    return undefined;
}

function unwrapArray<T>(raw: unknown): T[] {
    return unwrap<T[]>(raw) ?? [];
}

function getResources(): unknown[] {
    if (!appContextData) return [];
    const data = appContextData as Record<string, unknown>;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.resourceAccess)) return data.resourceAccess as unknown[];
    return [];
}

function environmentsFromResources(resources: unknown[]): ContentEnvironment[] {
    const envs: ContentEnvironment[] = [];
    for (const r of resources) {
        const res = r as Record<string, unknown>;
        const ctx = res.context as Record<string, string> | undefined;
        if (!ctx?.preview || !ctx?.live) continue;
        const label = (res.tenantDisplayName || res.tenantName || 'Sitecore') as string;
        envs.push(
            {
                id: ctx.preview,
                name: `${label} — Preview`,
                project: label,
                region: 'Global',
                type: 'Development',
                status: 'Connected',
            },
            {
                id: ctx.live,
                name: `${label} — Live`,
                project: label,
                region: 'Global',
                type: 'Production',
                status: 'Connected',
            }
        );
    }
    return envs;
}

function pageToTreeItem(page: Record<string, unknown>): ContentTreeItem {
    const id = (page.id ?? '') as string;
    const path = (page.path ?? '') as string;
    const name = (page.displayName || page.name || '') as string;
    if (id && path) itemIdToPath.set(id, path);

    const rawChildren = page.children;
    const children = Array.isArray(rawChildren)
        ? (rawChildren as Record<string, unknown>[]).map(pageToTreeItem)
        : [];

    return { id, name, path, template: '', updatedAt: '', dependencies: [], children };
}

async function fetchChildrenRecursive(
    sdk: ClientSDK,
    siteId: string,
    pageId: string,
    contextId: string,
    depth = 0,
): Promise<ContentTreeItem[]> {
    if (depth >= 4 || !pageId) return [];
    try {
        const res = await sdk.query('xmc.xmapp.listPageChildren', {
            params: {
                path: { siteId, pageId },
                query: { sitecoreContextId: contextId },
            },
        });
        const raw = unwrap<unknown>(res.data);
        let children: Record<string, unknown>[] = [];
        if (Array.isArray(raw)) {
            children = raw as Record<string, unknown>[];
        } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const obj = raw as Record<string, unknown>;
            if (Array.isArray(obj.children)) children = obj.children as Record<string, unknown>[];
        }
        console.log(`[ContentBridge] listPageChildren pageId=${pageId} depth=${depth} → ${children.length} items`);
        if (children.length === 0) return [];

        return Promise.all(
            children.map(async (child) => {
                const item = pageToTreeItem(child);
                if (child.hasChildren) {
                    item.children = await fetchChildrenRecursive(sdk, siteId, child.id as string, contextId, depth + 1);
                }
                return item;
            }),
        );
    } catch (err) {
        console.warn(`[ContentBridge] listPageChildren failed for page ${pageId}:`, err);
        return [];
    }
}

function gqlNodeToTreeItem(node: Record<string, unknown>): ContentTreeItem {
    const id = (node.id ?? '') as string;
    const path = (node.path ?? '') as string;
    const name = (node.name ?? '') as string;
    if (id && path) itemIdToPath.set(id, path);

    const childContainer = node.children as Record<string, unknown> | undefined;
    const rawResults = childContainer?.results;
    const children = Array.isArray(rawResults)
        ? (rawResults as Record<string, unknown>[]).map(gqlNodeToTreeItem)
        : [];

    return { id, name, path, template: '', updatedAt: '', dependencies: [], children };
}

function mapState(s: string): TransferStatus {
    const lower = (s ?? '').toLowerCase();
    if (lower === 'completed') return 'completed';
    if (lower === 'failed' || lower === 'error') return 'failed';
    if (lower === 'transferring' || lower === 'inprogress' || lower === 'in_progress') return 'transferring';
    if (lower === 'queued' || lower === 'pending') return 'queued';
    return 'creating';
}

function progressFor(status: TransferStatus): number {
    if (status === 'completed') return 100;
    if (status === 'failed') return 0;
    if (status === 'transferring') return 50;
    if (status === 'queued') return 10;
    return 5;
}

const CONTENT_TREE_GQL = `query {
    item(path: "/sitecore/content") {
        id name path
        template { name }
        children {
            results {
                id name path
                template { name }
                hasChildren
                children {
                    results {
                        id name path
                        template { name }
                        hasChildren
                        children {
                            results {
                                id name path
                                template { name }
                                hasChildren
                                children {
                                    results {
                                        id name path
                                        template { name }
                                        hasChildren
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    mediaLibrary: item(path: "/sitecore/media library") {
        id name path
        template { name }
        children {
            results {
                id name path
                template { name }
                hasChildren
                children {
                    results {
                        id name path
                        template { name }
                        hasChildren
                    }
                }
            }
        }
    }
}`;

async function applyTransfer(rec: TransferRecord) {
    if (!sdkClient || !rec.chunkSetsMetadata?.length) return;

    if (!rec.sourceEnvironmentId || !rec.destinationEnvironmentId) {
        console.error(`[ContentBridge] applyTransfer ABORTED: missing environment IDs. source=${JSON.stringify(rec.sourceEnvironmentId)}, dest=${JSON.stringify(rec.destinationEnvironmentId)}, recordId=${rec.id}`);
        rec.status = 'failed';
        rec.failureReason = `Missing environment IDs: source=${rec.sourceEnvironmentId || '(empty)'}, destination=${rec.destinationEnvironmentId || '(empty)'}`;
        rec.updatedAt = ts(new Date());
        applyingTransfers.delete(rec.id);
        return;
    }

    applyingTransfers.add(rec.id);

    try {
        const totalChunks = rec.chunkSetsMetadata.reduce((sum, cs) => sum + cs.ChunkCount, 0);
        let completedChunks = 0;
        console.log(`[ContentBridge] Starting apply for transfer ${rec.id}: ${rec.chunkSetsMetadata.length} chunk set(s), ${totalChunks} chunk(s)`);

        for (const chunkSet of rec.chunkSetsMetadata) {
            console.log(`[ContentBridge] Processing chunk set ${chunkSet.ChunkSetId}: ${chunkSet.ChunkCount} chunk(s)`);
            for (let chunkIdx = 0; chunkIdx < chunkSet.ChunkCount; chunkIdx++) {
                try {
                    const chunkRes = await sdkClient.query('xmc.contentTransfer.getChunk', {
                        params: {
                            path: { transferId: rec.id, chunksetId: chunkSet.ChunkSetId, chunkId: chunkIdx },
                            query: { sitecoreContextId: rec.sourceEnvironmentId },
                        },
                    });

                    let chunkData: Blob;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const d = chunkRes.data as any;
                    console.log(`[ContentBridge] getChunk: data type=${typeof d}, constructor=${d?.constructor?.name}, isBlob=${d instanceof Blob}, isResponse=${d instanceof Response}`);

                    if (d instanceof Response) {
                        chunkData = await d.blob();
                        console.log(`[ContentBridge] Extracted from Response: size=${chunkData.size}`);
                    } else if (d instanceof Blob) {
                        chunkData = d;
                        console.log(`[ContentBridge] Direct Blob: size=${chunkData.size}`);
                    } else if (d && typeof d === 'object' && 'data' in d && d.data instanceof Blob) {
                        chunkData = d.data;
                        console.log(`[ContentBridge] Nested Blob: size=${chunkData.size}`);
                    } else {
                        const buf = d instanceof ArrayBuffer ? d : (d?.data instanceof ArrayBuffer ? d.data : null);
                        if (buf) {
                            chunkData = new Blob([buf], { type: 'application/octet-stream' });
                            console.log(`[ContentBridge] From ArrayBuffer: size=${chunkData.size}`);
                        } else {
                            console.error(`[ContentBridge] Could not extract binary data from:`, d);
                            throw new Error('Failed to extract chunk binary data from getChunk response');
                        }
                    }

                    console.log(`[ContentBridge] saveChunk body: size=${chunkData.size}, type=${chunkData.type}`);

                    await sdkClient.mutate('xmc.contentTransfer.saveChunk', {
                        params: {
                            body: chunkData,
                            path: { transferId: rec.id, chunksetId: chunkSet.ChunkSetId, chunkId: chunkIdx },
                            query: { sitecoreContextId: rec.destinationEnvironmentId },
                        },
                    });
                    console.log(`[ContentBridge] saveChunk OK for chunk ${chunkIdx}`);

                    completedChunks++;
                    rec.progress = 20 + Math.round((completedChunks / totalChunks) * 50);
                    rec.updatedAt = ts(new Date());
                } catch (err) {
                    console.error(`[ContentBridge] Failed to transfer chunk ${chunkIdx} of set ${chunkSet.ChunkSetId}:`, err);
                    throw err;
                }
            }

            try {
                const completeRes = await sdkClient.mutate('xmc.contentTransfer.completeChunkSetTransfer', {
                    params: {
                        path: { transferId: rec.id, chunksetId: chunkSet.ChunkSetId },
                        query: { sitecoreContextId: rec.destinationEnvironmentId },
                    },
                });
                const completeData = unwrap<Record<string, unknown>>(completeRes);
                console.log(`[ContentBridge] completeChunkSetTransfer result:`, completeData);
                if (completeData && typeof completeData === 'object' && 'ContentTransferFileName' in completeData) {
                    rec.contentTransferFileName = (completeData.ContentTransferFileName as string) || undefined;
                    console.log(`[ContentBridge] ContentTransferFileName: ${rec.contentTransferFileName}`);
                }
                rec.progress = 75;
                rec.updatedAt = ts(new Date());
            } catch (err) {
                console.error(`[ContentBridge] Failed to complete chunk set ${chunkSet.ChunkSetId}:`, err);
                throw err;
            }
        }

        if (rec.contentTransferFileName) {
            rec.progress = 85;
            rec.updatedAt = ts(new Date());

            const consumeRes = await sdkClient.query('xmc.contentTransfer.consumeFile', {
                params: {
                    query: {
                        databaseName: 'master',
                        fileName: `blob://${rec.contentTransferFileName}`,
                        sitecoreContextId: rec.destinationEnvironmentId,
                    },
                },
            });

            if (consumeRes.error) {
                throw new Error(`consumeFile failed: ${consumeRes.error.message || JSON.stringify(consumeRes.error)}`);
            }

            console.log(`[ContentBridge] consumeFile initiated for ${rec.contentTransferFileName} on ${rec.destinationEnvironmentId}`);

            rec.progress = 90;
            rec.updatedAt = ts(new Date());

            for (let attempt = 0; attempt < 30; attempt++) {
                await new Promise((r) => setTimeout(r, 3000));
                try {
                    const blobRes = await sdkClient.query('xmc.contentTransfer.getBlobState', {
                        params: {
                            query: {
                        fileName: `blob://${rec.contentTransferFileName}`,
                                sitecoreContextId: rec.destinationEnvironmentId,
                            },
                        },
                    });

                    if (blobRes.error) {
                        console.warn(`[ContentBridge] getBlobState query error (attempt ${attempt + 1}):`, blobRes.error.message || blobRes.error);
                        continue;
                    }

                    const blobData = unwrap<Record<string, unknown>>(blobRes.data);
                    const blobStatus = blobData?.status as string | undefined;
                    console.log(`[ContentBridge] getBlobState attempt ${attempt + 1}: status=${blobStatus}`);

                    if (blobStatus === 'OK' || blobStatus === 'Completed') {
                        rec.status = 'completed';
                        rec.progress = 100;
                        rec.updatedAt = ts(new Date());
                        applyingTransfers.delete(rec.id);
                        return;
                    }
                    if (blobStatus === 'Error') {
                        throw new Error(`Blob consumption failed: ${JSON.stringify(blobData?.details ?? '')}`);
                    }
                } catch (err) {
                    if ((err as Error).message.startsWith('Blob consumption')) throw err;
                }
            }

            throw new Error('Blob consumption timed out after 90 seconds');
        }

        rec.status = 'completed';
        rec.progress = 100;
        rec.updatedAt = ts(new Date());
    } catch (err) {
        rec.status = 'failed';
        rec.failureReason = err instanceof Error ? err.message : String(err);
        rec.updatedAt = ts(new Date());
        rec.auditLog.push({
            id: uid('audit'),
            timestamp: ts(new Date()),
            actor: 'System',
            action: 'Transfer apply failed',
            detail: rec.failureReason,
        });
    } finally {
        applyingTransfers.delete(rec.id);
    }
}

export function createContentBridgeService(): ContentBridgeService {
    return {
        setClient(client) {
            sdkClient = client;
        },

        setApplicationContext(ctx) {
            appContextData = ctx as ApplicationContext;
        },

        isLiveMode() {
            return sdkClient !== null;
        },

        getApiStatus() {
            return {
                contentTransfer: true,
                itemTransfer: true,
                authenticated: sdkClient !== null,
            };
        },

        async getEnvironments() {
            const resources = getResources();
            const envs = environmentsFromResources(resources);
            if (envs.length === 0) {
                throw new Error('No Sitecore environments found. Ensure the Marketplace SDK is connected.');
            }
            return envs;
        },

        async getContentTree(environmentId) {
            if (!sdkClient) throw new Error('Marketplace SDK not initialized.');

            const tree: ContentTreeItem[] = [];

            try {
                const sitesResult = await sdkClient.query('xmc.xmapp.listSites', {
                    params: { query: { sitecoreContextId: environmentId } },
                });
                const sites = unwrapArray<Record<string, unknown>>(sitesResult.data);
                console.log('[ContentBridge] listSites:', sites.length, 'sites');

                for (const site of sites) {
                    const siteId = site.id as string;
                    if (!siteId) continue;
                    try {
                        const hier = await sdkClient.query('xmc.xmapp.retrieveSiteHierarchy', {
                            params: {
                                path: { siteId },
                                query: { sitecoreContextId: environmentId },
                            },
                        });
                        const hierData = unwrap<Record<string, unknown>>(hier.data);
                        console.log('[ContentBridge] retrieveSiteHierarchy:', hierData);

                        const rootPage = hierData?.page as Record<string, unknown> | undefined;
                        const hierChildren = hierData?.children;

                        if (rootPage) {
                            const rootItem = pageToTreeItem(rootPage);

                            if (Array.isArray(hierChildren) && hierChildren.length > 0) {
                                rootItem.children = await Promise.all(
                                    (hierChildren as Record<string, unknown>[]).map(async (child) => {
                                        const childItem = pageToTreeItem(child);
                                        if (child.hasChildren) {
                                            childItem.children = await fetchChildrenRecursive(sdkClient!, siteId, child.id as string, environmentId);
                                        }
                                        return childItem;
                                    }),
                                );
                            }

                            tree.push(rootItem);
                        }
                    } catch (err) {
                        console.warn(`[ContentBridge] Hierarchy fetch failed for site ${siteId}:`, err);
                    }
                }
            } catch (err) {
                console.warn('[ContentBridge] listSites failed, trying GraphQL fallback:', err);
            }

            if (tree.length === 0) {
                try {
                    const gql = await sdkClient.mutate('xmc.authoring.graphql', {
                        params: {
                            body: { query: CONTENT_TREE_GQL },
                            query: { sitecoreContextId: environmentId },
                        },
                    });
                    const gqlPayload = unwrap<Record<string, unknown>>(gql);
                    const root = gqlPayload?.item as Record<string, unknown> | undefined;
                    if (root?.children) {
                        const results = (root.children as Record<string, unknown>).results as Record<string, unknown>[];
                        if (Array.isArray(results)) {
                            tree.push(...results.map(gqlNodeToTreeItem));
                        }
                    }
                    const ml = gqlPayload?.mediaLibrary as Record<string, unknown> | undefined;
                    if (ml?.children) {
                        const results = (ml.children as Record<string, unknown>).results as Record<string, unknown>[];
                        if (Array.isArray(results)) {
                            tree.push({
                                id: (ml.id ?? 'media-library') as string,
                                name: (ml.name ?? 'Media Library') as string,
                                path: (ml.path ?? '/sitecore/media library') as string,
                                template: '',
                                updatedAt: '',
                                dependencies: [],
                                children: results.map(gqlNodeToTreeItem),
                            });
                        }
                    }
                } catch (err) {
                    console.error('[ContentBridge] GraphQL content tree fallback failed:', err);
                }
            }

            console.log('[ContentBridge] Final content tree:', tree);
            return tree;
        },

        async validateDependencies(itemIds, tree) {
            if (itemIds.length === 0) return [];

            const findings: DependencyFinding[] = [];
            const selectedSet = new Set(itemIds);

            function walk(items: ContentTreeItem[]) {
                for (const item of items) {
                    if (item.children?.length) {
                        const hasUnselectedChildren = item.children.some((child) => !selectedSet.has(child.id));
                        if (selectedSet.has(item.id) && hasUnselectedChildren) {
                            findings.push({
                                id: uid('dep'),
                                itemName: item.name,
                                dependency: 'Child items',
                                severity: 'warning',
                                message: `"${item.name}" has children that are not included in the selection.`,
                            });
                        }
                        walk(item.children);
                    }
                }
            }

            walk(tree);
            return findings;
        },

        async createContentTransfer(draft) {
            if (!sdkClient) throw new Error('Marketplace SDK not initialized.');

            const transferId = uuid();
            const now = ts(new Date());

            const dataTrees = draft.selectedItemIds.map((id) => {
                const itemPath = itemIdToPath.get(id) ?? id;
                return {
                    itemPath,
                    scope: 'ItemAndDescendants' as const,
                    mergeStrategy: (STRATEGY_MAP[draft.strategy] ?? 'OverrideExistingItem') as
                        | 'OverrideExistingItem'
                        | 'KeepExistingItem'
                        | 'LatestWin'
                        | 'OverrideExistingTree',
                };
            });

            let serverTransferId = transferId;
            try {
                const res = await sdkClient.mutate('xmc.contentTransfer.createContentTransfer', {
                    params: {
                        body: {
                            transferId,
                            configuration: { dataTrees },
                        },
                        query: { sitecoreContextId: draft.sourceEnvironmentId },
                    },
                });
                const resData = unwrap<Record<string, unknown>>(res);
                if (resData && typeof resData === 'object' && 'transferId' in resData) {
                    serverTransferId = (resData.transferId as string) || transferId;
                }
            } catch (err) {
                throw new Error(`Content Transfer creation failed: ${err instanceof Error ? err.message : String(err)}`);
            }

            const record: TransferRecord = {
                id: serverTransferId,
                name: draft.name,
                sourceEnvironmentId: draft.sourceEnvironmentId,
                destinationEnvironmentId: draft.destinationEnvironmentId,
                selectedItemIds: draft.selectedItemIds,
                strategy: draft.strategy,
                status: 'creating',
                progress: 5,
                createdBy: 'Current user',
                createdAt: now,
                updatedAt: now,
                auditLog: [
                    {
                        id: uid('audit'),
                        timestamp: now,
                        actor: 'Current user',
                        action: 'Created transfer request',
                        detail: `Content Transfer ${transferId} created via Marketplace SDK.`,
                    },
                ],
            };

            transferRecords = [record, ...transferRecords];
            return record;
        },

        async getTransfers() {
            if (sdkClient) {
                for (const rec of transferRecords) {
                    if (rec.status === 'creating' || rec.status === 'queued') {
                        try {
                            const res = await sdkClient.query('xmc.contentTransfer.getContentTransferStatus', {
                                params: {
                                    path: { transferId: rec.id },
                                    query: { sitecoreContextId: rec.sourceEnvironmentId },
                                },
                            });
                            const statusData = unwrap<Record<string, unknown>>(res.data);
                            if (statusData?.State) {
                                const state = (statusData.State as string).toLowerCase();
                                const chunksMeta = statusData.ChunkSetsMetadata as Array<{ ChunkSetId: string; ChunkCount: number; TotalItemCount: number }> | undefined;

                                if (state === 'completed' && chunksMeta?.length) {
                                    rec.chunkSetsMetadata = chunksMeta;
                                    rec.status = 'transferring';
                                    rec.progress = 20;
                                    rec.updatedAt = ts(new Date());

                                    if (!applyingTransfers.has(rec.id)) {
                                        applyTransfer(rec);
                                    }
                                } else {
                                    rec.status = mapState(state);
                                    rec.progress = progressFor(rec.status);
                                    rec.updatedAt = ts(new Date());
                                }
                            }
                        } catch {
                            // transfer may not be ready yet
                        }
                    }
                }
            }
            return [...transferRecords];
        },

        async retryTransfer(id) {
            const existing = transferRecords.find((r) => r.id === id);
            if (!existing) throw new Error(`Transfer ${id} not found.`);

            if (sdkClient) {
                try {
                    await sdkClient.mutate('xmc.contentTransfer.deleteContentTransfer', {
                        params: {
                            path: { transferId: id },
                            query: { sitecoreContextId: existing.sourceEnvironmentId },
                        },
                    });
                } catch {
                    // best-effort cleanup
                }
            }

            const service = createContentBridgeService();
            if (sdkClient) service.setClient(sdkClient);
            if (appContextData) service.setApplicationContext(appContextData);
            return service.createContentTransfer({
                name: existing.name,
                sourceEnvironmentId: existing.sourceEnvironmentId,
                destinationEnvironmentId: existing.destinationEnvironmentId,
                selectedItemIds: existing.selectedItemIds,
                strategy: existing.strategy,
            });
        },
    };
}
