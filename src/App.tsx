import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArrowDownBox,
  Check,
  Clock,
  Cross,
  ExternalLink,
  Folder,
  Gears,
  Globe,
  Info,
  Link as LinkIcon,
  List as ListIcon,
  Play,
  Plus,
  Search,
  Volume,
} from '@getpapillon/papicons';

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }
}

interface AppConfig {
  local_music_dir: string;
  navidrome_music_dir: string;
  navidrome_url: string;
  user_playlists_dir: string;
  configured: boolean;
}

interface TrackItem {
  index: number;
  source?: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  cover_url?: string;
  filename: string;
  estimated_bytes: number;
  downloaded_bytes?: number;
  size_bytes?: number;
  percent?: number;
  status?: string;
  already_exists?: boolean;
  existing_bytes?: number;
  error?: string;
}

interface AnalysisData {
  source: string;
  kind: string;
  title: string;
  suggested_folder: string;
  cover_url: string;
  resolved_url: string;
  track_count: number;
  existing_count: number;
  total_duration_sec: number;
  estimated_total_bytes: number;
  q_free_bytes: number;
  y_free_bytes: number;
  navidrome_online: boolean;
  tracks: TrackItem[];
}

interface ProgressData {
  type?: string;
  phase: string;
  message?: string;
  folder_name?: string;
  percent: number;
  downloaded_bytes: number;
  total_estimated_bytes: number;
  speed_bps: number;
  elapsed_sec: number;
  eta_sec: number;
  completed_tracks: number;
  total_tracks: number;
  failed_tracks: number;
  navidrome_online?: boolean;
  navidrome_m3u?: string;
  tracks: TrackItem[];
}

interface DuplicateMatch {
  candidate_file: string;
  existing_file: string;
  size_bytes: number;
}

interface DedupReport {
  target_playlist: string;
  scanned_files: number;
  existing_files: number;
  added_files: number;
  duplicates_skipped: number;
  bytes_verified_ram: number;
  duration_ms: number;
  speed_mbps: number;
  duplicates: DuplicateMatch[];
  added_list: string[];
  m3u8_updated: boolean;
}

interface JobSnapshot {
  running: boolean;
  mode: string;
  child_pid?: number | null;
  progress?: ProgressData;
  dedup_report?: DedupReport | null;
  error?: string | null;
}

interface LocalPlaylist {
  name: string;
  local_path: string;
  nas_path: string;
  is_phonk_sub: boolean;
  track_count: number;
  total_bytes: number;
  has_local_m3u: boolean;
  nas_track_count: number;
  nas_has_m3u: boolean;
  synced: boolean;
}

interface PlaylistsResponse {
  playlists: LocalPlaylist[];
  q_free_bytes: number;
  y_free_bytes: number;
  navidrome_online: boolean;
  navidrome_url: string;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const fn = window.__TAURI__?.core?.invoke;
  if (!fn) {
    throw new Error('Interface Tauri non disponible.');
  }
  return fn<T>(cmd, args);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} Go (${mb.toFixed(0)} Mo)`;
  }
  return `${mb.toFixed(1)} Mo`;
}

function formatBytesShort(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} Go`;
  }
  return `${mb.toFixed(1)} Mo`;
}

function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return '0,0 Mo/s';
  const mbs = bps / (1024 * 1024);
  if (mbs >= 1) return `${mbs.toFixed(1)} Mo/s`;
  return `${(bps / 1024).toFixed(0)} Ko/s`;
}

function formatRamSpeed(mbps: number): string {
  if (!mbps || mbps <= 0) return '0 Mo/s';
  if (mbps >= 1024) return `${(mbps / 1024).toFixed(2)} Go/s`;
  return `${mbps.toFixed(1)} Mo/s`;
}

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '00:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`;
  }
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function statusLabel(st?: string): { text: string; cls: string } {
  switch (st) {
    case 'done':
      return { text: 'Terminé', cls: 'badge-ok' };
    case 'skipped':
      return { text: 'Déjà présent', cls: 'badge-ok' };
    case 'downloading':
      return { text: 'Téléchargement', cls: 'badge-accent' };
    case 'tagging':
      return { text: 'MP3 & Tags ID3', cls: 'badge-warn' };
    case 'error':
      return { text: 'Erreur', cls: 'badge-err' };
    default:
      return { text: 'En attente', cls: '' };
  }
}

function safeNum(val: unknown, fallback = 0): number {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function normalizeProgress(
  raw: Partial<ProgressData> | undefined,
  prev: ProgressData | null
): ProgressData {
  const r = raw ?? {};
  const rawTracks = Array.isArray(r.tracks) ? r.tracks : [];
  const prevTracks = prev?.tracks ?? [];
  const rawTotalEst = safeNum(r.total_estimated_bytes, 0);
  const prevTotalEst = safeNum(prev?.total_estimated_bytes, 0);

  return {
    type: r.type ?? prev?.type,
    phase: typeof r.phase === 'string' && r.phase ? r.phase : prev?.phase || 'download',
    message: typeof r.message === 'string' ? r.message : prev?.message,
    folder_name:
      typeof r.folder_name === 'string' && r.folder_name
        ? r.folder_name
        : prev?.folder_name,
    percent: safeNum(r.percent, safeNum(prev?.percent, 0)),
    downloaded_bytes: safeNum(r.downloaded_bytes, safeNum(prev?.downloaded_bytes, 0)),
    total_estimated_bytes: rawTotalEst > 0 ? rawTotalEst : prevTotalEst,
    speed_bps: safeNum(r.speed_bps, 0),
    elapsed_sec: safeNum(r.elapsed_sec, safeNum(prev?.elapsed_sec, 0)),
    eta_sec: safeNum(r.eta_sec, safeNum(prev?.eta_sec, 0)),
    completed_tracks: safeNum(r.completed_tracks, safeNum(prev?.completed_tracks, 0)),
    total_tracks: safeNum(r.total_tracks, safeNum(prev?.total_tracks, 0)) || prevTracks.length,
    failed_tracks: safeNum(r.failed_tracks, safeNum(prev?.failed_tracks, 0)),
    navidrome_online: r.navidrome_online ?? prev?.navidrome_online,
    navidrome_m3u: r.navidrome_m3u ?? prev?.navidrome_m3u,
    tracks: rawTracks.length > 0 ? rawTracks : prevTracks,
  };
}

export default function App() {
  const [tab, setTab] = useState<'download' | 'navidrome' | 'settings'>('download');
  const [config, setConfig] = useState<AppConfig>({
    local_music_dir: '',
    navidrome_music_dir: '',
    navidrome_url: '',
    user_playlists_dir: '',
    configured: false,
  });
  const [savingConfig, setSavingConfig] = useState(false);

  const [urlInput, setUrlInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);

  const [destMode, setDestMode] = useState<'new' | 'existing'>('new');
  const [folderName, setFolderName] = useState('');
  const [targetExistingPlaylist, setTargetExistingPlaylist] = useState('');
  const [autoNavidrome, setAutoNavidrome] = useState(true);

  const [jobRunning, setJobRunning] = useState(false);
  const [jobMode, setJobMode] = useState<string>('');
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [dedupReport, setDedupReport] = useState<DedupReport | null>(null);
  const [scanningRam, setScanningRam] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const [playlistsData, setPlaylistsData] = useState<PlaylistsResponse | null>(null);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);

  const pollRef = useRef<number | null>(null);

  const refreshPlaylists = async () => {
    setLoadingPlaylists(true);
    try {
      const res = await invokeTauri<PlaylistsResponse>('list_playlists');
      setPlaylistsData(res);
      if (res.playlists.length > 0 && !targetExistingPlaylist) {
        setTargetExistingPlaylist(res.playlists[0].name);
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setLoadingPlaylists(false);
    }
  };

  useEffect(() => {
    invokeTauri<AppConfig>('get_config')
      .then((cfg) => {
        setConfig(cfg);
        if (!cfg.configured) {
          setTab('settings');
        }
        if (!cfg.navidrome_music_dir) {
          setAutoNavidrome(false);
        }
      })
      .catch(() => {});

    refreshPlaylists();

    invokeTauri<JobSnapshot>('get_job_status')
      .then((snap) => {
        if (snap.progress && snap.progress.phase) {
          setProgress((prev) => normalizeProgress(snap.progress, prev));
        }
        if (snap.dedup_report) {
          setDedupReport(snap.dedup_report);
        }
        if (snap.running) {
          setJobMode(snap.mode || 'download');
          setJobRunning(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!jobRunning) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }

    const tick = async () => {
      try {
        const snap = await invokeTauri<JobSnapshot>('get_job_status');
        if (snap.progress && snap.progress.phase) {
          setProgress((prev) => normalizeProgress(snap.progress, prev));
        }
        if (snap.dedup_report) {
          setDedupReport(snap.dedup_report);
        }
        if (snap.error) {
          setErrorMsg(snap.error);
        }
        if (!snap.running) {
          setJobRunning(false);
          if (!snap.error && snap.progress?.phase === 'done') {
            if (jobMode === 'sync_navidrome') {
              setInfoMsg('Synchronisation Navidrome terminée.');
            } else if (jobMode === 'merge_download') {
              setInfoMsg(
                'Fusion terminée avec vérification bit-à-bit en RAM (aucun doublon ajouté).'
              );
            } else {
              setInfoMsg(`Téléchargement terminé dans ${config.local_music_dir}.`);
            }
          }
          refreshPlaylists();
        }
      } catch {
        // Ignore transient poll errors
      }
    };

    tick();
    pollRef.current = window.setInterval(tick, 250);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobRunning, jobMode, config.local_music_dir]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setSavingConfig(true);
    try {
      await invokeTauri('save_app_config', { cfg: config });
      setConfig((c) => ({ ...c, configured: true }));
      setInfoMsg('Configuration enregistrée.');
      await refreshPlaylists();
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setSavingConfig(false);
    }
  };

  const handleAnalyze = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = urlInput.trim();
    if (!cleaned) return;
    setErrorMsg(null);
    setInfoMsg(null);
    setDedupReport(null);
    setAnalyzing(true);
    try {
      const data = await invokeTauri<AnalysisData>('analyze_url', { url: cleaned });
      setAnalysis(data);
      setFolderName(data.suggested_folder || 'Nouvelle Playlist');
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleStartDownload = async () => {
    if (!analysis) return;
    setErrorMsg(null);
    setInfoMsg(null);
    setDedupReport(null);

    const isMerge = destMode === 'existing' && targetExistingPlaylist.trim().length > 0;
    const chosenName = isMerge
      ? targetExistingPlaylist.trim()
      : folderName.trim() || analysis.suggested_folder;

    try {
      setJobMode(isMerge ? 'merge_download' : 'download');
      setProgress({
        phase: 'download',
        folder_name: chosenName,
        percent: 0,
        downloaded_bytes: 0,
        total_estimated_bytes: analysis.estimated_total_bytes,
        speed_bps: 0,
        elapsed_sec: 0,
        eta_sec: 0,
        completed_tracks: 0,
        total_tracks: analysis.track_count,
        failed_tracks: 0,
        tracks: analysis.tracks.map((t) => ({
          ...t,
          status: !isMerge && t.already_exists ? 'skipped' : 'waiting',
          percent: !isMerge && t.already_exists ? 100 : 0,
        })),
      });

      if (isMerge) {
        await invokeTauri('start_merge_download', {
          url: urlInput.trim(),
          targetPlaylist: chosenName,
          autoNavidrome: autoNavidrome && Boolean(config.navidrome_music_dir.trim()),
        });
      } else {
        await invokeTauri('start_download', {
          url: urlInput.trim(),
          folderName: chosenName,
          autoNavidrome: autoNavidrome && Boolean(config.navidrome_music_dir.trim()),
        });
      }
      setJobRunning(true);
    } catch (err) {
      setErrorMsg(String(err));
      setJobRunning(false);
    }
  };

  const handleSyncNavidrome = async (targetName: string) => {
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      setJobMode('sync_navidrome');
      setTab('download');
      setProgress({
        phase: 'navidrome_sync',
        folder_name: targetName,
        percent: 0,
        downloaded_bytes: 0,
        total_estimated_bytes: 0,
        speed_bps: 0,
        elapsed_sec: 0,
        eta_sec: 0,
        completed_tracks: 0,
        total_tracks: 0,
        failed_tracks: 0,
        tracks: [],
      });
      await invokeTauri('sync_to_navidrome', { folderName: targetName });
      setJobRunning(true);
    } catch (err) {
      setErrorMsg(String(err));
      setJobRunning(false);
    }
  };

  const handleScanRam = async (playlistName: string) => {
    setErrorMsg(null);
    setInfoMsg(null);
    setScanningRam(playlistName);
    try {
      const rep = await invokeTauri<DedupReport>('scan_playlist_duplicates', { playlistName });
      setDedupReport(rep);
      setInfoMsg(
        `Contrôle RAM terminé sur "${playlistName}" : ${rep.duplicates_skipped} doublon(s) détecté(s) à ${formatRamSpeed(rep.speed_mbps)}.`
      );
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setScanningRam(null);
    }
  };

  const handleCancel = async () => {
    try {
      await invokeTauri('cancel_job');
      setJobRunning(false);
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const openTarget = async (target: string) => {
    if (!target) return;
    try {
      await invokeTauri('open_target', { target });
    } catch (err) {
      setErrorMsg(String(err));
    }
  };

  const displayedTracks = useMemo(() => {
    if (progress && progress.tracks && progress.tracks.length > 0) {
      return progress.tracks;
    }
    return analysis?.tracks || [];
  }, [progress, analysis]);

  const navOnline = playlistsData?.navidrome_online ?? analysis?.navidrome_online ?? false;
  const hasNavUrl = Boolean(config.navidrome_url.trim());
  const hasNavDir = Boolean(config.navidrome_music_dir.trim());

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Volume size={20} />
          </div>
          <div>
            <div className="brand-title">Gastinel Music Downloader</div>
            <div className="brand-sub">
              Deezer, YouTube, SoundCloud — Déduplication RAM Rust &amp; Navidrome
            </div>
          </div>
        </div>

        <nav className="nav-tabs">
          <button
            type="button"
            className={`nav-tab ${tab === 'download' ? 'active' : ''}`}
            onClick={() => setTab('download')}
          >
            <ArrowDownBox size={16} />
            <span>Télécharger</span>
          </button>
          <button
            type="button"
            className={`nav-tab ${tab === 'navidrome' ? 'active' : ''}`}
            onClick={() => {
              setTab('navidrome');
              refreshPlaylists();
            }}
          >
            <ListIcon size={16} />
            <span>Playlists &amp; Navidrome</span>
          </button>
          <button
            type="button"
            className={`nav-tab ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            <Gears size={16} />
            <span>Configuration</span>
          </button>
        </nav>

        <div className="status-pills">
          {hasNavUrl && (
            <button
              type="button"
              className={`pill ${navOnline ? 'online' : 'offline'}`}
              onClick={() => openTarget(config.navidrome_url)}
              title="Ouvrir Navidrome dans le navigateur"
            >
              <span className="dot" />
              <span>Navidrome {navOnline ? 'En ligne' : 'Hors ligne'}</span>
              <ExternalLink size={13} />
            </button>
          )}
          {config.local_music_dir && (
            <button
              type="button"
              className="pill"
              onClick={() => openTarget(config.local_music_dir)}
              title={`Ouvrir ${config.local_music_dir}`}
            >
              <Folder size={14} />
              <span>Dossier local</span>
            </button>
          )}
        </div>
      </header>

      <main className="content">
        {!config.configured && tab !== 'settings' && (
          <div className="alert alert-info">
            <Info size={18} />
            <span>
              Première utilisation : vérifie tes dossiers (dossier local ou Navidrome) dans
              l&apos;onglet <strong>Configuration</strong>.
            </span>
          </div>
        )}

        {errorMsg && (
          <div className="alert alert-err">
            <AlertCircle size={18} />
            <span>{errorMsg}</span>
          </div>
        )}
        {infoMsg && (
          <div className="alert alert-ok">
            <Check size={18} />
            <span>{infoMsg}</span>
          </div>
        )}

        {tab === 'download' && (
          <>
            <section className="card">
              <form className="url-bar" onSubmit={handleAnalyze}>
                <div className="input-wrap">
                  <span className="input-icon">
                    <LinkIcon size={17} />
                  </span>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="Colle un lien Deezer (playlist, album, titre), YouTube ou SoundCloud..."
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    disabled={analyzing || jobRunning}
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!urlInput.trim() || analyzing || jobRunning}
                >
                  <Search size={16} />
                  <span>{analyzing ? 'Analyse en cours...' : 'Analyser'}</span>
                </button>
              </form>
            </section>

            {analysis && (
              <section className="card">
                <div className="analysis-grid">
                  <div className="analysis-left">
                    {analysis.cover_url ? (
                      <img className="cover-lg" src={analysis.cover_url} alt={analysis.title} />
                    ) : (
                      <div className="cover-placeholder">
                        <Volume size={26} />
                      </div>
                    )}
                    <div>
                      <div className="meta-title">{analysis.title}</div>
                      <div className="meta-tags">
                        <span className="badge badge-accent">{analysis.source.toUpperCase()}</span>
                        <span className="badge">{analysis.track_count} morceaux</span>
                        <span className="badge">
                          Durée {formatDuration(analysis.total_duration_sec)}
                        </span>
                        {analysis.existing_count > 0 && destMode === 'new' && (
                          <span className="badge badge-ok">
                            {analysis.existing_count} déjà présent(s)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="mode-switch">
                    <button
                      type="button"
                      className={`mode-btn ${destMode === 'new' ? 'active' : ''}`}
                      onClick={() => setDestMode('new')}
                      disabled={jobRunning}
                    >
                      Nouvelle playlist
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${destMode === 'existing' ? 'active' : ''}`}
                      onClick={() => setDestMode('existing')}
                      disabled={jobRunning || !(playlistsData && playlistsData.playlists.length > 0)}
                    >
                      Ajouter à une existante
                    </button>
                  </div>
                </div>

                <div className="kpis">
                  <div className="kpi-box">
                    <div className="kpi-label">Poids estimé avant téléchargement</div>
                    <div className="kpi-val tabular">
                      {formatBytes(analysis.estimated_total_bytes)}
                    </div>
                    <div className="kpi-sub">MP3 320k VBR + pochettes HD</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Morceaux à récupérer</div>
                    <div className="kpi-val tabular">
                      {destMode === 'new'
                        ? `${analysis.track_count - analysis.existing_count} / ${analysis.track_count}`
                        : `${analysis.track_count} (tri RAM Rust)`}
                    </div>
                    <div className="kpi-sub">
                      {destMode === 'new'
                        ? `${analysis.existing_count} ignorés si déjà présents`
                        : 'Contrôle bit-à-bit anti-doublon'}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Espace libre local</div>
                    <div className="kpi-val tabular">
                      {formatBytesShort(analysis.q_free_bytes)}
                    </div>
                    <div className="kpi-sub">{config.local_music_dir || 'Non défini'}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Espace libre Navidrome</div>
                    <div className="kpi-val tabular">
                      {hasNavDir ? formatBytesShort(analysis.y_free_bytes) : 'Non configuré'}
                    </div>
                    <div className="kpi-sub">
                      {hasNavDir ? config.navidrome_music_dir : 'Optionnel (Configuration)'}
                    </div>
                  </div>
                </div>

                <div className="action-row">
                  {destMode === 'new' ? (
                    <div className="folder-field">
                      <span className="folder-prefix">{config.local_music_dir}\</span>
                      <input
                        className="text-input plain"
                        type="text"
                        value={folderName}
                        onChange={(e) => setFolderName(e.target.value)}
                        disabled={jobRunning}
                      />
                    </div>
                  ) : (
                    <div className="folder-field">
                      <span className="folder-prefix">Playlist cible :</span>
                      <select
                        className="select-input"
                        value={targetExistingPlaylist}
                        onChange={(e) => setTargetExistingPlaylist(e.target.value)}
                        disabled={jobRunning}
                      >
                        {(playlistsData?.playlists || []).map((pl) => (
                          <option key={pl.local_path} value={pl.name}>
                            {pl.name} ({pl.track_count} titres — {formatBytesShort(pl.total_bytes)})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {hasNavDir && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoNavidrome}
                        onChange={(e) => setAutoNavidrome(e.target.checked)}
                        disabled={jobRunning}
                      />
                      <span>Synchroniser dans Navidrome</span>
                    </label>
                  )}

                  {!jobRunning ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleStartDownload}
                    >
                      <ArrowDownBox size={16} />
                      <span>
                        {destMode === 'existing'
                          ? 'Télécharger et fusionner (RAM)'
                          : 'Télécharger maintenant'}
                      </span>
                    </button>
                  ) : (
                    <button type="button" className="btn btn-danger" onClick={handleCancel}>
                      <Cross size={16} />
                      <span>Arrêter</span>
                    </button>
                  )}
                </div>
              </section>
            )}

            {progress && (
              <section className="card">
                <div className="progress-header">
                  <div className="progress-title">
                    {progress.phase === 'analyzing' && (
                      <>
                        <Clock size={17} />
                        <span>
                          {progress.message || 'Préparation du téléchargement...'}
                          {progress.folder_name ? ` (${progress.folder_name})` : ''}
                        </span>
                      </>
                    )}
                    {progress.phase === 'ram_dedup' && (
                      <>
                        <Archive size={17} />
                        <span>
                          Vérification bit-à-bit en RAM (Rust) vers {progress.folder_name}...
                        </span>
                      </>
                    )}
                    {progress.phase === 'navidrome_sync' && (
                      <>
                        <Globe size={17} />
                        <span>Synchronisation vers Navidrome ({progress.folder_name})</span>
                      </>
                    )}
                    {progress.phase === 'download' && (
                      <>
                        <ArrowDownBox size={17} />
                        <span>Téléchargement en cours ({progress.folder_name})</span>
                      </>
                    )}
                    {progress.phase === 'done' && (
                      <>
                        <Check size={17} />
                        <span>Opération terminée ({progress.folder_name})</span>
                      </>
                    )}
                  </div>
                  <div className="progress-pct tabular">
                    {safeNum(progress.percent, 0).toFixed(1)} %
                  </div>
                </div>

                <div className="progress-track">
                  <div
                    className={`progress-fill ${progress.phase === 'done' ? 'done' : ''}`}
                    style={{ width: `${Math.min(100, Math.max(0, safeNum(progress.percent, 0)))}%` }}
                  />
                </div>

                <div className="kpis">
                  <div className="kpi-box">
                    <div className="kpi-label">Volume transféré</div>
                    <div className="kpi-val tabular">
                      {formatBytesShort(progress.downloaded_bytes)}
                    </div>
                    <div className="kpi-sub tabular">
                      sur {formatBytes(progress.total_estimated_bytes)}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Temps passé</div>
                    <div className="kpi-val tabular">{formatDuration(progress.elapsed_sec)}</div>
                    <div className="kpi-sub">Depuis le lancement</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">ETA (temps restant)</div>
                    <div className="kpi-val tabular">
                      {progress.phase === 'done' ? '00:00' : formatDuration(progress.eta_sec)}
                    </div>
                    <div className="kpi-sub tabular">Débit : {formatSpeed(progress.speed_bps)}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Avancement morceaux</div>
                    <div className="kpi-val tabular">
                      {progress.completed_tracks} / {progress.total_tracks}
                    </div>
                    <div className="kpi-sub">
                      {progress.failed_tracks > 0
                        ? `${progress.failed_tracks} erreur(s)`
                        : 'Aucune erreur'}
                    </div>
                  </div>
                </div>

                {progress.phase === 'done' && !jobRunning && progress.folder_name && (
                  <div className="action-row">
                    <div className="alert alert-info" style={{ flex: 1 }}>
                      <Info size={16} />
                      <span>
                        Fichiers prêts pour {progress.folder_name}.
                        {progress.navidrome_m3u ? ' Playlist .m3u8 mise à jour sur Navidrome.' : ''}
                      </span>
                    </div>
                    {hasNavDir && !progress.navidrome_m3u && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleSyncNavidrome(progress.folder_name!)}
                      >
                        <Plus size={16} />
                        <span>Ajouter à Navidrome</span>
                      </button>
                    )}
                    {hasNavUrl && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => openTarget(config.navidrome_url)}
                      >
                        <ExternalLink size={16} />
                        <span>Ouvrir Navidrome</span>
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            {dedupReport && (
              <section className="card">
                <div className="section-head">
                  <div className="section-title">
                    <Archive size={18} />
                    <span>
                      Rapport vérification bit-à-bit en RAM (Rust) — {dedupReport.target_playlist}
                    </span>
                  </div>
                  <span className="badge badge-ok">
                    {formatRamSpeed(dedupReport.speed_mbps)} en {dedupReport.duration_ms} ms
                  </span>
                </div>

                <div className="kpis" style={{ marginTop: 0 }}>
                  <div className="kpi-box">
                    <div className="kpi-label">Vitesse RAM mesurée</div>
                    <div className="kpi-val tabular">{formatRamSpeed(dedupReport.speed_mbps)}</div>
                    <div className="kpi-sub tabular">Durée : {dedupReport.duration_ms} ms</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Données comparées en RAM</div>
                    <div className="kpi-val tabular">
                      {formatBytesShort(dedupReport.bytes_verified_ram)}
                    </div>
                    <div className="kpi-sub tabular">
                      {dedupReport.scanned_files} fichier(s) analysé(s)
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Nouveaux titres ajoutés</div>
                    <div className="kpi-val tabular">{dedupReport.added_files}</div>
                    <div className="kpi-sub">
                      {dedupReport.m3u8_updated ? 'Playlist .m3u8 mise à jour' : 'Scan seul'}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Doublons exacts bloqués</div>
                    <div className="kpi-val tabular">{dedupReport.duplicates_skipped}</div>
                    <div className="kpi-sub">Identiques bit-à-bit en RAM</div>
                  </div>
                </div>

                {dedupReport.duplicates.length > 0 && (
                  <div className="table-wrap">
                    <div className="tracks-scroll" style={{ maxHeight: 180 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Fichier candidat / doublon</th>
                            <th>Identique à l&apos;existant</th>
                            <th style={{ width: 110 }}>Taille</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dedupReport.duplicates.map((d, i) => (
                            <tr key={`${d.candidate_file}-${i}`}>
                              <td className="track-name">{d.candidate_file}</td>
                              <td className="track-sub">{d.existing_file}</td>
                              <td className="tabular">{formatBytesShort(d.size_bytes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </section>
            )}

            {displayedTracks.length > 0 && (
              <section className="card">
                <div className="section-head">
                  <div className="section-title">
                    <ListIcon size={17} />
                    <span>Morceaux ({displayedTracks.length})</span>
                  </div>
                </div>
                <div className="table-wrap">
                  <div className="tracks-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 46 }}>#</th>
                          <th>Titre &amp; Artiste</th>
                          <th style={{ width: 90 }}>Durée</th>
                          <th style={{ width: 110 }}>Taille</th>
                          <th style={{ width: 150 }}>Statut</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedTracks.map((tr) => {
                          const st = statusLabel(
                            tr.status || (tr.already_exists ? 'skipped' : 'waiting')
                          );
                          const bytesVal =
                            tr.status === 'done' || tr.status === 'skipped'
                              ? tr.size_bytes || tr.existing_bytes || tr.estimated_bytes
                              : tr.estimated_bytes;
                          return (
                            <tr key={`${tr.index}-${tr.filename}`}>
                              <td className="tabular">{tr.index}</td>
                              <td>
                                <div className="track-cell">
                                  {tr.cover_url ? (
                                    <img className="thumb-sm" src={tr.cover_url} alt={tr.title} />
                                  ) : (
                                    <div className="thumb-sm" />
                                  )}
                                  <div>
                                    <div className="track-name">{tr.title}</div>
                                    <div className="track-sub">
                                      {tr.artist}
                                      {tr.album ? ` — ${tr.album}` : ''}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="tabular">
                                {tr.duration > 0 ? formatDuration(tr.duration) : '—'}
                              </td>
                              <td className="tabular">{formatBytesShort(bytesVal)}</td>
                              <td>
                                <span className={`badge ${st.cls}`}>
                                  {st.text}
                                  {tr.status === 'downloading' &&
                                  typeof tr.percent === 'number' &&
                                  tr.percent > 0
                                    ? ` (${tr.percent.toFixed(0)}%)`
                                    : ''}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}

            {!analysis && !progress && (
              <section className="card empty-state">
                <Play size={28} />
                <p style={{ marginTop: 10, marginBottom: 4, fontWeight: 600, color: '#111827' }}>
                  Colle un lien ci-dessus pour estimer le poids (Mo / Go) et télécharger
                </p>
                <p style={{ margin: 0, fontSize: 13 }}>
                  Compatible Deezer, YouTube et SoundCloud — création ou fusion sans doublon en RAM.
                </p>
              </section>
            )}
          </>
        )}

        {tab === 'navidrome' && (
          <>
            <section className="card">
              <div className="section-head">
                <div className="section-title">
                  <Globe size={18} />
                  <span>Playlists locales &amp; Synchronisation Navidrome</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={refreshPlaylists}
                    disabled={loadingPlaylists}
                  >
                    <Clock size={14} />
                    <span>{loadingPlaylists ? 'Actualisation...' : 'Actualiser'}</span>
                  </button>
                  {hasNavUrl && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openTarget(config.navidrome_url)}
                    >
                      <ExternalLink size={14} />
                      <span>Ouvrir Navidrome</span>
                    </button>
                  )}
                </div>
              </div>

              {playlistsData && (
                <div className="kpis" style={{ marginTop: 0, marginBottom: 14 }}>
                  <div className="kpi-box">
                    <div className="kpi-label">Serveur Navidrome</div>
                    <div className="kpi-val">
                      {hasNavUrl ? (playlistsData.navidrome_online ? 'En ligne' : 'Hors ligne') : 'Non configuré'}
                    </div>
                    <div className="kpi-sub">{config.navidrome_url || 'Définir dans Configuration'}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Playlists détectées</div>
                    <div className="kpi-val tabular">{playlistsData.playlists.length}</div>
                    <div className="kpi-sub">{config.local_music_dir}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Espace libre local</div>
                    <div className="kpi-val tabular">
                      {formatBytesShort(playlistsData.q_free_bytes)}
                    </div>
                    <div className="kpi-sub">Disque local</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Espace libre Navidrome</div>
                    <div className="kpi-val tabular">
                      {hasNavDir ? formatBytesShort(playlistsData.y_free_bytes) : '—'}
                    </div>
                    <div className="kpi-sub">{config.navidrome_music_dir || 'Optionnel'}</div>
                  </div>
                </div>
              )}

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Playlist</th>
                      <th style={{ width: 90 }}>Titres</th>
                      <th style={{ width: 110 }}>Taille</th>
                      <th style={{ width: 175 }}>État Navidrome</th>
                      <th style={{ width: 320, textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(playlistsData?.playlists || []).map((pl) => (
                      <tr key={pl.local_path}>
                        <td>
                          <div className="track-name">{pl.name}</div>
                          <div className="track-sub">{pl.local_path}</div>
                        </td>
                        <td className="tabular">{pl.track_count}</td>
                        <td className="tabular">{formatBytesShort(pl.total_bytes)}</td>
                        <td>
                          {!hasNavDir ? (
                            <span className="badge">Local uniquement</span>
                          ) : pl.synced ? (
                            <span className="badge badge-ok">
                              Synchronisée ({pl.nas_track_count}/{pl.track_count})
                            </span>
                          ) : (
                            <span className="badge badge-warn">
                              À synchroniser ({pl.nas_track_count}/{pl.track_count})
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => openTarget(pl.local_path)}
                              title="Ouvrir le dossier local"
                            >
                              <Folder size={14} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={scanningRam !== null}
                              onClick={() => handleScanRam(pl.name)}
                              title="Vérifier doublons bit-à-bit en RAM (Rust)"
                            >
                              <Archive size={14} />
                              <span>{scanningRam === pl.name ? 'Scan...' : 'Vérif. RAM'}</span>
                            </button>
                            {hasNavDir && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={jobRunning}
                                onClick={() => handleSyncNavidrome(pl.name)}
                              >
                                <Plus size={14} />
                                <span>{pl.synced ? 'Re-sync' : 'Navidrome'}</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!playlistsData || playlistsData.playlists.length === 0) && (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: '#5b6474' }}>
                          Aucune playlist trouvée dans {config.local_music_dir || 'le dossier local'}.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {dedupReport && (
              <section className="card">
                <div className="section-head">
                  <div className="section-title">
                    <Archive size={18} />
                    <span>Rapport vérification RAM — {dedupReport.target_playlist}</span>
                  </div>
                  <span className="badge badge-ok">
                    {formatRamSpeed(dedupReport.speed_mbps)} en {dedupReport.duration_ms} ms
                  </span>
                </div>
                <div className="kpis" style={{ marginTop: 0 }}>
                  <div className="kpi-box">
                    <div className="kpi-label">Vitesse RAM</div>
                    <div className="kpi-val tabular">{formatRamSpeed(dedupReport.speed_mbps)}</div>
                    <div className="kpi-sub tabular">{dedupReport.duration_ms} ms</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Données vérifiées</div>
                    <div className="kpi-val tabular">
                      {formatBytesShort(dedupReport.bytes_verified_ram)}
                    </div>
                    <div className="kpi-sub tabular">{dedupReport.scanned_files} pistes</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Doublons exacts</div>
                    <div className="kpi-val tabular">{dedupReport.duplicates_skipped}</div>
                    <div className="kpi-sub">Comparaison bit-à-bit</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Pistes uniques</div>
                    <div className="kpi-val tabular">
                      {dedupReport.scanned_files - dedupReport.duplicates_skipped}
                    </div>
                    <div className="kpi-sub">Intégrité validée</div>
                  </div>
                </div>
              </section>
            )}
          </>
        )}

        {tab === 'settings' && (
          <section className="card">
            <div className="section-head">
              <div className="section-title">
                <Gears size={18} />
                <span>Configuration &amp; Prérequis</span>
              </div>
            </div>

            <div className="alert alert-info" style={{ marginBottom: 16 }}>
              <Info size={18} />
              <span>
                Prérequis : Python 3.10+ (`yt-dlp`, `mutagen`, `requests`), `ffmpeg` dans le PATH,
                et un dossier de musique local (plus un dossier/URL Navidrome si tu souhaites la
                synchronisation automatique).
              </span>
            </div>

            <form className="form-grid" onSubmit={handleSaveConfig}>
              <div className="field-group">
                <label className="field-label">Dossier local des musiques (obligatoire)</label>
                <input
                  className="text-input plain"
                  type="text"
                  required
                  placeholder="Ex : Q:\Musiques ou C:\Users\Nom\Music"
                  value={config.local_music_dir}
                  onChange={(e) => setConfig({ ...config, local_music_dir: e.target.value })}
                />
                <span className="field-help">
                  Emplacement où chaque playlist téléchargée sera enregistrée en MP3 320k.
                </span>
              </div>

              <div className="field-group">
                <label className="field-label">
                  Dossier bibliothèque Navidrome / NAS (optionnel)
                </label>
                <input
                  className="text-input plain"
                  type="text"
                  placeholder="Ex : Y:\musique (laisser vide si pas de Navidrome)"
                  value={config.navidrome_music_dir}
                  onChange={(e) => setConfig({ ...config, navidrome_music_dir: e.target.value })}
                />
                <span className="field-help">
                  Dossier monté ou partagé lu par Navidrome (les MP3 et fichiers .m3u8 y seront
                  copiés).
                </span>
              </div>

              <div className="field-group">
                <label className="field-label">URL du serveur Navidrome (optionnel)</label>
                <input
                  className="text-input plain"
                  type="text"
                  placeholder="Ex : http://192.168.1.X:4533/"
                  value={config.navidrome_url}
                  onChange={(e) => setConfig({ ...config, navidrome_url: e.target.value })}
                />
                <span className="field-help">
                  Utilisée pour vérifier l&apos;état en ligne et ouvrir ton interface Navidrome en 1
                  clic.
                </span>
              </div>

              <div className="field-group">
                <label className="field-label">
                  Dossier secondaire pour les playlists .m3u8 (optionnel)
                </label>
                <input
                  className="text-input plain"
                  type="text"
                  placeholder="Ex : C:\Users\Nom\Music\Playlists"
                  value={config.user_playlists_dir}
                  onChange={(e) => setConfig({ ...config, user_playlists_dir: e.target.value })}
                />
              </div>

              <div className="action-row" style={{ marginTop: 6 }}>
                <span className="field-help">
                  Stockée localement dans %APPDATA%\me.gastinel.musicdl\config.json
                </span>
                <button type="submit" className="btn btn-primary" disabled={savingConfig}>
                  <Check size={16} />
                  <span>{savingConfig ? 'Enregistrement...' : 'Enregistrer la configuration'}</span>
                </button>
              </div>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
