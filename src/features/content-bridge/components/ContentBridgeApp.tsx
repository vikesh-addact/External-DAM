'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ApplicationContext } from '@sitecore-marketplace-sdk/client';
import { useMarketplaceClient } from '@/src/utils/hooks/useMarketplaceClient';
import {
    Activity,
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    ChevronRight,
    Clock3,
    Database,
    FileClock,
    FolderTree,
    History,
    KeyRound,
    Layers3,
    ListChecks,
    Loader2,
    RefreshCw,
    Settings,
    ShieldCheck,
    Split,
} from 'lucide-react';
import { createContentBridgeService } from '../services/contentBridgeService';
import type { ContentEnvironment, ContentTreeItem, DependencyFinding, MergeStrategy, TransferRecord, TransferStatus } from '../types';
import styles from './ContentBridgeApp.module.css';

type PageKey = 'dashboard' | 'wizard' | 'monitor' | 'history' | 'details' | 'settings';

const navigation = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'wizard', label: 'New Transfer', icon: Split },
    { id: 'monitor', label: 'Monitor', icon: Clock3 },
    { id: 'history', label: 'History', icon: History },
    { id: 'details', label: 'Details', icon: ListChecks },
    { id: 'settings', label: 'Settings', icon: Settings },
] satisfies Array<{ id: PageKey; label: string; icon: typeof Activity }>;

const strategyLabels: Record<MergeStrategy, string> = {
    overwrite: 'Overwrite existing items',
    merge: 'Merge fields and children',
    skipExisting: 'Skip existing items',
};

const statusLabels: Record<TransferStatus, string> = {
    draft: 'Draft',
    validating: 'Validating',
    ready: 'Ready',
    creating: 'Creating',
    queued: 'Queued',
    transferring: 'Transferring',
    completed: 'Completed',
    failed: 'Failed',
};

function collectItemIds(item: ContentTreeItem): string[] {
    return [item.id, ...(item.children ?? []).flatMap(collectItemIds)];
}

function findItem(items: ContentTreeItem[], id: string): ContentTreeItem | undefined {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }

        const child = findItem(item.children ?? [], id);
        if (child) {
            return child;
        }
    }

    return undefined;
}

function flattenTree(items: ContentTreeItem[]): ContentTreeItem[] {
    return items.flatMap((item) => [item, ...flattenTree(item.children ?? [])]);
}

function formatEnvironmentName(environments: ContentEnvironment[], id: string) {
    return environments.find((environment) => environment.id === id)?.name ?? id;
}

export function ContentBridgeApp() {
    const { client, error, isInitialized, isLoading } = useMarketplaceClient();
    const [appContext, setAppContext] = useState<ApplicationContext>();
    const service = useMemo(() => createContentBridgeService(), []);
    const [page, setPage] = useState<PageKey>('dashboard');
    const [environments, setEnvironments] = useState<ContentEnvironment[]>([]);
    const [tree, setTree] = useState<ContentTreeItem[]>([]);
    const [transfers, setTransfers] = useState<TransferRecord[]>([]);
    const [selectedTransferId, setSelectedTransferId] = useState('');
    const [sourceId, setSourceId] = useState('');
    const [destinationId, setDestinationId] = useState('');
    const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
    const [strategy, setStrategy] = useState<MergeStrategy>('merge');
    const [transferName, setTransferName] = useState('');
    const [dependencyResults, setDependencyResults] = useState<DependencyFinding[]>([]);
    const [isValidating, setIsValidating] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [isLoadingData, setIsLoadingData] = useState(true);
    const [apiError, setApiError] = useState<string | null>(null);
    const [sdkConnected, setSdkConnected] = useState(false);

    const apiStatus = service.getApiStatus();

    useEffect(() => {
        if (!error && isInitialized && client) {
            service.setClient(client);
            client
                .query('application.context')
                .then((res) => {
                    service.setApplicationContext(res.data);
                    setAppContext(res.data);
                    setSdkConnected(true);
                })
                .catch((contextError) => console.error('Error retrieving application.context:', contextError));
        } else if (error) {
            console.error('Error initializing Marketplace client:', error);
        }
    }, [client, error, isInitialized, service]);

    useEffect(() => {
        if (!sdkConnected) return;

        let cancelled = false;

        const loadData = async () => {
            try {
                const [envs, transfersResult] = await Promise.all([
                    service.getEnvironments(),
                    service.getTransfers(),
                ]);

                if (!cancelled) {
                    setEnvironments(envs);
                    setTransfers(transfersResult);

                    const effectiveSource = sourceId || envs[0]?.id || '';
                    if (!sourceId && effectiveSource) {
                        setSourceId(effectiveSource);
                    }

                    if (effectiveSource) {
                        const contentTreeResult = await service.getContentTree(effectiveSource);
                        if (!cancelled) setTree(contentTreeResult);
                    }

                    if (!cancelled) setIsLoadingData(false);
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('Error loading data:', err);
                    setApiError(err instanceof Error ? err.message : 'Failed to load data from Sitecore API');
                    setIsLoadingData(false);
                }
            }
        };

        loadData();

        return () => {
            cancelled = true;
        };
    }, [service, sdkConnected, sourceId]);

    const selectedTransfer = transfers.find((transfer) => transfer.id === selectedTransferId) ?? transfers[0];
    const allItems = useMemo(() => flattenTree(tree), [tree]);
    const selectedItems = selectedItemIds.map((id) => findItem(tree, id)).filter(Boolean) as ContentTreeItem[];
    const activeTransfers = transfers.filter((transfer) => ['queued', 'transferring', 'creating'].includes(transfer.status));
    const failedTransfers = transfers.filter((transfer) => transfer.status === 'failed');

    const toggleItem = (item: ContentTreeItem, includeSubtree = false) => {
        const ids = includeSubtree ? collectItemIds(item) : [item.id];
        setSelectedItemIds((current) => {
            const allSelected = ids.every((id) => current.includes(id));
            if (allSelected) {
                return current.filter((id) => !ids.includes(id));
            }

            return Array.from(new Set([...current, ...ids]));
        });
    };

    const validateSelection = async () => {
        setIsValidating(true);
        const results = await service.validateDependencies(selectedItemIds);
        setDependencyResults(results);
        setIsValidating(false);
    };

    const createTransfer = async () => {
        setIsCreating(true);
        setApiError(null);
        try {
            const created = await service.createContentTransfer({
                name: transferName,
                sourceEnvironmentId: sourceId,
                destinationEnvironmentId: destinationId,
                selectedItemIds,
                strategy,
            });
            setTransfers((current) => [created, ...current]);
            setSelectedTransferId(created.id);
            setPage('monitor');
        } catch (err) {
            setApiError(err instanceof Error ? err.message : 'Failed to create transfer');
        } finally {
            setIsCreating(false);
        }
    };

    const retryTransfer = async (id: string) => {
        const retried = await service.retryTransfer(id);
        setTransfers((current) => current.map((transfer) => (transfer.id === id ? retried : transfer)));
        setSelectedTransferId(id);
        setPage('monitor');
    };

    return (
        <main className={styles.app}>
            <aside className={styles.sidebar}>
                <div className={styles.brand}>
                    <div className={styles.brandMark}>
                        <Layers3 size={22} aria-hidden />
                    </div>
                    <div>
                        <strong>Content Bridge</strong>
                        <span>{appContext?.name ?? 'Sitecore Marketplace'}</span>
                    </div>
                </div>

                <nav className={styles.nav} aria-label="Content Bridge pages">
                    {navigation.map((item) => {
                        const Icon = item.icon;
                        return (
                            <button
                                className={page === item.id ? styles.navItemActive : styles.navItem}
                                key={item.id}
                                onClick={() => setPage(item.id)}
                                type="button"
                            >
                                <Icon size={18} aria-hidden />
                                <span>{item.label}</span>
                            </button>
                        );
                    })}
                </nav>

                <div className={styles.oauthPanel}>
                    <ShieldCheck size={18} aria-hidden />
                    <div>
                        <strong>
                            {sdkConnected ? 'Marketplace SDK Connected' : isLoading ? 'Initializing SDK...' : 'SDK Disconnected'}
                        </strong>
                        <span>
                            {isLoading
                                ? 'Initializing Marketplace SDK'
                                : sdkConnected
                                    ? `Authenticated — ${(appContext as unknown as Record<string, unknown[]>)?.resourceAccess?.length ?? 0} tenant(s)`
                                    : error
                                        ? 'SDK initialization failed'
                                        : 'Waiting for SDK'}
                        </span>
                    </div>
                </div>
            </aside>

            <section className={styles.workspace}>
                <header className={styles.header}>
                    <div>
                        <span className={styles.eyebrow}>Sitecore content promotion</span>
                        <h1>{navigation.find((item) => item.id === page)?.label}</h1>
                    </div>
                    <button className={styles.primaryButton} onClick={() => setPage('wizard')} type="button">
                        <Split size={18} aria-hidden />
                        New transfer
                    </button>
                </header>

                {error && (
                    <div className={styles.alert}>
                        <AlertTriangle size={18} aria-hidden />
                        Marketplace SDK is unavailable in this preview: {String(error.message ?? error)}
                    </div>
                )}

                {apiError && (
                    <div className={styles.alert}>
                        <AlertTriangle size={18} aria-hidden />
                        API Error: {apiError}
                    </div>
                )}

                {isLoadingData && (
                    <div className={styles.alert}>
                        <Loader2 className={styles.spin} size={18} aria-hidden />
                        Loading data from Sitecore API...
                    </div>
                )}

                {page === 'dashboard' && (
                    <DashboardPage
                        activeTransfers={activeTransfers}
                        failedTransfers={failedTransfers}
                        transfers={transfers}
                        setPage={setPage}
                        setSelectedTransferId={setSelectedTransferId}
                        apiStatus={apiStatus}
                    />
                )}
                {page === 'wizard' && (
                    <WizardPage
                        allItems={allItems}
                        dependencyResults={dependencyResults}
                        destinationId={destinationId}
                        environments={environments}
                        isCreating={isCreating}
                        isValidating={isValidating}
                        selectedItemIds={selectedItemIds}
                        selectedItems={selectedItems}
                        setDestinationId={setDestinationId}
                        setSourceId={setSourceId}
                        setStrategy={setStrategy}
                        setTransferName={setTransferName}
                        sourceId={sourceId}
                        strategy={strategy}
                        transferName={transferName}
                        tree={tree}
                        toggleItem={toggleItem}
                        validateSelection={validateSelection}
                        createTransfer={createTransfer}
                    />
                )}
                {page === 'monitor' && (
                    <MonitorPage
                        environments={environments}
                        retryTransfer={retryTransfer}
                        setPage={setPage}
                        setSelectedTransferId={setSelectedTransferId}
                        transfers={transfers}
                    />
                )}
                {page === 'history' && (
                    <HistoryPage environments={environments} setPage={setPage} setSelectedTransferId={setSelectedTransferId} transfers={transfers} />
                )}
                {page === 'details' && selectedTransfer && (
                    <DetailsPage allItems={allItems} environments={environments} retryTransfer={retryTransfer} transfer={selectedTransfer} />
                )}
                {page === 'settings' && <SettingsPage apiStatus={apiStatus} sdkConnected={sdkConnected} />}
            </section>
        </main>
    );
}

function DashboardPage({
    activeTransfers,
    failedTransfers,
    transfers,
    setPage,
    setSelectedTransferId,
    apiStatus,
}: {
    activeTransfers: TransferRecord[];
    failedTransfers: TransferRecord[];
    transfers: TransferRecord[];
    setPage: (page: PageKey) => void;
    setSelectedTransferId: (id: string) => void;
    apiStatus: { contentTransfer: boolean; itemTransfer: boolean; authenticated: boolean };
}) {
    const completed = transfers.filter((transfer) => transfer.status === 'completed').length;
    const apiLinks = [apiStatus.contentTransfer, apiStatus.itemTransfer].filter(Boolean).length;

    return (
        <div className={styles.pageGrid}>
            <div className={styles.metricGrid}>
                <Metric icon={Clock3} label="Active transfers" value={activeTransfers.length} />
                <Metric icon={CheckCircle2} label="Completed" value={completed} />
                <Metric icon={AlertTriangle} label="Needs retry" value={failedTransfers.length} />
                <Metric icon={Database} label="API requests" value={`${apiLinks} linked`} />
            </div>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>Promotion pipeline</h2>
                        <p>Content Transfer creates the blob; Item Transfer consumes it in the target environment.</p>
                    </div>
                    <button className={styles.secondaryButton} onClick={() => setPage('monitor')} type="button">
                        View monitor
                        <ChevronRight size={16} aria-hidden />
                    </button>
                </div>
                <div className={styles.pipeline}>
                    {['Select content', 'Validate dependencies', 'Create transfer', 'Consume blob'].map((step, index) => (
                        <div className={styles.pipelineStep} key={step}>
                            <span>{index + 1}</span>
                            <strong>{step}</strong>
                        </div>
                    ))}
                </div>
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <h2>Recent transfers</h2>
                    <button className={styles.secondaryButton} onClick={() => setPage('history')} type="button">
                        Full history
                        <ChevronRight size={16} aria-hidden />
                    </button>
                </div>
                <TransferTable
                    transfers={transfers.slice(0, 4)}
                    onOpen={(id) => {
                        setSelectedTransferId(id);
                        setPage('details');
                    }}
                />
            </section>
        </div>
    );
}

function WizardPage({
    allItems,
    dependencyResults,
    destinationId,
    environments,
    isCreating,
    isValidating,
    selectedItemIds,
    selectedItems,
    setDestinationId,
    setSourceId,
    setStrategy,
    setTransferName,
    sourceId,
    strategy,
    transferName,
    tree,
    toggleItem,
    validateSelection,
    createTransfer,
}: {
    allItems: ContentTreeItem[];
    dependencyResults: DependencyFinding[];
    destinationId: string;
    environments: ContentEnvironment[];
    isCreating: boolean;
    isValidating: boolean;
    selectedItemIds: string[];
    selectedItems: ContentTreeItem[];
    setDestinationId: (id: string) => void;
    setSourceId: (id: string) => void;
    setStrategy: (strategy: MergeStrategy) => void;
    setTransferName: (name: string) => void;
    sourceId: string;
    strategy: MergeStrategy;
    transferName: string;
    tree: ContentTreeItem[];
    toggleItem: (item: ContentTreeItem, includeSubtree?: boolean) => void;
    validateSelection: () => void;
    createTransfer: () => void;
}) {
    const canCreate =
        transferName.trim().length > 0 &&
        sourceId !== destinationId &&
        selectedItemIds.length > 0 &&
        dependencyResults.every((finding) => finding.severity !== 'critical');

    return (
        <div className={styles.wizardGrid}>
            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>1. Choose environments</h2>
                        <p>Use OAuth-bound Marketplace context for source and target API calls.</p>
                    </div>
                </div>
                <div className={styles.formGrid}>
                    <label>
                        Transfer name
                        <input value={transferName} onChange={(event) => setTransferName(event.target.value)} />
                    </label>
                    <EnvironmentSelect environments={environments} label="Source environment" value={sourceId} onChange={setSourceId} />
                    <EnvironmentSelect environments={environments} label="Destination environment" value={destinationId} onChange={setDestinationId} />
                </div>
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>2. Select items and subtrees</h2>
                        <p>
                            {selectedItemIds.length} of {allItems.length} available items selected.
                        </p>
                    </div>
                    <FolderTree size={22} aria-hidden />
                </div>
                <div className={styles.tree}>
                    {tree.map((item) => (
                        <TreeNode item={item} key={item.id} selectedItemIds={selectedItemIds} toggleItem={toggleItem} />
                    ))}
                </div>
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>3. Validate dependencies</h2>
                        <p>Check references before creating the Content Transfer API request.</p>
                    </div>
                    <button className={styles.secondaryButton} onClick={validateSelection} type="button">
                        {isValidating ? <Loader2 className={styles.spin} size={16} aria-hidden /> : <ListChecks size={16} aria-hidden />}
                        Validate
                    </button>
                </div>
                <div className={styles.dependencyList}>
                    {dependencyResults.length === 0 ? (
                        <div className={styles.emptyState}>Run validation after selecting content.</div>
                    ) : (
                        dependencyResults.map((finding) => (
                            <div className={styles.dependencyItem} key={finding.id}>
                                <span className={styles[finding.severity]}>{finding.severity}</span>
                                <div>
                                    <strong>
                                        {finding.itemName} needs {finding.dependency}
                                    </strong>
                                    <p>{finding.message}</p>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>4. Merge strategy</h2>
                        <p>Choose how destination items should be reconciled.</p>
                    </div>
                </div>
                <div className={styles.segmented}>
                    {(Object.keys(strategyLabels) as MergeStrategy[]).map((key) => (
                        <button className={strategy === key ? styles.segmentActive : styles.segment} key={key} onClick={() => setStrategy(key)} type="button">
                            {strategyLabels[key]}
                        </button>
                    ))}
                </div>
                <div className={styles.summaryBox}>
                    <strong>Request preview</strong>
                    <span>{selectedItems.map((item) => item.name).join(', ') || 'No items selected'}</span>
                    <span>
                        Source {sourceId} to destination {destinationId}
                    </span>
                </div>
                <button className={styles.primaryButtonWide} disabled={!canCreate || isCreating} onClick={createTransfer} type="button">
                    {isCreating ? <Loader2 className={styles.spin} size={18} aria-hidden /> : <Database size={18} aria-hidden />}
                    Create Content Transfer request
                </button>
            </section>
        </div>
    );
}

function MonitorPage({
    environments,
    retryTransfer,
    setPage,
    setSelectedTransferId,
    transfers,
}: {
    environments: ContentEnvironment[];
    retryTransfer: (id: string) => void;
    setPage: (page: PageKey) => void;
    setSelectedTransferId: (id: string) => void;
    transfers: TransferRecord[];
}) {
    return (
        <section className={styles.panel}>
            <div className={styles.panelHeader}>
                <div>
                    <h2>Item Transfer status</h2>
                    <p>Track blob consumption, progress, failures, and retries.</p>
                </div>
                <RefreshCw size={22} aria-hidden />
            </div>
            <div className={styles.monitorList}>
                {transfers.map((transfer) => (
                    <TransferProgress
                        environments={environments}
                        key={transfer.id}
                        onOpen={() => {
                            setSelectedTransferId(transfer.id);
                            setPage('details');
                        }}
                        retryTransfer={retryTransfer}
                        transfer={transfer}
                    />
                ))}
            </div>
        </section>
    );
}

function HistoryPage({
    environments,
    setPage,
    setSelectedTransferId,
    transfers,
}: {
    environments: ContentEnvironment[];
    setPage: (page: PageKey) => void;
    setSelectedTransferId: (id: string) => void;
    transfers: TransferRecord[];
}) {
    return (
        <section className={styles.panel}>
            <div className={styles.panelHeader}>
                <div>
                    <h2>Transfer history</h2>
                    <p>Searchable record for promotions, retries, and audit traceability.</p>
                </div>
                <FileClock size={22} aria-hidden />
            </div>
            <TransferTable
                environments={environments}
                transfers={transfers}
                onOpen={(id) => {
                    setSelectedTransferId(id);
                    setPage('details');
                }}
            />
        </section>
    );
}

function DetailsPage({
    allItems,
    environments,
    retryTransfer,
    transfer,
}: {
    allItems: ContentTreeItem[];
    environments: ContentEnvironment[];
    retryTransfer: (id: string) => void;
    transfer: TransferRecord;
}) {
    const items = transfer.selectedItemIds.map((id) => allItems.find((item) => item.id === id)).filter(Boolean) as ContentTreeItem[];

    return (
        <div className={styles.detailsGrid}>
            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>{transfer.name}</h2>
                        <p>
                            {transfer.contentTransferRequestId} linked to {transfer.itemTransferJobId}
                        </p>
                    </div>
                    <StatusBadge status={transfer.status} />
                </div>
                <div className={styles.detailRows}>
                    <Detail label="Source" value={formatEnvironmentName(environments, transfer.sourceEnvironmentId)} />
                    <Detail label="Destination" value={formatEnvironmentName(environments, transfer.destinationEnvironmentId)} />
                    <Detail label="Merge strategy" value={strategyLabels[transfer.strategy]} />
                    <Detail label="Blob" value={transfer.blobUrl ?? 'Pending'} />
                    <Detail label="Created by" value={transfer.createdBy} />
                    <Detail label="Last update" value={transfer.updatedAt} />
                </div>
                {transfer.status === 'failed' && (
                    <button className={styles.primaryButton} onClick={() => retryTransfer(transfer.id)} type="button">
                        <RefreshCw size={18} aria-hidden />
                        Retry failed transfer
                    </button>
                )}
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <h2>Selected content</h2>
                    <span className={styles.countPill}>{items.length} items</span>
                </div>
                <div className={styles.itemList}>
                    {items.map((item) => (
                        <div className={styles.itemRow} key={item.id}>
                            <Database size={16} aria-hidden />
                            <div>
                                <strong>{item.name}</strong>
                                <span>{item.path}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className={styles.panelWide}>
                <div className={styles.panelHeader}>
                    <h2>Audit log</h2>
                    <KeyRound size={22} aria-hidden />
                </div>
                <div className={styles.auditList}>
                    {transfer.auditLog.map((entry) => (
                        <div className={styles.auditItem} key={entry.id}>
                            <span>{entry.timestamp}</span>
                            <div>
                                <strong>{entry.action}</strong>
                                <p>
                                    {entry.actor} - {entry.detail}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

function SettingsPage({
    apiStatus,
    sdkConnected,
}: {
    apiStatus: { contentTransfer: boolean; itemTransfer: boolean; authenticated: boolean };
    sdkConnected: boolean;
}) {
    return (
        <div className={styles.settingsGrid}>
            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>Marketplace SDK Connection</h2>
                        <p>Authentication is handled automatically by the Sitecore Marketplace host.</p>
                    </div>
                    <KeyRound size={22} aria-hidden />
                </div>
                <div className={styles.formGrid}>
                    <div className={styles.dependencyItem}>
                        <span className={sdkConnected ? styles.completed : styles.failed}>
                            {sdkConnected ? 'Connected' : 'Not connected'}
                        </span>
                        <div>
                            <strong>Marketplace SDK</strong>
                            <p>{sdkConnected ? 'SDK is authenticated via the host — API calls are routed through the PostMessage bridge' : 'Waiting for SDK initialization'}</p>
                        </div>
                    </div>
                    <div className={styles.dependencyItem}>
                        <span className={apiStatus.authenticated ? styles.completed : styles.failed}>
                            {apiStatus.authenticated ? 'Ready' : 'Waiting'}
                        </span>
                        <div>
                            <strong>Content Transfer API</strong>
                            <p>{apiStatus.authenticated ? 'Available via XMC SDK module' : 'Requires SDK connection'}</p>
                        </div>
                    </div>
                </div>
            </section>

            <section className={styles.panel}>
                <div className={styles.panelHeader}>
                    <div>
                        <h2>Governance</h2>
                        <p>Controls for audit retention and retry behavior.</p>
                    </div>
                    <ShieldCheck size={22} aria-hidden />
                </div>
                <div className={styles.toggleList}>
                    <label>
                        <input defaultChecked type="checkbox" />
                        Require dependency validation before transfer creation
                    </label>
                    <label>
                        <input defaultChecked type="checkbox" />
                        Keep audit logs for 180 days
                    </label>
                    <label>
                        <input type="checkbox" />
                        Allow automatic retry for transient Item Transfer failures
                    </label>
                </div>
            </section>
        </div>
    );
}

function EnvironmentSelect({
    environments,
    label,
    value,
    onChange,
}: {
    environments: ContentEnvironment[];
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <label>
            {label}
            <select value={value} onChange={(event) => onChange(event.target.value)}>
                {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                        {environment.name} - {environment.type}
                    </option>
                ))}
            </select>
        </label>
    );
}

function TreeNode({
    item,
    selectedItemIds,
    toggleItem,
}: {
    item: ContentTreeItem;
    selectedItemIds: string[];
    toggleItem: (item: ContentTreeItem, includeSubtree?: boolean) => void;
}) {
    const hasChildren = Boolean(item.children?.length);

    return (
        <div className={styles.treeNode}>
            <div className={styles.treeRow}>
                <label>
                    <input checked={selectedItemIds.includes(item.id)} onChange={() => toggleItem(item)} type="checkbox" />
                    <span>{item.name}</span>
                </label>
                {hasChildren && (
                    <button className={styles.iconButton} onClick={() => toggleItem(item, true)} title="Toggle subtree" type="button">
                        <FolderTree size={15} aria-hidden />
                    </button>
                )}
            </div>
            {hasChildren && (
                <div className={styles.treeChildren}>
                    {item.children?.map((child) => (
                        <TreeNode item={child} key={child.id} selectedItemIds={selectedItemIds} toggleItem={toggleItem} />
                    ))}
                </div>
            )}
        </div>
    );
}

function TransferProgress({
    environments,
    onOpen,
    retryTransfer,
    transfer,
}: {
    environments: ContentEnvironment[];
    onOpen: () => void;
    retryTransfer: (id: string) => void;
    transfer: TransferRecord;
}) {
    return (
        <div className={styles.transferCard}>
            <div className={styles.transferTopline}>
                <div>
                    <strong>{transfer.name}</strong>
                    <span>
                        {formatEnvironmentName(environments, transfer.sourceEnvironmentId)}
                        <ArrowRight size={14} aria-hidden />
                        {formatEnvironmentName(environments, transfer.destinationEnvironmentId)}
                    </span>
                </div>
                <StatusBadge status={transfer.status} />
            </div>
            <div className={styles.progressTrack}>
                <span style={{ width: `${transfer.progress}%` }} />
            </div>
            <div className={styles.cardActions}>
                <button className={styles.secondaryButton} onClick={onOpen} type="button">
                    Details
                </button>
                {transfer.status === 'failed' && (
                    <button className={styles.primaryButtonSmall} onClick={() => retryTransfer(transfer.id)} type="button">
                        <RefreshCw size={16} aria-hidden />
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}

function TransferTable({
    environments = [],
    onOpen,
    transfers,
}: {
    environments?: ContentEnvironment[];
    onOpen: (id: string) => void;
    transfers: TransferRecord[];
}) {
    return (
        <div className={styles.tableWrap}>
            <table className={styles.table}>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Route</th>
                        <th>Status</th>
                        <th>Updated</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {transfers.map((transfer) => (
                        <tr key={transfer.id}>
                            <td>
                                <strong>{transfer.name}</strong>
                                <span>{transfer.contentTransferRequestId ?? 'Draft'}</span>
                            </td>
                            <td>
                                {formatEnvironmentName(environments, transfer.sourceEnvironmentId)}
                                <ArrowRight size={14} aria-hidden />
                                {formatEnvironmentName(environments, transfer.destinationEnvironmentId)}
                            </td>
                            <td>
                                <StatusBadge status={transfer.status} />
                            </td>
                            <td>{transfer.updatedAt}</td>
                            <td>
                                <button className={styles.linkButton} onClick={() => onOpen(transfer.id)} type="button">
                                    Open
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: number | string }) {
    return (
        <div className={styles.metric}>
            <Icon size={20} aria-hidden />
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function Detail({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.detailRow}>
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function StatusBadge({ status }: { status: TransferStatus }) {
    return <span className={`${styles.badge} ${styles[status]}`}>{statusLabels[status]}</span>;
}
