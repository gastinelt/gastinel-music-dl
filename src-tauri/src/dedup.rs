use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DuplicateMatch {
    pub candidate_file: String,
    pub existing_file: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DedupReport {
    pub target_playlist: String,
    pub scanned_files: usize,
    pub existing_files: usize,
    pub added_files: usize,
    pub duplicates_skipped: usize,
    pub bytes_verified_ram: u64,
    pub duration_ms: u128,
    pub speed_mbps: f64,
    pub duplicates: Vec<DuplicateMatch>,
    pub added_list: Vec<String>,
    pub m3u8_updated: bool,
}

fn read_file_into_ram(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path)
        .map_err(|e| format!("Impossible d'ouvrir {}: {}", path.display(), e))?;
    let meta_len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let mut buf = Vec::with_capacity(meta_len);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("Erreur lecture RAM {}: {}", path.display(), e))?;
    Ok(buf)
}

fn collect_mp3_paths(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("mp3") {
                        out.push(p);
                    }
                }
            }
        }
    }
    out.sort();
    out
}

/// Compare two byte slices bit-for-bit in RAM.
#[inline]
fn exact_ram_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a == b
}

/// Merge candidate MP3s from `source_dir` into `target_dir` using exact bit-by-bit
/// RAM verification to block all binary duplicates, measuring throughput speed.
pub fn merge_with_ram_dedup(
    source_dir: &Path,
    target_dir: &Path,
    target_playlist_name: &str,
    remove_source_after: bool,
) -> Result<DedupReport, String> {
    if !source_dir.is_dir() {
        return Err(format!("Dossier source introuvable: {}", source_dir.display()));
    }
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("Impossible de créer {}: {}", target_dir.display(), e))?;

    let started = Instant::now();
    let existing_paths = collect_mp3_paths(target_dir);
    let candidate_paths = collect_mp3_paths(source_dir);

    let mut bytes_verified_ram: u64 = 0;

    // Index existing files by exact byte length, loading bytes into RAM lazily on size collision
    let mut by_size: HashMap<u64, Vec<(PathBuf, Option<Vec<u8>>)>> = HashMap::new();
    for p in &existing_paths {
        let len = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        by_size.entry(len).or_default().push((p.clone(), None));
    }

    let mut duplicates: Vec<DuplicateMatch> = Vec::new();
    let mut added_list: Vec<String> = Vec::new();

    for cand_path in &candidate_paths {
        let cand_len = fs::metadata(cand_path).map(|m| m.len()).unwrap_or(0);
        let cand_name = cand_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("piste.mp3")
            .to_string();

        let cand_bytes = read_file_into_ram(cand_path)?;
        bytes_verified_ram += cand_bytes.len() as u64;

        let mut matched_existing: Option<String> = None;
        if let Some(bucket) = by_size.get_mut(&cand_len) {
            for (ex_path, cached_opt) in bucket.iter_mut() {
                if cached_opt.is_none() {
                    let loaded = read_file_into_ram(ex_path)?;
                    bytes_verified_ram += loaded.len() as u64;
                    *cached_opt = Some(loaded);
                }
                if let Some(ex_bytes) = cached_opt.as_ref() {
                    if exact_ram_equal(&cand_bytes, ex_bytes) {
                        matched_existing = Some(
                            ex_path
                                .file_name()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string(),
                        );
                        break;
                    }
                }
            }
        }

        if let Some(ex_name) = matched_existing {
            duplicates.push(DuplicateMatch {
                candidate_file: cand_name,
                existing_file: ex_name,
                size_bytes: cand_len,
            });
            if remove_source_after {
                let _ = fs::remove_file(cand_path);
            }
        } else {
            // Ensure unique filename in target_dir if same name with different audio content
            let mut dest_path = target_dir.join(&cand_name);
            if dest_path.exists() {
                let stem = cand_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("piste");
                let mut n = 2usize;
                loop {
                    let try_name = format!("{} ({}).mp3", stem, n);
                    let try_path = target_dir.join(&try_name);
                    if !try_path.exists() {
                        dest_path = try_path;
                        break;
                    }
                    n += 1;
                }
            }

            fs::write(&dest_path, &cand_bytes)
                .map_err(|e| format!("Erreur écriture {}: {}", dest_path.display(), e))?;
            bytes_verified_ram += cand_bytes.len() as u64;

            let final_name = dest_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&cand_name)
                .to_string();
            added_list.push(final_name);

            by_size
                .entry(cand_len)
                .or_default()
                .push((dest_path, Some(cand_bytes)));

            if remove_source_after {
                let _ = fs::remove_file(cand_path);
            }
        }
    }

    if remove_source_after {
        let _ = fs::remove_dir_all(source_dir);
    }

    let elapsed = started.elapsed();
    let duration_ms = elapsed.as_millis().max(1);
    let secs = elapsed.as_secs_f64().max(0.0001);
    let speed_mbps = (bytes_verified_ram as f64 / (1024.0 * 1024.0)) / secs;

    Ok(DedupReport {
        target_playlist: target_playlist_name.to_string(),
        scanned_files: candidate_paths.len(),
        existing_files: existing_paths.len(),
        added_files: added_list.len(),
        duplicates_skipped: duplicates.len(),
        bytes_verified_ram,
        duration_ms,
        speed_mbps,
        duplicates,
        added_list,
        m3u8_updated: false,
    })
}

/// Scan a single playlist directory bit-by-bit in RAM to detect any identical files.
pub fn scan_playlist_ram(target_dir: &Path, playlist_name: &str) -> Result<DedupReport, String> {
    if !target_dir.is_dir() {
        return Err(format!("Dossier introuvable: {}", target_dir.display()));
    }
    let started = Instant::now();
    let files = collect_mp3_paths(target_dir);
    let mut bytes_verified_ram: u64 = 0;

    let mut by_size: HashMap<u64, Vec<(PathBuf, Option<Vec<u8>>)>> = HashMap::new();
    for p in &files {
        let len = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        by_size.entry(len).or_default().push((p.clone(), None));
    }

    let mut duplicates: Vec<DuplicateMatch> = Vec::new();
    for (_len, group) in by_size.iter_mut() {
        if group.len() < 2 {
            // Still read for full RAM integrity/speed benchmark
            if let Some((p, _)) = group.first() {
                if let Ok(b) = read_file_into_ram(p) {
                    bytes_verified_ram += b.len() as u64;
                }
            }
            continue;
        }
        let mut uniques: Vec<(String, Vec<u8>)> = Vec::new();
        for (p, _) in group.iter() {
            let b = read_file_into_ram(p)?;
            bytes_verified_ram += b.len() as u64;
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if let Some((orig_name, _)) = uniques.iter().find(|(_, ub)| exact_ram_equal(&b, ub)) {
                duplicates.push(DuplicateMatch {
                    candidate_file: name,
                    existing_file: orig_name.clone(),
                    size_bytes: b.len() as u64,
                });
            } else {
                uniques.push((name, b));
            }
        }
    }

    let elapsed = started.elapsed();
    let duration_ms = elapsed.as_millis().max(1);
    let secs = elapsed.as_secs_f64().max(0.0001);
    let speed_mbps = (bytes_verified_ram as f64 / (1024.0 * 1024.0)) / secs;

    Ok(DedupReport {
        target_playlist: playlist_name.to_string(),
        scanned_files: files.len(),
        existing_files: files.len(),
        added_files: 0,
        duplicates_skipped: duplicates.len(),
        bytes_verified_ram,
        duration_ms,
        speed_mbps,
        duplicates,
        added_list: Vec::new(),
        m3u8_updated: false,
    })
}
