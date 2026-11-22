pub mod config;
pub mod dedup;

use config::{load_config, save_config, AppConfig};
use dedup::{merge_with_ram_dedup, scan_playlist_ram, DedupReport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct JobSnapshot {
    pub running: bool,
    pub mode: String,
    pub child_pid: Option<u32>,
    pub progress: Value,
    pub dedup_report: Option<DedupReport>,
    pub error: Option<String>,
}

pub struct AppState {
    pub job: Arc<Mutex<JobSnapshot>>,
}

fn find_worker_script() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("worker").join("engine.py"));
            candidates.push(dir.join("..").join("worker").join("engine.py"));
            candidates.push(dir.join("..").join("..").join("worker").join("engine.py"));
            candidates.push(dir.join("..").join("..").join("..").join("worker").join("engine.py"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("worker").join("engine.py"));
        candidates.push(cwd.join("..").join("worker").join("engine.py"));
    }

    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("Script moteur introuvable (worker/engine.py)".to_string())
}

fn build_python_command(script: &PathBuf, args: &[&str], cfg: &AppConfig) -> Command {
    let mut cmd = Command::new("python");
    cmd.arg("-u").arg(script);
    for a in args {
        cmd.arg(a);
    }
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("GMD_LOCAL_DIR", &cfg.local_music_dir);
    cmd.env("GMD_NAVIDROME_DIR", &cfg.navidrome_music_dir);
    cmd.env("GMD_USER_PLAYLISTS_DIR", &cfg.user_playlists_dir);
    cmd.env("GMD_NAVIDROME_URL", &cfg.navidrome_url);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn run_sync_worker(args: &[&str]) -> Result<Value, String> {
    let script = find_worker_script()?;
    let cfg = load_config();
    let output = build_python_command(&script, args, &cfg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Impossible de lancer Python: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut last_event: Option<Value> = None;
    for line in stdout.lines() {
        if let Some(json_str) = line.strip_prefix("EVENT:") {
            if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                last_event = Some(val);
            }
        }
    }

    if let Some(ev) = last_event {
        if ev.get("type").and_then(|v| v.as_str()) == Some("error") {
            let msg = ev
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Erreur inconnue du moteur");
            return Err(msg.to_string());
        }
        return Ok(ev.get("data").cloned().unwrap_or(ev));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "Sortie moteur invalide (code {:?}): {}",
        output.status.code(),
        stderr.trim()
    ))
}

fn resolve_local_playlist_dir(cfg: &AppConfig, playlist_name: &str) -> PathBuf {
    let root = PathBuf::from(&cfg.local_music_dir);
    let direct = root.join(playlist_name);
    if direct.is_dir() {
        return direct;
    }
    let phonk_sub = root.join("Phonk").join(playlist_name);
    if phonk_sub.is_dir() {
        return phonk_sub;
    }
    direct
}

#[tauri::command]
fn get_config() -> AppConfig {
    load_config()
}

#[tauri::command]
fn save_app_config(cfg: AppConfig) -> Result<(), String> {
    let mut updated = cfg;
    updated.configured = true;
    save_config(&updated)
}

#[tauri::command]
async fn analyze_url(url: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_sync_worker(&["analyze", url.trim()]))
        .await
        .map_err(|e| format!("Erreur tâche analyse: {}", e))?
}

#[tauri::command]
async fn list_playlists() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| run_sync_worker(&["list_playlists"]))
        .await
        .map_err(|e| format!("Erreur tâche liste: {}", e))?
}

#[tauri::command]
async fn scan_playlist_duplicates(playlist_name: String) -> Result<DedupReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config();
        let target_dir = resolve_local_playlist_dir(&cfg, playlist_name.trim());
        scan_playlist_ram(&target_dir, playlist_name.trim())
    })
    .await
    .map_err(|e| format!("Erreur scan RAM: {}", e))?
}

fn spawn_background_job(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    args: Vec<String>,
) -> Result<(), String> {
    let script = find_worker_script()?;
    let cfg = load_config();
    let mut guard = state.job.lock().map_err(|_| "Verrou d'état occupé")?;
    if guard.running {
        return Err("Une opération est déjà en cours. Arrête-la avant d'en lancer une autre.".to_string());
    }

    guard.running = true;
    guard.mode = mode.clone();
    guard.error = None;
    guard.dedup_report = None;
    guard.progress = serde_json::json!({
        "type": "progress",
        "phase": if mode == "download" { "analyzing" } else { "navidrome_sync" },
        "percent": 0.0,
        "downloaded_bytes": 0,
        "total_estimated_bytes": 0,
        "speed_bps": 0.0,
        "elapsed_sec": 0,
        "eta_sec": 0,
        "completed_tracks": 0,
        "total_tracks": 0,
        "failed_tracks": 0,
        "tracks": []
    });

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let mut child = build_python_command(&script, &arg_refs, &cfg)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            guard.running = false;
            format!("Échec lancement Python: {}", e)
        })?;

    let pid = child.id();
    guard.child_pid = Some(pid);
    drop(guard);

    let shared_job = Arc::clone(&state.job);
    std::thread::spawn(move || {
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(json_str) = line.strip_prefix("EVENT:") {
                    if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                        let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if let Ok(mut st) = shared_job.lock() {
                            if ev_type == "error" {
                                st.error = val
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                            } else if ev_type == "progress" {
                                st.progress = val.clone();
                            } else if ev_type == "status" {
                                if let Some(obj) = st.progress.as_object_mut() {
                                    if let Some(p) = val.get("phase").cloned() {
                                        obj.insert("phase".to_string(), p);
                                    }
                                    if let Some(m) = val.get("message").cloned() {
                                        obj.insert("message".to_string(), m);
                                    }
                                }
                            }
                        }
                        let _ = app.emit("dl-progress", &val);
                    }
                }
            }
        }

        let _ = child.wait();
        if let Ok(mut st) = shared_job.lock() {
            st.running = false;
            st.child_pid = None;
        }
        let _ = app.emit("dl-finished", serde_json::json!({ "done": true }));
    });

    Ok(())
}

#[tauri::command]
fn start_download(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    folder_name: String,
    auto_navidrome: bool,
) -> Result<(), String> {
    let auto_flag = if auto_navidrome { "1" } else { "0" };
    spawn_background_job(
        app,
        state,
        "download".to_string(),
        vec![
            "download".to_string(),
            url.trim().to_string(),
            folder_name.trim().to_string(),
            auto_flag.to_string(),
        ],
    )
}

#[tauri::command]
fn start_merge_download(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    target_playlist: String,
    auto_navidrome: bool,
) -> Result<(), String> {
    let script = find_worker_script()?;
    let cfg = load_config();

    let mut guard = state.job.lock().map_err(|_| "Verrou d'état occupé")?;
    if guard.running {
        return Err("Une opération est déjà en cours. Arrête-la avant d'en lancer une autre.".to_string());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let staging_name = format!("_staging_{}", ts);

    guard.running = true;
    guard.mode = "merge_download".to_string();
    guard.error = None;
    guard.dedup_report = None;
    guard.progress = serde_json::json!({
        "type": "progress",
        "phase": "analyzing",
        "folder_name": target_playlist.trim(),
        "message": "Préparation de l'ajout vers playlist existante...",
        "percent": 0.0,
        "downloaded_bytes": 0,
        "total_estimated_bytes": 0,
        "speed_bps": 0.0,
        "elapsed_sec": 0,
        "eta_sec": 0,
        "completed_tracks": 0,
        "total_tracks": 0,
        "failed_tracks": 0,
        "tracks": []
    });

    let mut child = build_python_command(
        &script,
        &["download", url.trim(), &staging_name, "0"],
        &cfg,
    )
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| {
        guard.running = false;
        format!("Échec lancement Python: {}", e)
    })?;

    guard.child_pid = Some(child.id());
    drop(guard);

    let shared_job = Arc::clone(&state.job);
    let target_name = target_playlist.trim().to_string();
    std::thread::spawn(move || {
        let mut had_error = false;
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(json_str) = line.strip_prefix("EVENT:") {
                    if let Ok(mut val) = serde_json::from_str::<Value>(json_str) {
                        let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ev_type == "error" {
                            had_error = true;
                            if let Ok(mut st) = shared_job.lock() {
                                st.error = val
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                            }
                        } else if ev_type == "progress" {
                            if val.get("phase").and_then(|v| v.as_str()) == Some("done") {
                                if let Some(obj) = val.as_object_mut() {
                                    obj.insert(
                                        "phase".to_string(),
                                        Value::String("ram_dedup".to_string()),
                                    );
                                    obj.insert(
                                        "folder_name".to_string(),
                                        Value::String(target_name.clone()),
                                    );
                                }
                            } else if let Some(obj) = val.as_object_mut() {
                                obj.insert(
                                    "folder_name".to_string(),
                                    Value::String(target_name.clone()),
                                );
                            }
                            if let Ok(mut st) = shared_job.lock() {
                                st.progress = val.clone();
                            }
                        }
                        let _ = app.emit("dl-progress", &val);
                    }
                }
            }
        }

        let status = child.wait();
        let ok_exit = status.map(|s| s.success()).unwrap_or(false);

        if ok_exit && !had_error {
            let staging_dir = PathBuf::from(&cfg.local_music_dir).join(&staging_name);
            let target_dir = resolve_local_playlist_dir(&cfg, &target_name);
            match merge_with_ram_dedup(&staging_dir, &target_dir, &target_name, true) {
                Ok(mut report) => {
                    let sync_flag = if auto_navidrome && !cfg.navidrome_music_dir.trim().is_empty()
                    {
                        "1"
                    } else {
                        "0"
                    };
                    if run_sync_worker(&["rebuild_m3u8", &target_name, sync_flag]).is_ok() {
                        report.m3u8_updated = true;
                    }
                    if auto_navidrome && !cfg.navidrome_music_dir.trim().is_empty() {
                        let _ = run_sync_worker(&["sync_navidrome", &target_name]);
                    }
                    if let Ok(mut st) = shared_job.lock() {
                        st.dedup_report = Some(report);
                        if let Some(obj) = st.progress.as_object_mut() {
                            obj.insert("phase".to_string(), Value::String("done".to_string()));
                            obj.insert("percent".to_string(), serde_json::json!(100.0));
                            obj.insert("eta_sec".to_string(), serde_json::json!(0));
                        }
                    }
                }
                Err(e) => {
                    if let Ok(mut st) = shared_job.lock() {
                        st.error = Some(e);
                    }
                }
            }
        }

        if let Ok(mut st) = shared_job.lock() {
            st.running = false;
            st.child_pid = None;
        }
        let _ = app.emit("dl-finished", serde_json::json!({ "done": true }));
    });

    Ok(())
}

#[tauri::command]
fn sync_to_navidrome(
    app: AppHandle,
    state: State<'_, AppState>,
    folder_name: String,
) -> Result<(), String> {
    spawn_background_job(
        app,
        state,
        "sync_navidrome".to_string(),
        vec!["sync_navidrome".to_string(), folder_name.trim().to_string()],
    )
}

#[tauri::command]
fn get_job_status(state: State<'_, AppState>) -> Result<JobSnapshot, String> {
    let guard = state.job.lock().map_err(|_| "Verrou d'état occupé")?;
    Ok(guard.clone())
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>) -> Result<bool, String> {
    let pid_opt = {
        let mut guard = state.job.lock().map_err(|_| "Verrou d'état occupé")?;
        let p = guard.child_pid;
        guard.running = false;
        guard.child_pid = None;
        guard.error = Some("Opération annulée par l'utilisateur.".to_string());
        p
    };

    if let Some(pid) = pid_opt {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        }
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &target]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("Impossible d'ouvrir {}: {}", target, e))?;
    }
    Ok(())
}

#[cfg(windows)]
fn cleanup_stale_instances() {
    let self_pid = std::process::id();
    let ps_cmd = format!(
        "Get-Process -Name 'GastinelMusicDL','gastinel-music-dl' -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne {} }} | Select-Object -ExpandProperty Id",
        self_pid
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &ps_cmd]);
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(out) = cmd.output() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut killed_any = false;
        for line in stdout.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                let mut tk = Command::new("taskkill");
                tk.args(["/F", "/T", "/PID", &pid.to_string()]);
                tk.creation_flags(CREATE_NO_WINDOW);
                let _ = tk.output();
                killed_any = true;
            }
        }
        if killed_any {
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }
}

#[cfg(not(windows))]
fn cleanup_stale_instances() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_stale_instances();

    tauri::Builder::default()
        .manage(AppState {
            job: Arc::new(Mutex::new(JobSnapshot::default())),
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_app_config,
            analyze_url,
            list_playlists,
            scan_playlist_duplicates,
            start_download,
            start_merge_download,
            sync_to_navidrome,
            get_job_status,
            cancel_job,
            open_target,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur lors du démarrage de Gastinel Music Downloader");
}
