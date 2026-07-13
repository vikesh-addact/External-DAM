import type { ClientSDK } from '@sitecore-marketplace-sdk/client';
import type { ApplicationContext } from '@sitecore-marketplace-sdk/client';
import type { ContentEnvironment, ContentTreeItem, DependencyFinding, MergeStrategy, TransferDraft, TransferRecord, TransferStatus } from '../types';

export interface ContentBridgeService {
    getEnvironments(): Promise<ContentEnvironment[]>;
    getContentTree(environmentId: string): Promise<ContentTreeItem[]>;
    validateDependencies(itemIds: string[]): Promise<DependencyFinding[]>;
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

const STRATEGY_MAP: Record<MergeStrategy, string> = {
    overwrite: 'OverrideExistingItem',
    merge: 'LatestWin',
    skipExisting: 'KeepExistingItem',
};

function uid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

        async validateDependencies(itemIds) {
            if (itemIds.length === 0 || !sdkClient) return [];

            const findings: DependencyFinding[] = [];
            try {
                const result = await sdkClient.mutate('xmc.authoring.graphql', {
                    params: {
                        body: {
                            query: `query ($ids: [String!]!) {
                                items(ids: $ids) {
                                    id name path
                                    hasChildren
                                }
                            }`,
                            variables: { ids: itemIds },
                        },
                    },
                });
                const payload = unwrap<Record<string, unknown>>(result);
                const items = payload?.items as Array<Record<string, unknown>> | undefined;
                if (!Array.isArray(items)) return [];

                const selectedSet = new Set(itemIds);
                for (const item of items) {
                    const id = item.id as string;
                    const name = item.name as string;
                    if ((item.hasChildren as boolean) && !selectedSet.has(id)) {
                        findings.push({
                            id: uid('dep'),
                            itemName: name,
                            dependency: 'Child items',
                            severity: 'warning',
                            message: `"${name}" has children that are not included in the selection.`,
                        });
                    }
                }
            } catch (err) {
                console.warn('[ContentBridge] Dependency validation via GraphQL failed:', err);
            }

            return findings;
        },

        async createContentTransfer(draft) {
            if (!sdkClient) throw new Error('Marketplace SDK not initialized.');

            const transferId = uid('tr');
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

            try {
                await sdkClient.mutate('xmc.contentTransfer.createContentTransfer', {
                    params: {
                        body: {
                            transferId,
                            configuration: { dataTrees },
                        },
                        query: { sitecoreContextId: draft.sourceEnvironmentId },
                    },
                });
            } catch (err) {
                throw new Error(`Content Transfer creation failed: ${err instanceof Error ? err.message : String(err)}`);
            }

            const record: TransferRecord = {
                id: transferId,
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
                    if (['creating', 'queued', 'transferring'].includes(rec.status)) {
                        try {
                            const res = await sdkClient.query('xmc.contentTransfer.getContentTransferStatus', {
                                params: {
                                    path: { transferId: rec.id },
                                    query: { sitecoreContextId: rec.sourceEnvironmentId },
                                },
                            });
                            const statusData = unwrap<Record<string, unknown>>(res.data);
                            if (statusData?.State) {
                                rec.status = mapState(statusData.State as string);
                                rec.progress = progressFor(rec.status);
                                rec.updatedAt = ts(new Date());
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
