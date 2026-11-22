use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub local_music_dir: String,
    pub navidrome_music_dir: String,
    pub navidrome_url: String,
    pub user_playlists_dir: String,
    pub configured: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        let default_music = std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join("Music").to_string_lossy().to_string())
            .unwrap_or_else(|_| "Music".to_string());
        Self {
            local_music_dir: default_music,
            navidrome_music_dir: String::new(),
            navidrome_url: String::new(),
            user_playlists_dir: String::new(),
            configured: false,
        }
    }
}

pub fn config_file_path() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .map_err(|_| "Variable APPDATA introuvable".to_string())?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".config"))
        .map_err(|_| "Variable HOME introuvable".to_string())?;

    Ok(base.join("me.gastinel.musicdl").join("config.json"))
}

pub fn load_config() -> AppConfig {
    if let Ok(path) = config_file_path() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                return cfg;
            }
        }
    }
    AppConfig::default()
}

pub fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Impossible de créer le dossier config: {}", e))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Erreur sérialisation config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Impossible d'enregistrer config.json: {}", e))
}
