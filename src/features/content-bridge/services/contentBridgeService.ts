import type { ClientSDK } from '@sitecore-marketplace-sdk/client';
import type { ApplicationContext } from '@sitecore-marketplace-sdk/client';
import type { ContentEnvironment, ContentTreeItem, MergeStrategy, TransferDraft, TransferRecord, TransferStatus } from '../types';

export interface ContentBridgeService {
    getEnvironments(): Promise<ContentEnvironment[]>;
    getContentTree(environmentId: string): Promise<ContentTreeItem[]>;
    getPageChildren(siteId: string, pageId: string, environmentId: string): Promise<ContentTreeItem[]>;
    getGraphNodeChildren(itemPath: string, environmentId: string): Promise<ContentTreeItem[]>;
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
const STORAGE_KEY = 'contentbridge_transfers';
const RETENTION_DAYS = 180;

function isExpired(record: TransferRecord): boolean {
    const created = new Date(record.createdAt).getTime();
    return Date.now() - created > RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function loadTransfers(): TransferRecord[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const records = JSON.parse(raw) as TransferRecord[];
        return records.filter((r) => !isExpired(r));
    } catch {
        return [];
    }
}

function saveTransfers(records: TransferRecord[]) {
    try {
        const active = records.filter((r) => !isExpired(r));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
    } catch {
        // storage full or unavailable
    }
}

let transferRecords: TransferRecord[] = loadTransfers();
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
            },
        );
    }
    return envs;
}

function pageToTreeItem(page: Record<string, unknown>, siteId?: string): ContentTreeItem {
    const id = (page.id ?? '') as string;
    const path = (page.path ?? '') as string;
    const name = (page.displayName || page.name || '') as string;
    if (id && path) itemIdToPath.set(id, path);

    const rawChildren = page.children;
    const children = Array.isArray(rawChildren) ? (rawChildren as Record<string, unknown>[]).map((c) => pageToTreeItem(c, siteId)) : [];

    return { id, name, path, template: '', updatedAt: '', dependencies: [], children, siteId };
}

function gqlNodeToTreeItem(node: Record<string, unknown>): ContentTreeItem {
    const id = (node.id ?? '') as string;
    const path = (node.path ?? '') as string;
    const name = (node.name ?? '') as string;
    if (id && path) itemIdToPath.set(id, path);

    const childContainer = node.children as Record<string, unknown> | undefined;
    const rawResults = childContainer?.results;
    const children = Array.isArray(rawResults) ? (rawResults as Record<string, unknown>[]).map(gqlNodeToTreeItem) : [];
    const total = (childContainer?.total as number) ?? 0;
    const hasMoreChildren = children.length < total;

    return { id, name, path, template: '', updatedAt: '', dependencies: [], children, hasMoreChildren };
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

const CONTENT_TREE_GQL = `query($language: String!) {
    item(path: "/sitecore/content", language: $language) {
        id name path
        template { name }
        children {
            total
            results {
                id name path
                template { name }
                children {
                    total
                    results {
                        id name path
                        template { name }
                        children {
                            total
                            results {
                                id name path
                                template { name }
                            }
                        }
                    }
                }
            }
        }
    }
}`;

const GQL_CHILDREN_QUERY = `query($path: String!, $language: String!) {
    item(path: $path, language: $language) {
        id name path
        template { name }
        children {
            total
            results {
                id name path
                template { name }
                children {
                    total
                    results {
                        id name path
                        template { name }
                    }
                }
            }
        }
    }
}`;

async function applyTransfer(rec: TransferRecord) {
    if (!sdkClient || !rec.chunkSetsMetadata?.length) return;

    if (!rec.sourceEnvironmentId || !rec.destinationEnvironmentId) {
        console.error(
            `[ContentBridge] applyTransfer ABORTED: missing environment IDs. source=${JSON.stringify(rec.sourceEnvironmentId)}, dest=${JSON.stringify(rec.destinationEnvironmentId)}, recordId=${rec.id}`,
        );
        rec.status = 'failed';
        rec.failureReason = `Missing environment IDs: source=${rec.sourceEnvironmentId || '(empty)'}, destination=${rec.destinationEnvironmentId || '(empty)'}`;
        rec.updatedAt = ts(new Date());
        applyingTransfers.delete(rec.id);
        return;
    }

    applyingTransfers.add(rec.id);

    const audit = (action: string, detail: string) => {
        rec.auditLog.push({ id: uid('audit'), timestamp: ts(new Date()), actor: 'System', action, detail });
    };

    try {
        const totalChunks = rec.chunkSetsMetadata.reduce((sum, cs) => sum + cs.ChunkCount, 0);
        let completedChunks = 0;
        audit('Apply started', `${rec.chunkSetsMetadata.length} chunk set(s), ${totalChunks} chunk(s)`);

        for (const chunkSet of rec.chunkSetsMetadata) {
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

                    if (d instanceof Blob) {
                        chunkData = d;
                    } else if (d instanceof Response) {
                        chunkData = await d.blob();
                    } else if (d instanceof ArrayBuffer) {
                        chunkData = new Blob([d], { type: 'application/octet-stream' });
                    } else if (d?.data instanceof Blob) {
                        chunkData = d.data;
                    } else if (d?.data instanceof ArrayBuffer) {
                        chunkData = new Blob([d.data], { type: 'application/octet-stream' });
                    } else if (d?.data instanceof Response) {
                        chunkData = await d.data.blob();
                    } else if (d?.body instanceof ArrayBuffer) {
                        chunkData = new Blob([d.body], { type: 'application/octet-stream' });
                    } else if (d?.body instanceof Blob) {
                        chunkData = d.body;
                    } else if (d?.body?.arrayBuffer) {
                        chunkData = await d.body.blob();
                    } else if (d?.buffer instanceof ArrayBuffer) {
                        chunkData = new Blob([d.buffer], { type: 'application/octet-stream' });
                    } else {
                        const shape = JSON.stringify(d, (key, value) => {
                            if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
                            if (value instanceof Blob) return `Blob(${value.size})`;
                            if (value instanceof Response) return `Response(${value.status})`;
                            return value;
                        });
                        audit('Chunk extraction failed', `Set ${chunkSet.ChunkSetId} chunk ${chunkIdx}: no known data shape. Raw: ${shape}`);
                        throw new Error('Failed to extract chunk binary data from getChunk response');
                    }

                    if (chunkData.size === 0) {
                        audit('Chunk data empty', `Set ${chunkSet.ChunkSetId} chunk ${chunkIdx}: 0 bytes. Keys: ${Object.keys(d || {}).join(',')}`);
                        throw new Error(`Extracted chunk data is empty (0 bytes). Raw response keys: ${Object.keys(d || {}).join(',')}`);
                    }

                    audit('Chunk extracted', `Set ${chunkSet.ChunkSetId} chunk ${chunkIdx}: ${chunkData.size} bytes, type=${chunkData.type}`);

                    await sdkClient.mutate('xmc.contentTransfer.saveChunk', {
                        params: {
                            body: chunkData,
                            path: { transferId: rec.id, chunksetId: chunkSet.ChunkSetId, chunkId: chunkIdx },
                            query: { sitecoreContextId: rec.destinationEnvironmentId },
                        },
                    });

                    audit('Chunk saved', `Set ${chunkSet.ChunkSetId} chunk ${chunkIdx}: ${chunkData.size} bytes pushed to destination`);

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
                if (completeData && typeof completeData === 'object' && 'ContentTransferFileName' in completeData) {
                    rec.contentTransferFileName = (completeData.ContentTransferFileName as string) || undefined;
                }
                audit('Chunk set completed', `Set ${chunkSet.ChunkSetId}: fileName=${rec.contentTransferFileName || '(none)'}`);
                rec.progress = 75;
                rec.updatedAt = ts(new Date());
            } catch (err) {
                audit('Chunk set completion failed', `Set ${chunkSet.ChunkSetId}: ${err instanceof Error ? err.message : String(err)}`);
                throw err;
            }
        }

        if (rec.contentTransferFileName) {
            rec.progress = 85;
            rec.updatedAt = ts(new Date());

            const normalizedFileName =
                rec.contentTransferFileName.startsWith('blob://') || rec.contentTransferFileName.startsWith('file://')
                    ? rec.contentTransferFileName
                    : `blob://${rec.contentTransferFileName}`;

            audit('ConsumeFile starting', `file=${normalizedFileName}, env=${rec.destinationEnvironmentId}`);

            let consumeRes: Awaited<ReturnType<typeof sdkClient.query>> | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
                consumeRes = await sdkClient.query('xmc.contentTransfer.consumeFile', {
                    params: {
                        query: {
                            databaseName: 'master',
                            fileName: normalizedFileName,
                            sitecoreContextId: rec.destinationEnvironmentId,
                        },
                    },
                });

                if (!consumeRes.error) break;

                const errMsg = consumeRes.error.message || JSON.stringify(consumeRes.error);
                if (attempt < 2) {
                    const delay = 2000 * Math.pow(2, attempt);
                    audit('ConsumeFile retry', `attempt ${attempt + 1} failed: ${errMsg}, retrying in ${delay}ms`);
                    await new Promise((r) => setTimeout(r, delay));
                } else {
                    audit('ConsumeFile failed', errMsg);
                    throw new Error(`consumeFile failed: ${errMsg}`);
                }
            }

            audit('ConsumeFile accepted', `file=${normalizedFileName}`);

            rec.progress = 90;
            rec.updatedAt = ts(new Date());

            for (let attempt = 0; attempt < 30; attempt++) {
                const delay = Math.min(3000 * Math.pow(1.5, attempt), 30000);
                await new Promise((r) => setTimeout(r, delay));
                try {
                    const blobRes = await sdkClient.query('xmc.contentTransfer.getBlobState', {
                        params: {
                            query: {
                                fileName: normalizedFileName,
                                sitecoreContextId: rec.destinationEnvironmentId,
                            },
                        },
                    });

                    if (blobRes.error) {
                        const errMsg = blobRes.error.message || JSON.stringify(blobRes.error);
                        if (attempt === 0 || attempt === 29 || errMsg.includes('BlobNotFound') || errMsg.includes('404')) {
                            audit('GetBlobState query error', `attempt ${attempt + 1}: ${errMsg}`);
                        }
                        continue;
                    }

                    const blobData = unwrap<Record<string, unknown>>(blobRes.data);
                    const blobStatus = (blobData?.BlobState ?? blobData?.status) as string | undefined;
                    const blobError = (blobData?.Error ?? blobData?.details) as string | undefined;

                    if (attempt === 0 || blobStatus === 'Error') {
                        audit('GetBlobState', `attempt ${attempt + 1}: BlobState=${blobStatus}${blobError ? ', Error=' + blobError : ''}`);
                    }

                    if (blobStatus === 'OK' || blobStatus === 'Completed') {
                        audit('Blob consumed', `Status: ${blobStatus}`);
                        rec.status = 'completed';
                        rec.progress = 100;
                        rec.updatedAt = ts(new Date());
                        applyingTransfers.delete(rec.id);
                        return;
                    }
                    if (blobStatus === 'NotFound') {
                        continue;
                    }
                    if (blobStatus === 'Error') {
                        const isBlobNotFound = /BlobNotFound|does not exist/i.test(blobError ?? '');

                        if (isBlobNotFound && attempt === 0) {
                            audit('GetBlobState early 404', 'Blob missing on first poll; consume job likely completed faster than our poll interval');
                            rec.status = 'completed';
                            rec.progress = 100;
                            rec.updatedAt = ts(new Date());
                            applyingTransfers.delete(rec.id);
                            return;
                        }

                        throw new Error(`Blob consumption failed: ${blobError || JSON.stringify(blobData)}`);
                    }
                } catch (err) {
                    if ((err as Error).message.startsWith('Blob consumption')) throw err;
                }
            }

            throw new Error('Blob consumption timed out after max polling attempts');
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
        saveTransfers(transferRecords);
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
                const gql = await sdkClient.mutate('xmc.preview.graphql', {
                    params: {
                        body: { query: CONTENT_TREE_GQL, variables: { language: 'en' } },
                        query: { sitecoreContextId: environmentId },
                    },
                });
                const gqlRaw = gql as unknown as Record<string, unknown>;
                const gqlData = gqlRaw?.data as Record<string, unknown> | undefined;
                let gqlPayload: Record<string, unknown> | undefined;

                if (gqlData && 'item' in gqlData) {
                    gqlPayload = gqlData;
                } else if (gqlData && gqlData.data && typeof gqlData.data === 'object' && 'item' in (gqlData.data as Record<string, unknown>)) {
                    gqlPayload = gqlData.data as Record<string, unknown>;
                }

                if (gqlData?.errors) {
                    console.warn('[ContentBridge] Authoring GraphQL errors:', gqlData.errors);
                }

                const root = gqlPayload?.item as Record<string, unknown> | undefined;
                if (root?.children) {
                    const rootChildren = root.children as Record<string, unknown>;
                    const results = rootChildren.results as Record<string, unknown>[];
                    const rootTotalCount = (rootChildren.total as number) ?? 0;
                    if (Array.isArray(results)) {
                        tree.push({
                            id: (root.id ?? 'content') as string,
                            name: (root.name ?? 'Content') as string,
                            path: (root.path ?? '/sitecore/content') as string,
                            template: '',
                            updatedAt: '',
                            dependencies: [],
                            hasMoreChildren: results.length < rootTotalCount,
                            children: results.map((node) => gqlNodeToTreeItem(node)),
                        });
                    }
                }
            } catch (err) {
                console.error('[ContentBridge] GraphQL content fetch failed:', err);
            }

            console.log('[ContentBridge] Final content tree:', tree);
            return tree;
        },

        async getPageChildren(siteId, pageId, environmentId) {
            if (!sdkClient) throw new Error('Marketplace SDK not initialized.');

            try {
                const res = await sdkClient.query('xmc.xmapp.listPageChildren', {
                    params: {
                        path: { siteId, pageId },
                        query: { sitecoreContextId: environmentId },
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
                console.log(`[ContentBridge] getPageChildren pageId=${pageId} → ${children.length} items`);

                return children.map((child) => {
                    const item = pageToTreeItem(child, siteId);
                    if (child.hasChildren) {
                        item.hasMoreChildren = true;
                    }
                    return item;
                });
            } catch (err) {
                console.warn(`[ContentBridge] getPageChildren failed for page ${pageId}:`, err);
                return [];
            }
        },

        async getGraphNodeChildren(itemPath, environmentId) {
            if (!sdkClient) throw new Error('Marketplace SDK not initialized.');

            try {
                const gql = await sdkClient.mutate('xmc.preview.graphql', {
                    params: {
                        body: {
                            query: GQL_CHILDREN_QUERY,
                            variables: { path: itemPath, language: 'en' },
                        },
                        query: { sitecoreContextId: environmentId },
                    },
                });
                const gqlRaw = gql as unknown as Record<string, unknown>;
                const gqlData = gqlRaw?.data as Record<string, unknown> | undefined;
                let gqlPayload: Record<string, unknown> | undefined;

                if (gqlData && 'item' in gqlData) {
                    gqlPayload = gqlData;
                } else if (gqlData && gqlData.data && typeof gqlData.data === 'object' && 'item' in (gqlData.data as Record<string, unknown>)) {
                    gqlPayload = gqlData.data as Record<string, unknown>;
                }

                const item = gqlPayload?.item as Record<string, unknown> | undefined;
                if (!item?.children) return [];

                const results = (item.children as Record<string, unknown>).results as Record<string, unknown>[];
                console.log(`[ContentBridge] getGraphNodeChildren path=${itemPath} → ${results?.length ?? 0} items`);

                if (!Array.isArray(results)) return [];

                return results.map((node) => gqlNodeToTreeItem(node));
            } catch (err) {
                console.warn(`[ContentBridge] getGraphNodeChildren failed for path ${itemPath}:`, err);
                return [];
            }
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
            saveTransfers(transferRecords);
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
                                const chunksMeta = statusData.ChunkSetsMetadata as
                                    | Array<{ ChunkSetId: string; ChunkCount: number; TotalItemCount: number }>
                                    | undefined;

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
            saveTransfers(transferRecords);
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
