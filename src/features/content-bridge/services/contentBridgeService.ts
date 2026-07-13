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
    const templateId = (page.templateId ?? '') as string;
    if (id && path) itemIdToPath.set(id, path);

    const rawChildren = page.children as Record<string, unknown>[] | null | undefined;
    const children = Array.isArray(rawChildren) ? rawChildren.map(pageToTreeItem) : [];

    return { id, name, path, template: templateId, updatedAt: '', dependencies: [], children };
}

function gqlNodeToTreeItem(node: Record<string, unknown>): ContentTreeItem {
    const id = (node.id ?? '') as string;
    const path = (node.path ?? '') as string;
    const name = (node.name ?? '') as string;
    const tmpl = (node.template as Record<string, unknown> | undefined)?.name as string ?? '';
    if (id && path) itemIdToPath.set(id, path);

    const rawChildren = (node.children as Record<string, unknown> | undefined)?.results as Record<string, unknown>[] | undefined;
    const children = Array.isArray(rawChildren) ? rawChildren.map(gqlNodeToTreeItem) : [];

    return { id, name, path, template: tmpl, updatedAt: '', dependencies: [], children };
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

            const sitesResult = await sdkClient.query('xmc.xmapp.listSites', {
                params: { query: { sitecoreContextId: environmentId } },
            });
            const sites = (sitesResult.data ?? []) as Array<Record<string, unknown>>;
            const tree: ContentTreeItem[] = [];

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
                    const data = hier.data as Record<string, unknown> | undefined;
                    if (data?.page) {
                        tree.push(pageToTreeItem(data.page as Record<string, unknown>));
                    }
                } catch (err) {
                    console.warn(`Hierarchy fetch failed for site ${siteId}:`, err);
                }
            }

            if (tree.length === 0) {
                try {
                    const gql = await sdkClient.mutate('xmc.authoring.graphql', {
                        params: {
                            body: { query: CONTENT_TREE_GQL },
                            query: { sitecoreContextId: environmentId },
                        },
                    });
                    const data = (gql as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
                    const root = data?.item as Record<string, unknown> | undefined;
                    if (root?.children) {
                        const results = (root.children as Record<string, unknown>).results as Record<string, unknown>[];
                        tree.push(...results.map(gqlNodeToTreeItem));
                    }
                    const ml = data?.mediaLibrary as Record<string, unknown> | undefined;
                    if (ml?.children) {
                        const results = (ml.children as Record<string, unknown>).results as Record<string, unknown>[];
                        const mlTree: ContentTreeItem = {
                            id: (ml.id ?? 'media-library') as string,
                            name: (ml.name ?? 'Media Library') as string,
                            path: (ml.path ?? '/sitecore/media library') as string,
                            template: 'Media Folder',
                            updatedAt: '',
                            dependencies: [],
                            children: results.map(gqlNodeToTreeItem),
                        };
                        tree.push(mlTree);
                    }
                } catch (err) {
                    console.warn('GraphQL content tree fallback failed:', err);
                }
            }

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
                const items = ((result as Record<string, unknown>)?.data as Record<string, unknown>)?.items as Array<Record<string, unknown>> | undefined;
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
                console.warn('Dependency validation via GraphQL failed:', err);
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
                            const data = res.data as Record<string, unknown> | undefined;
                            if (data?.State) {
                                rec.status = mapState(data.State as string);
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

            return createContentBridgeService().createContentTransfer({
                name: existing.name,
                sourceEnvironmentId: existing.sourceEnvironmentId,
                destinationEnvironmentId: existing.destinationEnvironmentId,
                selectedItemIds: existing.selectedItemIds,
                strategy: existing.strategy,
            });
        },
    };
}
