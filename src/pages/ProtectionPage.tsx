import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ScreenShell } from '../components/ui/ScreenShell';
import { BottomNav } from '../components/ui/BottomNav';
import { ToggleSwitch } from '../components/ui/ToggleSwitch';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { ProtectedArtworkDisplay } from '../components/ui/ProtectedArtworkDisplay';
import { Icon } from '../assets/icons';
import { useMockToast } from '../components/ui/MockToast';
import { useAuth } from '../context/AuthContext';
import {
  ARTWORK_CATEGORIES,
  createArtworkProtectedSignedUrl,
  createArtworkOriginalSignedUrl,
  deleteArtwork,
  listMyArtworks,
  processArtworkProtection,
  updateMyArtworkMetadata,
  updateMyArtworkVisibility,
  updateArtworkProtectionLevel,
  uploadArtwork,
  type ArtworkRecord,
  type ArtworkCategory,
  type ArtworkVisibility,
} from '../lib/supabaseArtworks';
import {
  countBlockedProtectionEventsToday,
  countMyReadyProtectedWorks,
  getProtectionScanHealth,
  listMyProtectionEvents,
  listMyProtectionSettings,
  recordProtectionEvent,
  saveProtectionSettings,
  type ProtectionEvent,
  type ProtectionSettings,
  type ProtectionSettingsUpdate,
} from '../lib/supabaseProtection';
import './ProtectionPage.css';

type ProtectionLevel = 'standard' | 'enhanced' | 'maximum';

interface ShieldSetting {
  key: string;
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  subtitle: string;
}

const SETTINGS: ShieldSetting[] = [
  { key: 'cloaking', icon: 'fingerprint', title: 'Dynamic Cloaking', subtitle: 'Noise pattern on upload' },
  { key: 'tiling', icon: 'grid', title: 'Canvas Tiling Shield', subtitle: 'Encrypted chunk delivery' },
  { key: 'rightclick', icon: 'lock', title: 'Right-Click Shield', subtitle: 'Blocks direct downloads' },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function protectionLabel(level: ArtworkRecord['protection_level']): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function visibilityLabel(visibility: ArtworkVisibility): string {
  if (visibility === 'portfolio') return 'Protected Portfolio';
  if (visibility === 'discover') return 'Portfolio + Discover';
  return 'Private';
}

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function eventLabel(event: ProtectionEvent): string {
  if (event.event_type === 'blocked') return 'Right-click attempt blocked';
  if (event.event_type === 'settings_updated') return 'Shield settings updated';
  if (event.event_type === 'protection_processing_started') return 'Protection processing started';
  if (event.event_type === 'protection_processing_completed') return 'Protection processing completed';
  if (event.event_type === 'protection_processing_failed') return 'Protection processing failed';
  return event.event_type.replaceAll('_', ' ');
}

function ProtectionPageContent() {
  const { toast, showToast } = useMockToast();
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryScrollRef = useRef(0);

  const [toggles, setToggles] = useState<Record<string, boolean>>({
    cloaking: false,
    tiling: false,
    rightclick: false,
  });
  const [level, setLevel] = useState<ProtectionLevel>('enhanced');
  const [activeArtworkId, setActiveArtworkId] = useState<string | null>(null);
  const [settingsByArtwork, setSettingsByArtwork] = useState<Record<string, ProtectionSettings>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [events, setEvents] = useState<ProtectionEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | undefined>();
  const [blockedToday, setBlockedToday] = useState(0);
  const [protectedWorks, setProtectedWorks] = useState(0);
  const [scanHealth, setScanHealth] = useState({ completed: 0, failed: 0 });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [artworks, setArtworks] = useState<ArtworkRecord[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [artworksLoading, setArtworksLoading] = useState(true);
  const [artworksError, setArtworksError] = useState<string | undefined>();
  const [previewError, setPreviewError] = useState<string | undefined>();
  const [preview, setPreview] = useState<{ artwork: ArtworkRecord; url: string } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [processingArtworkId, setProcessingArtworkId] = useState<string | null>(null);
  const [editingArtwork, setEditingArtwork] = useState<{ id: string; title: string; description: string; error?: string } | null>(null);
  const [savingMetadataId, setSavingMetadataId] = useState<string | null>(null);
  const [uploadCategory, setUploadCategory] = useState<ArtworkCategory>('Other');
  const [visibilityDrafts, setVisibilityDrafts] = useState<Record<string, ArtworkVisibility>>({});
  const [visibilityErrors, setVisibilityErrors] = useState<Record<string, string>>({});
  const [savingVisibilityId, setSavingVisibilityId] = useState<string | null>(null);

  const refreshProtectionData = useCallback(async (records: ArtworkRecord[]) => {
    if (!user) {
      setActiveArtworkId(null);
      setSettingsByArtwork({});
      setEvents([]);
      setBlockedToday(0);
      setProtectedWorks(0);
      setScanHealth({ completed: 0, failed: 0 });
      return;
    }

    setSettingsLoading(true);
    setEventsLoading(true);
    setSettingsError(undefined);
    setEventsError(undefined);
    try {
      const [settings, recentEvents, blockedCount, readyCount, nextScanHealth] = await Promise.all([
        listMyProtectionSettings(user.id, records.map((artwork) => artwork.id)),
        listMyProtectionEvents(user.id),
        countBlockedProtectionEventsToday(user.id),
        countMyReadyProtectedWorks(user.id),
        getProtectionScanHealth(user.id),
      ]);
      const nextSettings = Object.fromEntries(settings.map((setting) => [setting.artwork_id, setting]));
      setSettingsByArtwork(nextSettings);
      setEvents(recentEvents);
      setBlockedToday(blockedCount);
      setProtectedWorks(readyCount);
      setScanHealth(nextScanHealth);
      const nextActiveId = records[0]?.id ?? null;
      setActiveArtworkId(nextActiveId);
      const activeSettings = nextActiveId ? nextSettings[nextActiveId] : undefined;
      setLevel(records.find((artwork) => artwork.id === nextActiveId)?.protection_level ?? 'enhanced');
      setToggles({
        cloaking: activeSettings?.dynamic_cloaking ?? false,
        tiling: activeSettings?.canvas_tiling ?? false,
        rightclick: activeSettings?.right_click_shield ?? false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load protection data.';
      setSettingsError(message);
      setEventsError(message);
    } finally {
      setSettingsLoading(false);
      setEventsLoading(false);
    }
  }, [user]);

  const refreshArtworks = useCallback(async () => {
    if (!user) {
      setArtworks([]);
      setPreviewUrls({});
      setActiveArtworkId(null);
      setSettingsByArtwork({});
      setEvents([]);
      setBlockedToday(0);
      setProtectedWorks(0);
      setScanHealth({ completed: 0, failed: 0 });
      setArtworksLoading(false);
      return;
    }

    setArtworksLoading(true);
    setArtworksError(undefined);
    try {
      const records = await listMyArtworks(user.id);
      setArtworks(records);
      void refreshProtectionData(records);
      const previewEntries = await Promise.all(records.map(async (artwork) => {
        if (artwork.status !== 'ready' || !artwork.protected_storage_path) return null;
        try {
          const url = await createArtworkProtectedSignedUrl(artwork.id, user.id);
          return [artwork.id, url] as const;
        } catch {
          return null;
        }
      }));
      setPreviewUrls(Object.fromEntries(previewEntries.filter((entry): entry is readonly [string, string] => entry !== null)));
    } catch (error) {
      setArtworksError(error instanceof Error ? error.message : 'Could not load your protected artworks.');
      setArtworks([]);
      setPreviewUrls({});
      setProtectedWorks(0);
    } finally {
      setArtworksLoading(false);
    }
  }, [refreshProtectionData, user]);

  useEffect(() => {
    void refreshArtworks();
  }, [refreshArtworks]);

  const handleActiveArtworkChange = (artworkId: string) => {
    setActiveArtworkId(artworkId);
    setLevel(artworks.find((artwork) => artwork.id === artworkId)?.protection_level ?? 'enhanced');
    const activeSettings = settingsByArtwork[artworkId];
    setToggles({
      cloaking: activeSettings?.dynamic_cloaking ?? false,
      tiling: activeSettings?.canvas_tiling ?? false,
      rightclick: activeSettings?.right_click_shield ?? false,
    });
    setSettingsError(undefined);
  };

  const handleToggleChange = async (key: string, checked: boolean) => {
    if (!user || !activeArtworkId || settingsSaving) return;
    const previous = toggles;
    const nextToggles = { ...toggles, [key]: checked };
    const nextSettings: ProtectionSettingsUpdate = {
      dynamic_cloaking: nextToggles.cloaking,
      canvas_tiling: nextToggles.tiling,
      right_click_shield: nextToggles.rightclick,
    };
    setToggles(nextToggles);
    setSettingsSaving(true);
    setSettingsError(undefined);
    try {
      const saved = await saveProtectionSettings(activeArtworkId, user.id, nextSettings);
      setSettingsByArtwork((current) => ({ ...current, [activeArtworkId]: saved }));
      const recentEvents = await listMyProtectionEvents(user.id);
      setEvents(recentEvents);
      showToast('Protection settings saved');
    } catch (error) {
      setToggles(previous);
      setSettingsError(error instanceof Error ? error.message : 'Could not save protection settings.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleProtectionLevelChange = async (nextLevel: ProtectionLevel) => {
    setLevel(nextLevel);
    if (!user || !activeArtworkId || processingArtworkId) return;
    const artwork = artworks.find((candidate) => candidate.id === activeArtworkId);
    if (!artwork || artwork.protection_level === nextLevel) return;

    setProcessingArtworkId(artwork.id);
    setSettingsError(undefined);
    setPreviewUrls((current) => {
      const next = { ...current };
      delete next[artwork.id];
      return next;
    });
    setArtworks((current) => current.map((candidate) => candidate.id === artwork.id
      ? { ...candidate, protection_level: nextLevel, status: 'processing', protected_storage_path: null }
      : candidate));
    try {
      const updatedArtwork = await updateArtworkProtectionLevel(artwork.id, user.id, nextLevel);
      await processArtworkProtection(user.id, updatedArtwork);
      await refreshArtworks();
      showToast('Protection level updated and artwork reprocessed');
    } catch (error) {
      await refreshArtworks();
      setSettingsError(error instanceof Error ? error.message : 'Could not reprocess this artwork.');
    } finally {
      setProcessingArtworkId(null);
    }
  };

  const handleRetryProtection = async (artwork: ArtworkRecord) => {
    if (!user || processingArtworkId) return;
    setProcessingArtworkId(artwork.id);
    setArtworksError(undefined);
    setPreviewUrls((current) => {
      const next = { ...current };
      delete next[artwork.id];
      return next;
    });
    setArtworks((current) => current.map((candidate) => candidate.id === artwork.id
      ? { ...candidate, status: 'processing', protected_storage_path: null }
      : candidate));
    try {
      await processArtworkProtection(user.id, artwork);
      await refreshArtworks();
      showToast('Protection retry completed');
    } catch (error) {
      await refreshArtworks();
      setArtworksError(error instanceof Error ? error.message : 'Could not retry protection.');
    } finally {
      setProcessingArtworkId(null);
    }
  };

  const handleContextMenuBlocked = async (artwork: ArtworkRecord) => {
    if (!user) return;
    try {
      await recordProtectionEvent(artwork.id, user.id, 'blocked', {
        action: 'contextmenu',
        protection: 'right_click_shield',
        user_agent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent.slice(0, 240),
      });
      setBlockedToday((current) => current + 1);
      setEvents(await listMyProtectionEvents(user.id));
      showToast('Right-click attempt blocked');
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : 'Could not record the blocked protection event.');
    }
  };

  const trackedProcessingAttempts = scanHealth.completed + scanHealth.failed;
  const scanHealthLabel = trackedProcessingAttempts === 0
    ? '—'
    : `${Math.round((scanHealth.completed / trackedProcessingAttempts) * 100)}%`;

  const handleFileChosen = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setUploadError(undefined);
    setUploading(true);
    try {
      await uploadArtwork(user?.id ?? '', file, level, uploadCategory);
      await refreshArtworks();
      showToast(`"${file.name}" uploaded to private artwork storage`);
    } catch (error) {
      await refreshArtworks();
      setUploadError(error instanceof Error ? error.message : 'Artwork upload failed. Please try again.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveVisibility = async (artwork: ArtworkRecord) => {
    if (!user || savingVisibilityId) return;
    const visibility = visibilityDrafts[artwork.id] ?? artwork.visibility ?? 'private';
    if (visibility !== 'private' && (artwork.status !== 'ready' || !artwork.protected_storage_path)) {
      setVisibilityErrors((current) => ({ ...current, [artwork.id]: 'Only ready protected artwork can be published.' }));
      return;
    }

    setSavingVisibilityId(artwork.id);
    setVisibilityErrors((current) => ({ ...current, [artwork.id]: '' }));
    try {
      const savedVisibility = await updateMyArtworkVisibility(artwork.id, visibility);
      setArtworks((current) => current.map((candidate) => candidate.id === artwork.id
        ? { ...candidate, visibility: savedVisibility }
        : candidate));
      setVisibilityDrafts((current) => ({ ...current, [artwork.id]: savedVisibility }));
    } catch (error) {
      let refreshError: unknown;
      try {
        const currentArtworks = await listMyArtworks(user.id);
        setArtworks(currentArtworks);
      } catch (errorWhileRefreshing) {
        refreshError = errorWhileRefreshing;
      }
      setVisibilityErrors((current) => ({
        ...current,
        [artwork.id]: error instanceof Error
          ? `Could not save publication setting: ${error.message}${refreshError instanceof Error ? ` Current server state could not be refreshed: ${refreshError.message}` : ''}`
          : `Could not save publication setting.${refreshError instanceof Error ? ` Current server state could not be refreshed: ${refreshError.message}` : ' Please try again.'}`,
      }));
    } finally {
      setSavingVisibilityId(null);
    }
  };

  const openArtwork = async (artwork: ArtworkRecord) => {
    galleryScrollRef.current = window.scrollY;
    setPreviewError(undefined);
    setPreviewLoadingId(artwork.id);
    try {
      const url = previewUrls[artwork.id] ?? await createArtworkOriginalSignedUrl(artwork.id, user?.id ?? '');
      setPreviewUrls((previous) => ({ ...previous, [artwork.id]: url }));
      setPreview({ artwork, url });
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Could not open this artwork preview.');
    } finally {
      setPreviewLoadingId(null);
    }
  };

  const closeArtworkPreview = () => {
    setPreview(null);
    setEditingArtwork(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: galleryScrollRef.current, behavior: 'auto' }));
  };

  const handleDelete = async (artwork: ArtworkRecord) => {
    if (!user || deletingId) return;
    const confirmed = window.confirm(`Delete "${artwork.title}"? Its private storage file and artwork record will be removed.`);
    if (!confirmed) return;

    setDeletingId(artwork.id);
    setArtworksError(undefined);
    try {
      await deleteArtwork(artwork.id, user.id);
      if (preview?.artwork.id === artwork.id) closeArtworkPreview();
      await refreshArtworks();
      showToast('Artwork deleted from private storage');
    } catch (error) {
      setArtworksError(error instanceof Error ? error.message : 'Could not delete this artwork.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaveMetadata = async (artworkId: string) => {
    if (!editingArtwork || editingArtwork.id !== artworkId || savingMetadataId) return;
    const title = editingArtwork.title.trim();
    if (!title) {
      setEditingArtwork((current) => current ? { ...current, error: 'Title is required.' } : current);
      return;
    }

    setSavingMetadataId(artworkId);
    setEditingArtwork((current) => current ? { ...current, error: undefined } : current);
    try {
      const updatedArtwork = await updateMyArtworkMetadata(artworkId, title, editingArtwork.description);
      setArtworks((current) => current.map((artwork) => artwork.id === updatedArtwork.id ? updatedArtwork : artwork));
      setPreview((current) => current?.artwork.id === updatedArtwork.id
        ? { ...current, artwork: updatedArtwork }
        : current);
      setEditingArtwork(null);
      showToast('Artwork details updated');
    } catch {
      setEditingArtwork((current) => current?.id === artworkId
        ? { ...current, error: 'Could not save artwork details. Please try again.' }
        : current);
    } finally {
      setSavingMetadataId(null);
    }
  };

  return (
    <ScreenShell
      header={
        <div className="px-hd protection-page-header">
          <div className="protection-header-copy">
            <span className="protection-header-icon" aria-hidden="true">
              <Icon name="shield" />
            </span>
            <div>
              <span className="h-title protection-page-title">Protection</span>
              <p>Private artwork protection and delivery controls</p>
            </div>
          </div>
        </div>
      }
      footer={<BottomNav active="shield" />}
    >
      <div className="protection-page">
        <input
          type="file"
          accept="image/png,image/jpeg"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={(e) => void handleFileChosen(e.target.files)}
        />
        <section className="protection-top-layout" aria-label="Upload artwork">
          <label className="artwork-category-field protection-category-card card ag-liquid-glass-soft">
            <span className="t-xs c-low protection-field-label">Artwork category</span>
            <select
              value={uploadCategory}
              onChange={(event) => setUploadCategory(event.target.value as ArtworkCategory)}
              disabled={uploading}
            >
              {ARTWORK_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="tap-card card ag-liquid-glass-soft protection-upload-card"
            disabled={uploading}
            aria-busy={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="protection-upload-icon">
              <Icon name="upload" style={{ stroke: 'var(--ag-accent)' }} />
            </div>
            <div className="protection-upload-copy">
              <div className="t-sm fw-700">
                {uploading ? 'Uploading and protecting artwork…' : 'Drop artwork to shield'}
              </div>
              <div className="t-xs c-low">or tap to upload · JPG, PNG up to 40MB</div>
            </div>
          </button>
        </section>
      {uploadError && (
        <div className="card t-xs" role="alert" style={{ marginBottom: 18, color: 'var(--ag-danger)', borderColor: 'rgba(248,113,113,0.3)' }}>
          {uploadError}
        </div>
      )}

      <div className="row-between protection-section-heading">
        <span className="section-title">My Protected Artworks</span>
        <span className="t-xs c-low">{protectedWorks} stored</span>
      </div>
      {artworksLoading && (
        <div className="card t-sm c-mid protection-artwork-state" role="status">
          Loading your private artworks…
        </div>
      )}
      {!artworksLoading && artworksError && (
        <div className="card t-sm protection-artwork-state protection-artwork-error" role="alert">
          <div>{artworksError}</div>
          <button type="button" className="link-sm" onClick={() => void refreshArtworks()}>
            Try again
          </button>
        </div>
      )}
      {!artworksLoading && !artworksError && artworks.length === 0 && (
        <div className="protection-artwork-empty">
          <span className="protection-artwork-empty-icon" aria-hidden="true">
            <Icon name="image" />
          </span>
          <div>
            <strong>No protected artworks yet</strong>
            <p>Upload artwork above to create your private protected gallery.</p>
          </div>
        </div>
      )}
      {!artworksLoading && !artworksError && artworks.length > 0 && (
        <div className="protected-artwork-grid">
          {artworks.map((artwork) => (
            <article className="protected-artwork-card card ag-liquid-glass-soft" key={artwork.id}>
              <button
                type="button"
                className="protected-artwork-preview"
                onClick={() => void openArtwork(artwork)}
                disabled={previewLoadingId === artwork.id}
                aria-label={`Open preview of ${artwork.title}`}
              >
                {artwork.status === 'ready' && previewUrls[artwork.id] ? (
                  <ProtectedArtworkDisplay
                    src={previewUrls[artwork.id]}
                    alt={`${artwork.title} protected preview`}
                    settings={settingsByArtwork[artwork.id]}
                    fitMode="contain"
                    onContextMenuBlocked={() => void handleContextMenuBlocked(artwork)}
                  />
                ) : (
                  <span>
                    {previewLoadingId === artwork.id
                      ? 'Loading preview…'
                      : artwork.status === 'processing'
                        ? 'Protection processing…'
                        : artwork.status === 'failed'
                          ? 'Protection failed'
                          : 'Preview unavailable'}
                  </span>
                )}
              </button>
              <div className="protected-artwork-info">
                <div className="protected-artwork-card-heading">
                  <strong className="t-sm protected-artwork-title">{artwork.title}</strong>
                  <span className="badge badge-accent">{protectionLabel(artwork.protection_level)}</span>
                </div>
                <div className="t-xs c-low protected-artwork-meta">
                  {artwork.original_filename} · {artwork.mime_type.replace('image/', '').toUpperCase()} · {formatFileSize(artwork.file_size_bytes)}
                </div>
                <div className={`t-xs protected-artwork-status ${artwork.status === 'ready' ? 'c-success' : artwork.status === 'failed' ? 'protection-artwork-error' : 'c-low'}`}>
                  {artwork.status === 'ready' ? 'Protected / Ready' : artwork.status === 'processing' ? 'Processing' : artwork.status === 'failed' ? 'Protection Failed' : 'Uploaded'}
                </div>
                <button
                  type="button"
                  className="protected-artwork-open"
                  onClick={() => void openArtwork(artwork)}
                  disabled={previewLoadingId === artwork.id}
                >
                  {previewLoadingId === artwork.id ? 'Loading…' : 'Open preview'}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {previewError && <div className="card t-xs protection-artwork-error" role="alert">{previewError}</div>}
      {preview && (
        <section className="protected-artwork-detail" aria-label={`${preview.artwork.title} preview and details`}>
          <button type="button" className="protected-artwork-back" onClick={closeArtworkPreview}>
            <Icon name="chevron-l" />
            Back to Protected Artworks
          </button>
          <div className="protected-artwork-detail-header">
            <div>
              <span className="t-xs c-low">Protected artwork</span>
              <h2>{preview.artwork.title}</h2>
            </div>
            <span className="badge badge-accent">{protectionLabel(preview.artwork.protection_level)}</span>
          </div>
          <div className="protected-artwork-detail-layout">
            <div className="protected-artwork-detail-preview">
              <ProtectedArtworkDisplay
                src={preview.url}
                alt={`${preview.artwork.title} large protected preview`}
                settings={settingsByArtwork[preview.artwork.id]}
                fitMode="contain"
                onContextMenuBlocked={() => void handleContextMenuBlocked(preview.artwork)}
              />
            </div>
            <aside className="protected-artwork-detail-panel" aria-label="Artwork details">
              {editingArtwork?.id === preview.artwork.id ? (
                <div className="protected-artwork-edit-form">
                  <label className="field-label" htmlFor={`detail-artwork-title-${preview.artwork.id}`}>Title</label>
                  <input
                    id={`detail-artwork-title-${preview.artwork.id}`}
                    className="input-field"
                    value={editingArtwork.title}
                    onChange={(event) => setEditingArtwork((current) => current ? { ...current, title: event.target.value, error: undefined } : current)}
                    disabled={savingMetadataId === preview.artwork.id}
                  />
                  <label className="field-label" htmlFor={`detail-artwork-description-${preview.artwork.id}`}>Description</label>
                  <textarea
                    id={`detail-artwork-description-${preview.artwork.id}`}
                    className="textarea-field"
                    value={editingArtwork.description}
                    onChange={(event) => setEditingArtwork((current) => current ? { ...current, description: event.target.value, error: undefined } : current)}
                    disabled={savingMetadataId === preview.artwork.id}
                    rows={4}
                  />
                  {editingArtwork.error && <div className="t-xs c-danger" role="alert">{editingArtwork.error}</div>}
                  <div className="protected-artwork-detail-actions">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSaveMetadata(preview.artwork.id)} disabled={savingMetadataId === preview.artwork.id}>
                      {savingMetadataId === preview.artwork.id ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingArtwork(null)} disabled={savingMetadataId === preview.artwork.id}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <dl className="protected-artwork-detail-meta">
                    <div><dt>File name</dt><dd>{preview.artwork.original_filename}</dd></div>
                    <div><dt>Format</dt><dd>{preview.artwork.mime_type.replace('image/', '').toUpperCase()}</dd></div>
                    <div><dt>File size</dt><dd>{formatFileSize(preview.artwork.file_size_bytes)}</dd></div>
                    <div><dt>Status</dt><dd className={preview.artwork.status === 'ready' ? 'c-success' : preview.artwork.status === 'failed' ? 'protection-artwork-error' : 'c-low'}>{preview.artwork.status === 'ready' ? 'Protected / Ready' : preview.artwork.status === 'processing' ? 'Processing' : preview.artwork.status === 'failed' ? 'Protection Failed' : 'Uploaded'}</dd></div>
                  </dl>
                  <div className="protected-artwork-publication">
                    <div className="row-between gap-8">
                      <span className="t-sm fw-700">Publication</span>
                      <span className="badge badge-accent">{visibilityLabel(visibilityDrafts[preview.artwork.id] ?? preview.artwork.visibility ?? 'private')}</span>
                    </div>
                    <select
                      aria-label="Artwork publication"
                      value={visibilityDrafts[preview.artwork.id] ?? preview.artwork.visibility ?? 'private'}
                      onChange={(event) => {
                        setVisibilityDrafts((current) => ({ ...current, [preview.artwork.id]: event.target.value as ArtworkVisibility }));
                        setVisibilityErrors((current) => ({ ...current, [preview.artwork.id]: '' }));
                      }}
                      disabled={savingVisibilityId === preview.artwork.id}
                    >
                      <option value="private">Private</option>
                      <option value="portfolio" disabled={preview.artwork.status !== 'ready' || !preview.artwork.protected_storage_path}>Protected Portfolio</option>
                      <option value="discover" disabled={preview.artwork.status !== 'ready' || !preview.artwork.protected_storage_path}>Portfolio + Discover</option>
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleSaveVisibility(preview.artwork)}
                      disabled={
                        savingVisibilityId === preview.artwork.id
                        || ((visibilityDrafts[preview.artwork.id] ?? preview.artwork.visibility ?? 'private') === (preview.artwork.visibility ?? 'private'))
                        || ((visibilityDrafts[preview.artwork.id] ?? preview.artwork.visibility ?? 'private') !== 'private'
                          && (preview.artwork.status !== 'ready' || !preview.artwork.protected_storage_path))
                      }
                    >
                      {savingVisibilityId === preview.artwork.id ? 'Saving…' : 'Save publication'}
                    </button>
                    {visibilityErrors[preview.artwork.id] && <div className="t-xs protection-artwork-error" role="alert">{visibilityErrors[preview.artwork.id]}</div>}
                  </div>
                  <div className="protected-artwork-detail-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditingArtwork({ id: preview.artwork.id, title: preview.artwork.title, description: preview.artwork.description ?? '' })}
                      disabled={savingMetadataId !== null || deletingId === preview.artwork.id}
                    >
                      Edit
                    </button>
                    {preview.artwork.status === 'failed' && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleRetryProtection(preview.artwork)} disabled={processingArtworkId === preview.artwork.id || deletingId === preview.artwork.id}>
                        {processingArtworkId === preview.artwork.id ? 'Retrying…' : 'Retry protection'}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm protected-artwork-delete" onClick={() => void handleDelete(preview.artwork)} disabled={deletingId === preview.artwork.id || processingArtworkId === preview.artwork.id}>
                      {deletingId === preview.artwork.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </>
              )}
            </aside>
          </div>
          <div className="t-xs c-low protected-artwork-detail-expiry">Authorized preview link expires shortly.</div>
        </section>
      )}

      <section className="protection-settings-card" aria-labelledby="protection-settings-title">
        <div className="protection-settings-header">
          <div>
            <h2 className="section-title" id="protection-settings-title">Shield Settings</h2>
            <p>Fine-tune the protections applied to the selected artwork.</p>
          </div>
          {artworks.length > 0 && (
            <label className="protection-artwork-selector t-xs c-low">
              <span>Artwork</span>
              <select
                value={activeArtworkId ?? ''}
                onChange={(event) => handleActiveArtworkChange(event.target.value)}
                disabled={settingsLoading || settingsSaving || Boolean(processingArtworkId)}
              >
                {artworks.map((artwork) => <option value={artwork.id} key={artwork.id}>{artwork.title}</option>)}
              </select>
            </label>
          )}
        </div>
        {settingsLoading && <div className="t-xs c-low protection-settings-status" role="status">Loading saved shield settings…</div>}
        {settingsError && <div className="t-xs protection-artwork-error protection-settings-status" role="alert">{settingsError}</div>}
        {artworks.length === 0 && <div className="t-xs c-low protection-settings-status">Upload an artwork to configure its protection settings.</div>}
        <div className="protection-settings-list">
          {SETTINGS.map((setting) => (
            <div className="protection-setting-row" key={setting.key}>
              <div className="protection-setting-copy">
                <span className="protection-setting-icon" aria-hidden="true">
                  <Icon name={setting.icon} />
                </span>
                <div className="protection-setting-text">
                  <div className="t-sm fw-600">{setting.title}</div>
                  <div className="t-xs c-low">{setting.subtitle}</div>
                </div>
              </div>
              <ToggleSwitch
                checked={toggles[setting.key]}
                onChange={(checked) => void handleToggleChange(setting.key, checked)}
                ariaLabel={setting.title}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="protection-level-panel" aria-labelledby="protection-level-title">
        <div className="protection-level-copy">
          <span className="section-title" id="protection-level-title">Protection Level</span>
          <p>Choose how strongly the selected artwork is protected.</p>
        </div>
        <div className="protection-level-control">
          <SegmentedControl
            ariaLabel="Protection level"
            value={level}
            onChange={(nextLevel: ProtectionLevel) => void handleProtectionLevelChange(nextLevel)}
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'enhanced', label: 'Enhanced' },
              { value: 'maximum', label: 'Maximum' },
            ]}
          />
        </div>
      </section>

      <div className="protection-lower-layout">
        <section className="protection-snapshot" aria-labelledby="protection-snapshot-title">
          <div className="row-between protection-section-heading">
            <span className="section-title" id="protection-snapshot-title">Security Snapshot</span>
          </div>
          <div className="protection-snapshot-grid">
            <div className="card protection-snapshot-card">
              <div className="mono fw-700 protection-snapshot-danger">
                {blockedToday}
              </div>
              <div className="t-xs c-low">Blocked today</div>
            </div>
            <div className="card protection-snapshot-card">
              <div className="mono fw-700">
                {protectedWorks}
              </div>
              <div className="t-xs c-low">Protected works</div>
            </div>
            <div className="card protection-snapshot-card">
              <div className="mono fw-700 protection-snapshot-success">
                {scanHealthLabel}
              </div>
              <div className="t-xs c-low">Scan health</div>
            </div>
          </div>
        </section>

        <section className="protection-scan-log" aria-labelledby="protection-scan-log-title">
          <div className="section-title protection-section-heading" id="protection-scan-log-title">
            Recent Scan Log
          </div>
          <div className="protection-scan-log-list">
            {eventsLoading && <div className="t-xs c-low" role="status">Loading recent protection events…</div>}
            {!eventsLoading && eventsError && <div className="t-xs protection-artwork-error" role="alert">{eventsError}</div>}
            {!eventsLoading && !eventsError && events.length === 0 && (
              <div className="protection-scan-empty">
                <span className="protection-scan-empty-icon" aria-hidden="true">
                  <Icon name="check-circle" />
                </span>
                <div>
                  <strong>No recent activity</strong>
                  <p>Protection events will appear here as artwork is processed.</p>
                </div>
              </div>
            )}
            {!eventsLoading && !eventsError && events.map((entry) => (
              <div className="protection-scan-log-row" key={entry.id}>
                <Icon
                  name={entry.event_type === 'blocked' || entry.event_type === 'protection_processing_failed' ? 'alert' : 'check-circle'}
                  style={{ width: 15, height: 15, stroke: entry.event_type === 'blocked' || entry.event_type === 'protection_processing_failed' ? 'var(--ag-danger)' : 'var(--ag-success)' }}
                />
                <div className="protection-scan-log-copy">
                  <div className="t-xs c-hi fw-600">{eventLabel(entry)}</div>
                  <div className="t-xs c-low">{artworks.find((artwork) => artwork.id === entry.artwork_id)?.title ?? 'Artwork'} · {formatEventDate(entry.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {toast}
      </div>
    </ScreenShell>
  );
}

export function ProtectionPage() {
  const { user } = useAuth();
  if (user?.role !== 'artist') return <Navigate to="/home" replace />;
  return <ProtectionPageContent />;
}
