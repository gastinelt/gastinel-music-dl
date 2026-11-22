import io
import json
import os
import re
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import parse_qs, urlparse

# Force UTF-8 on Windows stdio so Tauri reads clean JSON lines
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
else:
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import requests
import yt_dlp
from mutagen.id3 import APIC, TALB, TIT2, TPE1, TRCK
from mutagen.mp3 import MP3

LOCAL_MUSIC_ROOT = os.environ.get("GMD_LOCAL_DIR") or os.path.join(os.path.expanduser("~"), "Music")
NAVIDROME_MUSIC_ROOT = os.environ.get("GMD_NAVIDROME_DIR") or ""
USER_PLAYLISTS_ROOT = os.environ.get("GMD_USER_PLAYLISTS_DIR") or ""
NAVIDROME_URL = os.environ.get("GMD_NAVIDROME_URL") or ""

BAD_KEYWORDS = [
    "live",
    "cover",
    "karaoke",
    "reaction",
    "instrumental",
    "slowed",
    "sped up",
    "nightcore",
    "8d",
    "1 hour",
    "remix",
    "concert",
    "acoustic",
]

emit_lock = threading.Lock()


def emit(payload: dict) -> None:
    """Emit a single JSON event line prefixed with EVENT: for Rust IPC parsing."""
    with emit_lock:
        sys.stdout.write("EVENT:" + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def sanitize_filename(name: str) -> str:
    """Sanitize a track or folder name for Windows & Linux filesystems."""
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", name or "Sans titre")
    cleaned = re.sub(r"\s+", " ", cleaned).strip().rstrip(".")
    return cleaned or "Sans titre"


def estimate_track_bytes(duration_sec: int, is_deezer: bool) -> int:
    """Estimate MP3 320k VBR0 + HD cover size in bytes before downloading."""
    dur = duration_sec if duration_sec and duration_sec > 0 else 165
    cover_overhead = 180_000 if is_deezer else 150_000
    return int(dur * 34_000 + cover_overhead)


def get_disk_free_bytes(path: str) -> int:
    """Return free bytes on the target drive, or -1 if unreachable."""
    try:
        target = path
        while target and not os.path.exists(target):
            parent = os.path.dirname(target)
            if parent == target:
                break
            target = parent
        if not target or not os.path.exists(target):
            drive = os.path.splitdrive(path)[0]
            if drive:
                target = drive + "\\"
        if os.path.exists(target):
            return int(shutil.disk_usage(target).free)
    except Exception:
        pass
    return -1


def check_navidrome_online() -> bool:
    """Check if Navidrome responds HTTP 200/302 on the configured URL."""
    if not NAVIDROME_URL:
        return False
    try:
        r = requests.get(NAVIDROME_URL, timeout=2.5, allow_redirects=True)
        return r.status_code < 400
    except Exception:
        return False


def resolve_url(url: str) -> str:
    """Resolve short links such as link.deezer.com/s/... or deezer.page.link."""
    url = url.strip()
    if any(h in url.lower() for h in ("link.deezer.com", "deezer.page.link", "bit.ly", "tinyurl.com")):
        try:
            r = requests.get(
                url,
                allow_redirects=True,
                timeout=10,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            final_url = r.url
            parsed = urlparse(final_url)
            qs = parse_qs(parsed.query)
            if "dest" in qs and qs["dest"]:
                return qs["dest"][0].split("?")[0]
            return final_url
        except Exception:
            pass
    return url


def parse_deezer_resource(url: str):
    """Return (kind, resource_id) if url points to Deezer playlist/album/track."""
    m = re.search(r"deezer\.com/(?:[a-z]{2}/)?(playlist|album|track)/(\d+)", url, re.IGNORECASE)
    if m:
        return m.group(1).lower(), m.group(2)
    return None, None


def fetch_deezer_metadata(kind: str, res_id: str) -> dict:
    """Fetch complete playlist, album or track metadata from Deezer public API."""
    if kind == "playlist":
        meta = requests.get(f"https://api.deezer.com/playlist/{res_id}", timeout=12).json()
        if "error" in meta:
            raise RuntimeError(f"Erreur Deezer API: {meta['error'].get('message', 'inconnue')}")
        title = meta.get("title") or f"Playlist Deezer {res_id}"
        cover = meta.get("picture_xl") or meta.get("picture_big") or meta.get("picture_medium") or ""
        tracks = []
        next_url = f"https://api.deezer.com/playlist/{res_id}/tracks?limit=100"
        while next_url:
            page = requests.get(next_url, timeout=12).json()
            tracks.extend(page.get("data", []))
            next_url = page.get("next")
    elif kind == "album":
        meta = requests.get(f"https://api.deezer.com/album/{res_id}", timeout=12).json()
        if "error" in meta:
            raise RuntimeError(f"Erreur Deezer API: {meta['error'].get('message', 'inconnue')}")
        artist_name = meta.get("artist", {}).get("name", "")
        title = f"{artist_name} - {meta.get('title')}" if artist_name else (meta.get("title") or f"Album {res_id}")
        cover = meta.get("cover_xl") or meta.get("cover_big") or meta.get("cover_medium") or ""
        raw_tracks = []
        next_url = f"https://api.deezer.com/album/{res_id}/tracks?limit=100"
        while next_url:
            page = requests.get(next_url, timeout=12).json()
            raw_tracks.extend(page.get("data", []))
            next_url = page.get("next")
        tracks = []
        for t in raw_tracks:
            t_copy = dict(t)
            t_copy["album"] = {
                "title": meta.get("title", ""),
                "cover_xl": meta.get("cover_xl", ""),
                "cover_big": meta.get("cover_big", ""),
                "cover_medium": meta.get("cover_medium", ""),
            }
            tracks.append(t_copy)
    else:
        meta = requests.get(f"https://api.deezer.com/track/{res_id}", timeout=12).json()
        if "error" in meta:
            raise RuntimeError(f"Erreur Deezer API: {meta['error'].get('message', 'inconnue')}")
        artist_name = meta.get("artist", {}).get("name", "")
        title = f"{artist_name} - {meta.get('title')}" if artist_name else (meta.get("title") or f"Titre {res_id}")
        cover = meta.get("album", {}).get("cover_xl") or meta.get("album", {}).get("cover_big") or ""
        tracks = [meta]

    parsed_tracks = []
    for idx, t in enumerate(tracks, 1):
        artist = (t.get("artist") or {}).get("name") or "Inconnu"
        t_title = t.get("title") or "Sans titre"
        album_obj = t.get("album") or {}
        album = album_obj.get("title") or title
        dur = int(t.get("duration") or 0)
        t_cover = album_obj.get("cover_xl") or album_obj.get("cover_big") or album_obj.get("cover_medium") or cover
        safe_base = sanitize_filename(f"{artist} - {t_title}")
        parsed_tracks.append(
            {
                "index": idx,
                "source": "deezer",
                "title": t_title,
                "artist": artist,
                "album": album,
                "duration": dur,
                "cover_url": t_cover,
                "filename": f"{safe_base}.mp3",
                "estimated_bytes": estimate_track_bytes(dur, True),
                "url": t.get("link") or "",
            }
        )

    return {
        "source": "deezer",
        "kind": kind,
        "title": title,
        "suggested_folder": sanitize_filename(title),
        "cover_url": cover,
        "tracks": parsed_tracks,
    }


def fetch_ytdlp_metadata(url: str) -> dict:
    """Extract playlist or single track metadata from YouTube / SoundCloud / etc."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "extractor_args": {"youtube": {"player_client": ["web", "android"]}},
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise RuntimeError("Impossible d'analyser ce lien. Vérifie qu'il est public et valide.")

    source_name = (info.get("extractor_key") or "web").lower()
    if "youtube" in source_name:
        source = "youtube"
    elif "soundcloud" in source_name:
        source = "soundcloud"
    else:
        source = source_name

    entries = info.get("entries")
    if entries is None:
        raw_list = [info]
        pl_title = info.get("title") or "Téléchargement audio"
        kind = "track"
    else:
        raw_list = [e for e in entries if e]
        pl_title = info.get("title") or "Playlist"
        kind = "playlist"

    parsed_tracks = []
    seen_names = {}
    for idx, e in enumerate(raw_list, 1):
        raw_title = e.get("title") or f"Piste {idx}"
        if raw_title in ("[Deleted video]", "[Private video]", "Deleted video", "Private video"):
            continue
        artist = e.get("artist") or e.get("uploader") or e.get("channel") or "Artiste inconnu"
        dur = int(e.get("duration") or 0)
        vid_url = e.get("webpage_url") or e.get("url") or ""
        if vid_url and not vid_url.startswith("http"):
            vid_url = f"https://www.youtube.com/watch?v={vid_url}"
        thumbs = e.get("thumbnails") or []
        thumb_url = e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else "")

        base_name = sanitize_filename(raw_title)
        if base_name in seen_names:
            seen_names[base_name] += 1
            file_base = f"{base_name} ({seen_names[base_name]})"
        else:
            seen_names[base_name] = 1
            file_base = base_name

        parsed_tracks.append(
            {
                "index": len(parsed_tracks) + 1,
                "source": source,
                "title": raw_title,
                "artist": artist,
                "album": pl_title,
                "duration": dur,
                "cover_url": thumb_url,
                "filename": f"{file_base}.mp3",
                "estimated_bytes": estimate_track_bytes(dur, False),
                "url": vid_url,
            }
        )

    cover = info.get("thumbnail") or ""
    if not cover and parsed_tracks:
        cover = parsed_tracks[0].get("cover_url") or ""

    return {
        "source": source,
        "kind": kind,
        "title": pl_title,
        "suggested_folder": sanitize_filename(pl_title),
        "cover_url": cover,
        "tracks": parsed_tracks,
    }


def analyze_url_data(raw_url: str) -> dict:
    resolved = resolve_url(raw_url)
    kind, res_id = parse_deezer_resource(resolved)
    if kind and res_id:
        data = fetch_deezer_metadata(kind, res_id)
    else:
        data = fetch_ytdlp_metadata(resolved)

    folder_path = os.path.join(LOCAL_MUSIC_ROOT, data["suggested_folder"])
    existing_count = 0
    total_dur = 0
    total_est = 0
    for tr in data["tracks"]:
        total_dur += tr["duration"]
        fp = os.path.join(folder_path, tr["filename"])
        if os.path.exists(fp) and os.path.getsize(fp) > 50_000:
            tr["already_exists"] = True
            tr["existing_bytes"] = os.path.getsize(fp)
            existing_count += 1
            total_est += tr["existing_bytes"]
        else:
            tr["already_exists"] = False
            tr["existing_bytes"] = 0
            total_est += tr["estimated_bytes"]

    data["resolved_url"] = resolved
    data["track_count"] = len(data["tracks"])
    data["existing_count"] = existing_count
    data["total_duration_sec"] = total_dur
    data["estimated_total_bytes"] = total_est
    data["q_free_bytes"] = get_disk_free_bytes(LOCAL_MUSIC_ROOT)
    data["y_free_bytes"] = get_disk_free_bytes(NAVIDROME_MUSIC_ROOT)
    data["navidrome_online"] = check_navidrome_online()
    return data


def score_candidate(entry: dict, target_dur: int, orig_title: str) -> float:
    dur = entry.get("duration") or 0
    if dur <= 0:
        return 9999.0
    diff = abs(dur - target_dur) if target_dur > 0 else 0
    cand_title = (entry.get("title") or "").lower()
    orig_lower = orig_title.lower()
    penalty = 0.0
    for kw in BAD_KEYWORDS:
        if kw in cand_title and kw not in orig_lower:
            penalty += 25.0
    channel = (entry.get("channel") or "").lower()
    if "official audio" in cand_title or "topic" in channel:
        penalty -= 5.0
    if "lyrics" in cand_title or "audio" in cand_title:
        penalty -= 2.0
    return diff + penalty


def find_best_youtube_url(artist: str, title: str, target_dur: int) -> str:
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "socket_timeout": 20,
        "retries": 3,
        "extractor_args": {"youtube": {"player_client": ["web", "android"]}},
    }
    queries = [
        f"ytsearch5:{artist} - {title} official audio",
        f"ytsearch5:{artist} {title}",
    ]
    best_entry = None
    best_score = 99999.0

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        for q in queries:
            try:
                res = ydl.extract_info(q, download=False)
                entries = res.get("entries") or []
                for e in entries:
                    if not e or not e.get("id"):
                        continue
                    sc = score_candidate(e, target_dur, title)
                    if sc < best_score:
                        best_score = sc
                        best_entry = e
                if best_entry and best_score <= 15.0:
                    break
            except Exception:
                continue

    if not best_entry:
        return ""
    return f"https://www.youtube.com/watch?v={best_entry['id']}"


def tag_mp3(mp3_path: str, idx: int, total: int, title: str, artist: str, album: str, cover_url: str) -> None:
    try:
        audio = MP3(mp3_path)
        if audio.tags is None:
            audio.add_tags()
        tags = audio.tags
        tags.delall("TIT2")
        tags.delall("TPE1")
        tags.delall("TALB")
        tags.delall("TRCK")
        if cover_url:
            tags.delall("APIC")

        tags.add(TIT2(encoding=3, text=title))
        tags.add(TPE1(encoding=3, text=artist))
        tags.add(TALB(encoding=3, text=album))
        tags.add(TRCK(encoding=3, text=f"{idx}/{total}"))

        if cover_url:
            try:
                r = requests.get(cover_url, timeout=10)
                if r.status_code == 200 and len(r.content) > 1000:
                    mime = "image/png" if r.content[:4] == b"\x89PNG" else "image/jpeg"
                    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=r.content))
            except Exception:
                pass
        audio.save(v2_version=3)
    except Exception:
        pass


def write_m3u8_files(folder_name: str, tracks: list, write_navidrome: bool = False) -> dict:
    lines = ["#EXTM3U"]
    for tr in tracks:
        if tr.get("status") in ("done", "skipped"):
            dur = int(tr.get("duration") or -1)
            lines.append(f"#EXTINF:{dur},{tr['artist']} - {tr['title']}")
            lines.append(f"{folder_name}/{tr['filename']}")
    content = "\n".join(lines) + "\n"

    written = {}
    local_m3u = os.path.join(LOCAL_MUSIC_ROOT, f"{folder_name}.m3u8")
    with open(local_m3u, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    written["local"] = local_m3u

    if USER_PLAYLISTS_ROOT and os.path.isdir(USER_PLAYLISTS_ROOT):
        user_m3u = os.path.join(USER_PLAYLISTS_ROOT, f"{folder_name}.m3u8")
        with open(user_m3u, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        written["user"] = user_m3u

    if write_navidrome and NAVIDROME_MUSIC_ROOT and os.path.isdir(NAVIDROME_MUSIC_ROOT):
        nas_m3u = os.path.join(NAVIDROME_MUSIC_ROOT, f"{folder_name}.m3u8")
        with open(nas_m3u, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        written["navidrome"] = nas_m3u

    return written


def resolve_local_playlist_dir(folder_name: str) -> str:
    direct = os.path.join(LOCAL_MUSIC_ROOT, folder_name)
    if os.path.isdir(direct):
        return direct
    phonk_sub = os.path.join(LOCAL_MUSIC_ROOT, "Phonk", folder_name)
    if os.path.isdir(phonk_sub):
        return phonk_sub
    return direct


def run_navidrome_sync(folder_name: str, start_time: float = None) -> dict:
    if start_time is None:
        start_time = time.time()

    src_dir = resolve_local_playlist_dir(folder_name)
    if not os.path.isdir(src_dir):
        raise RuntimeError(f"Dossier introuvable : {src_dir}")
    if not os.path.isdir(NAVIDROME_MUSIC_ROOT):
        raise RuntimeError(f"Partage réseau Navidrome inaccessible : {NAVIDROME_MUSIC_ROOT}")

    # Keep Phonk subfolder structure if syncing an existing Phonk playlist
    is_phonk_sub = os.path.normcase(os.path.dirname(src_dir)) == os.path.normcase(os.path.join(LOCAL_MUSIC_ROOT, "Phonk"))
    rel_prefix = f"Phonk/{folder_name}" if is_phonk_sub else folder_name
    dst_dir = os.path.join(NAVIDROME_MUSIC_ROOT, "Phonk", folder_name) if is_phonk_sub else os.path.join(NAVIDROME_MUSIC_ROOT, folder_name)
    os.makedirs(dst_dir, exist_ok=True)

    mp3_files = sorted([f for f in os.listdir(src_dir) if f.lower().endswith(".mp3")])
    total_files = len(mp3_files)
    total_bytes = sum(os.path.getsize(os.path.join(src_dir, f)) for f in mp3_files)

    sync_tracks = []
    for idx, fname in enumerate(mp3_files, 1):
        fsize = os.path.getsize(os.path.join(src_dir, fname))
        sync_tracks.append(
            {
                "index": idx,
                "title": os.path.splitext(fname)[0],
                "artist": folder_name,
                "duration": -1,
                "filename": fname,
                "estimated_bytes": fsize,
                "downloaded_bytes": 0,
                "size_bytes": fsize,
                "percent": 0.0,
                "status": "waiting",
                "error": "",
            }
        )

    copied_bytes = 0
    sync_start = time.time()
    last_emit = 0.0

    for idx, fname in enumerate(mp3_files):
        tr = sync_tracks[idx]
        src_file = os.path.join(src_dir, fname)
        dst_file = os.path.join(dst_dir, fname)
        fsize = tr["size_bytes"]

        if os.path.exists(dst_file) and os.path.getsize(dst_file) == fsize:
            copied_bytes += fsize
            tr["downloaded_bytes"] = fsize
            tr["percent"] = 100.0
            tr["status"] = "skipped"
        else:
            tr["status"] = "downloading"
            with open(src_file, "rb") as fin, open(dst_file, "wb") as fout:
                file_copied = 0
                while True:
                    chunk = fin.read(262_144)
                    if not chunk:
                        break
                    fout.write(chunk)
                    clen = len(chunk)
                    file_copied += clen
                    copied_bytes += clen
                    tr["downloaded_bytes"] = file_copied
                    tr["percent"] = round((file_copied / fsize) * 100.0, 1) if fsize > 0 else 100.0
                    now = time.time()
                    if now - last_emit >= 0.2:
                        last_emit = now
                        elapsed_sync = max(0.001, now - sync_start)
                        speed = copied_bytes / elapsed_sync
                        rem_bytes = max(0, total_bytes - copied_bytes)
                        eta = int(rem_bytes / speed) if speed > 100 else 0
                        pct = round((copied_bytes / total_bytes) * 100.0, 1) if total_bytes > 0 else 100.0
                        emit(
                            {
                                "type": "progress",
                                "phase": "navidrome_sync",
                                "folder_name": folder_name,
                                "percent": pct,
                                "downloaded_bytes": copied_bytes,
                                "total_estimated_bytes": total_bytes,
                                "speed_bps": speed,
                                "elapsed_sec": int(now - start_time),
                                "eta_sec": eta,
                                "completed_tracks": idx,
                                "total_tracks": total_files,
                                "failed_tracks": 0,
                                "tracks": sync_tracks,
                            }
                        )
            tr["status"] = "done"
            tr["percent"] = 100.0

    # Generate M3U8 pointing cleanly relative to /music in Navidrome
    lines = ["#EXTM3U"]
    for tr in sync_tracks:
        dur = -1
        title_str = tr["title"]
        try:
            audio = MP3(os.path.join(src_dir, tr["filename"]))
            if audio.info and audio.info.length:
                dur = int(audio.info.length)
            if audio.tags:
                t_tag = str(audio.tags.get("TIT2", ""))
                a_tag = str(audio.tags.get("TPE1", ""))
                if a_tag and t_tag:
                    title_str = f"{a_tag} - {t_tag}"
        except Exception:
            pass
        lines.append(f"#EXTINF:{dur},{title_str}")
        lines.append(f"{rel_prefix}/{tr['filename']}")

    m3u_content = "\n".join(lines) + "\n"
    m3u_name = f"{sanitize_filename(folder_name)}.m3u8"
    nas_m3u = os.path.join(NAVIDROME_MUSIC_ROOT, m3u_name)
    with open(nas_m3u, "w", encoding="utf-8", newline="\n") as f:
        f.write(m3u_content)

    # Write local M3U8 if not inside Phonk subdir
    if not is_phonk_sub:
        with open(os.path.join(LOCAL_MUSIC_ROOT, m3u_name), "w", encoding="utf-8", newline="\n") as f:
            f.write(m3u_content)
        if os.path.isdir(USER_PLAYLISTS_ROOT):
            with open(os.path.join(USER_PLAYLISTS_ROOT, m3u_name), "w", encoding="utf-8", newline="\n") as f:
                f.write(m3u_content)

    nav_online = check_navidrome_online()
    now = time.time()
    emit(
        {
            "type": "progress",
            "phase": "done",
            "folder_name": folder_name,
            "percent": 100.0,
            "downloaded_bytes": total_bytes,
            "total_estimated_bytes": total_bytes,
            "speed_bps": total_bytes / max(0.01, now - sync_start),
            "elapsed_sec": int(now - start_time),
            "eta_sec": 0,
            "completed_tracks": total_files,
            "total_tracks": total_files,
            "failed_tracks": 0,
            "navidrome_online": nav_online,
            "navidrome_m3u": nas_m3u,
            "tracks": sync_tracks,
        }
    )
    return {
        "folder_name": folder_name,
        "synced_tracks": total_files,
        "total_bytes": total_bytes,
        "navidrome_online": nav_online,
        "m3u_path": nas_m3u,
    }


def run_download(url: str, folder_name: str, auto_navidrome: bool) -> None:
    start_time = time.time()
    emit(
        {
            "type": "progress",
            "phase": "analyzing",
            "folder_name": sanitize_filename(folder_name) if folder_name else "",
            "message": "Préparation du téléchargement...",
            "percent": 0.0,
            "downloaded_bytes": 0,
            "total_estimated_bytes": 0,
            "speed_bps": 0.0,
            "elapsed_sec": 0,
            "eta_sec": 0,
            "completed_tracks": 0,
            "total_tracks": 0,
            "failed_tracks": 0,
            "tracks": [],
        }
    )

    analysis = analyze_url_data(url)
    folder_name = sanitize_filename(folder_name or analysis["suggested_folder"])
    target_dir = os.path.join(LOCAL_MUSIC_ROOT, folder_name)
    os.makedirs(target_dir, exist_ok=True)

    raw_tracks = analysis["tracks"]
    total_tracks = len(raw_tracks)
    if total_tracks == 0:
        raise RuntimeError("Aucun morceau exploitable trouvé dans ce lien.")

    state_lock = threading.Lock()
    track_states = []
    for tr in raw_tracks:
        fp = os.path.join(target_dir, tr["filename"])
        exists = os.path.exists(fp) and os.path.getsize(fp) > 50_000
        fsize = os.path.getsize(fp) if exists else 0
        est = fsize if exists else tr["estimated_bytes"]
        track_states.append(
            {
                "index": tr["index"],
                "source": tr["source"],
                "title": tr["title"],
                "artist": tr["artist"],
                "album": tr["album"],
                "duration": tr["duration"],
                "cover_url": tr["cover_url"],
                "filename": tr["filename"],
                "url": tr["url"],
                "estimated_bytes": est,
                "downloaded_bytes": fsize if exists else 0,
                "size_bytes": fsize if exists else est,
                "speed_bps": 0.0,
                "percent": 100.0 if exists else 0.0,
                "status": "skipped" if exists else "waiting",
                "error": "",
            }
        )

    stop_telemetry = threading.Event()

    def build_progress_snapshot(phase: str = "download") -> dict:
        with state_lock:
            now = time.time()
            elapsed = max(0.001, now - start_time)
            dl_bytes = 0
            est_total = 0
            done_cnt = 0
            fail_cnt = 0
            active_speed = 0.0
            active_transfer_bytes = 0

            for ts in track_states:
                est_total += ts["size_bytes"] if ts["status"] in ("done", "skipped") else max(ts["estimated_bytes"], ts["downloaded_bytes"])
                if ts["status"] in ("done", "skipped"):
                    dl_bytes += ts["size_bytes"]
                    done_cnt += 1
                    if ts["status"] == "done":
                        active_transfer_bytes += ts["size_bytes"]
                elif ts["status"] == "error":
                    fail_cnt += 1
                elif ts["status"] in ("downloading", "tagging"):
                    dl_bytes += ts["downloaded_bytes"]
                    active_transfer_bytes += ts["downloaded_bytes"]
                    active_speed += ts["speed_bps"]

            pct = round((dl_bytes / est_total) * 100.0, 1) if est_total > 0 else 100.0
            pct = min(99.9, pct) if (done_cnt + fail_cnt) < total_tracks else 100.0

            avg_speed = active_transfer_bytes / elapsed if elapsed > 0 else 0.0
            effective_speed = active_speed if active_speed > 50_000 else avg_speed
            rem_bytes = max(0, est_total - dl_bytes)

            if (done_cnt + fail_cnt) >= total_tracks:
                eta = 0
            elif effective_speed > 5_000:
                eta = int(rem_bytes / effective_speed)
            else:
                eta = max(0, (total_tracks - done_cnt - fail_cnt) * 3)

            return {
                "type": "progress",
                "phase": phase,
                "folder_name": folder_name,
                "percent": pct,
                "downloaded_bytes": dl_bytes,
                "total_estimated_bytes": est_total,
                "speed_bps": effective_speed,
                "elapsed_sec": int(elapsed),
                "eta_sec": eta,
                "completed_tracks": done_cnt,
                "total_tracks": total_tracks,
                "failed_tracks": fail_cnt,
                "tracks": [dict(t) for t in track_states],
            }

    def telemetry_loop():
        while not stop_telemetry.wait(0.25):
            emit(build_progress_snapshot("download"))

    emit(build_progress_snapshot("download"))
    t_thread = threading.Thread(target=telemetry_loop, daemon=True)
    t_thread.start()

    def worker_task(idx_pos: int):
        ts = track_states[idx_pos]
        if ts["status"] == "skipped":
            return

        with state_lock:
            ts["status"] = "downloading"
            ts["percent"] = 1.0

        target_url = ts["url"]
        if ts["source"] == "deezer":
            target_url = find_best_youtube_url(ts["artist"], ts["title"], ts["duration"])
            if not target_url:
                with state_lock:
                    ts["status"] = "error"
                    ts["error"] = "Introuvable sur YouTube"
                    ts["speed_bps"] = 0.0
                return

        if not target_url:
            with state_lock:
                ts["status"] = "error"
                ts["error"] = "URL source manquante"
                ts["speed_bps"] = 0.0
            return

        base_no_ext = os.path.splitext(ts["filename"])[0]
        mp3_path = os.path.join(target_dir, ts["filename"])
        out_tmpl = os.path.join(target_dir, f"{base_no_ext}.%(ext)s")

        def hook(d):
            st = d.get("status")
            if st == "downloading":
                d_bytes = int(d.get("downloaded_bytes") or 0)
                t_bytes = int(d.get("total_bytes") or d.get("total_bytes_estimate") or ts["estimated_bytes"] or 1)
                spd = float(d.get("speed") or 0.0)
                with state_lock:
                    ts["downloaded_bytes"] = min(d_bytes, t_bytes)
                    if t_bytes > 50_000:
                        ts["estimated_bytes"] = max(ts["estimated_bytes"], t_bytes)
                    ts["speed_bps"] = spd
                    ts["percent"] = min(92.0, round((d_bytes / t_bytes) * 90.0, 1))
            elif st == "finished":
                with state_lock:
                    ts["status"] = "tagging"
                    ts["speed_bps"] = 0.0
                    ts["percent"] = 95.0

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "socket_timeout": 20,
            "retries": 3,
            "fragment_retries": 3,
            "extractor_args": {"youtube": {"player_client": ["web", "android"]}},
            "progress_hooks": [hook],
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "0",
                }
            ],
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([target_url])
            if os.path.exists(mp3_path) and os.path.getsize(mp3_path) > 30_000:
                if ts["source"] == "deezer":
                    tag_mp3(
                        mp3_path,
                        ts["index"],
                        total_tracks,
                        ts["title"],
                        ts["artist"],
                        ts["album"],
                        ts["cover_url"],
                    )
                else:
                    # Ensure YouTube track has at least basic title/artist if missing
                    try:
                        audio = MP3(mp3_path)
                        if audio.tags is None:
                            audio.add_tags()
                        if not audio.tags.get("TIT2"):
                            audio.tags.add(TIT2(encoding=3, text=ts["title"]))
                        if not audio.tags.get("TPE1"):
                            audio.tags.add(TPE1(encoding=3, text=ts["artist"]))
                        audio.save(v2_version=3)
                    except Exception:
                        pass
                final_size = os.path.getsize(mp3_path)
                with state_lock:
                    ts["status"] = "done"
                    ts["size_bytes"] = final_size
                    ts["downloaded_bytes"] = final_size
                    ts["speed_bps"] = 0.0
                    ts["percent"] = 100.0
            else:
                with state_lock:
                    ts["status"] = "error"
                    ts["error"] = "Fichier MP3 non généré"
                    ts["speed_bps"] = 0.0
        except Exception as exc:
            with state_lock:
                ts["status"] = "error"
                ts["error"] = str(exc)[:140]
                ts["speed_bps"] = 0.0

    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = [pool.submit(worker_task, i) for i in range(total_tracks)]
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception:
                pass

    stop_telemetry.set()
    t_thread.join(timeout=1.0)

    if not folder_name.startswith("_staging_"):
        write_m3u8_files(folder_name, track_states, write_navidrome=False)

    if auto_navidrome and not folder_name.startswith("_staging_"):
        run_navidrome_sync(folder_name, start_time=start_time)
    else:
        final_snap = build_progress_snapshot("done")
        final_snap["percent"] = 100.0
        final_snap["eta_sec"] = 0
        emit(final_snap)


def list_local_playlists() -> dict:
    """List local playlists in Q:\\Musiques and Q:\\Musiques\\Phonk with Navidrome sync status."""
    playlists = []

    def inspect_folder(folder_path: str, display_name: str, is_phonk_sub: bool):
        if not os.path.isdir(folder_path):
            return
        mp3s = [f for f in os.listdir(folder_path) if f.lower().endswith(".mp3")]
        if not mp3s:
            return
        total_bytes = sum(os.path.getsize(os.path.join(folder_path, f)) for f in mp3s)
        m3u_name = f"{sanitize_filename(display_name)}.m3u8"
        has_local_m3u = os.path.isfile(os.path.join(LOCAL_MUSIC_ROOT, m3u_name)) or os.path.isfile(
            os.path.join(LOCAL_MUSIC_ROOT, "Phonk", m3u_name)
        )

        nas_dir = (
            os.path.join(NAVIDROME_MUSIC_ROOT, "Phonk", display_name)
            if is_phonk_sub
            else os.path.join(NAVIDROME_MUSIC_ROOT, display_name)
        )
        nas_count = 0
        if os.path.isdir(nas_dir):
            nas_count = len([f for f in os.listdir(nas_dir) if f.lower().endswith(".mp3")])
        nas_m3u = os.path.isfile(os.path.join(NAVIDROME_MUSIC_ROOT, m3u_name))
        if is_phonk_sub and not nas_m3u:
            nas_m3u = os.path.isfile(os.path.join(NAVIDROME_MUSIC_ROOT, "phonk_all.m3u8"))

        playlists.append(
            {
                "name": display_name,
                "local_path": folder_path,
                "nas_path": nas_dir,
                "is_phonk_sub": is_phonk_sub,
                "track_count": len(mp3s),
                "total_bytes": total_bytes,
                "has_local_m3u": has_local_m3u,
                "nas_track_count": nas_count,
                "nas_has_m3u": nas_m3u,
                "synced": nas_count >= len(mp3s) and nas_m3u,
            }
        )

    if os.path.isdir(LOCAL_MUSIC_ROOT):
        for entry in sorted(os.listdir(LOCAL_MUSIC_ROOT)):
            if entry.startswith("_staging_"):
                continue
            full = os.path.join(LOCAL_MUSIC_ROOT, entry)
            if not os.path.isdir(full):
                continue
            if entry.lower() == "phonk":
                for sub in sorted(os.listdir(full)):
                    sub_full = os.path.join(full, sub)
                    if os.path.isdir(sub_full):
                        inspect_folder(sub_full, sub, True)
            else:
                inspect_folder(full, entry, False)

    return {
        "playlists": playlists,
        "q_free_bytes": get_disk_free_bytes(LOCAL_MUSIC_ROOT),
        "y_free_bytes": get_disk_free_bytes(NAVIDROME_MUSIC_ROOT),
        "navidrome_online": check_navidrome_online(),
        "navidrome_url": NAVIDROME_URL,
    }


def rebuild_m3u8_for_playlist(folder_name: str, sync_nav: bool) -> dict:
    """Rebuild M3U8 playlist file from all MP3s currently inside the target folder."""
    src_dir = resolve_local_playlist_dir(folder_name)
    if not os.path.isdir(src_dir):
        raise RuntimeError(f"Dossier introuvable : {src_dir}")
    is_phonk_sub = os.path.normcase(os.path.dirname(src_dir)) == os.path.normcase(os.path.join(LOCAL_MUSIC_ROOT, "Phonk"))
    rel_prefix = f"Phonk/{folder_name}" if is_phonk_sub else folder_name

    mp3_files = sorted([f for f in os.listdir(src_dir) if f.lower().endswith(".mp3")])
    lines = ["#EXTM3U"]
    for fname in mp3_files:
        dur = -1
        title_str = os.path.splitext(fname)[0]
        try:
            audio = MP3(os.path.join(src_dir, fname))
            if audio.info and audio.info.length:
                dur = int(audio.info.length)
            if audio.tags:
                t_tag = str(audio.tags.get("TIT2", ""))
                a_tag = str(audio.tags.get("TPE1", ""))
                if a_tag and t_tag:
                    title_str = f"{a_tag} - {t_tag}"
        except Exception:
            pass
        lines.append(f"#EXTINF:{dur},{title_str}")
        lines.append(f"{rel_prefix}/{fname}")

    m3u_content = "\n".join(lines) + "\n"
    m3u_name = f"{sanitize_filename(folder_name)}.m3u8"
    out_paths = {}

    if not is_phonk_sub:
        local_m3u = os.path.join(LOCAL_MUSIC_ROOT, m3u_name)
        with open(local_m3u, "w", encoding="utf-8", newline="\n") as f:
            f.write(m3u_content)
        out_paths["local"] = local_m3u
        if USER_PLAYLISTS_ROOT and os.path.isdir(USER_PLAYLISTS_ROOT):
            user_m3u = os.path.join(USER_PLAYLISTS_ROOT, m3u_name)
            with open(user_m3u, "w", encoding="utf-8", newline="\n") as f:
                f.write(m3u_content)
            out_paths["user"] = user_m3u

    if sync_nav and NAVIDROME_MUSIC_ROOT and os.path.isdir(NAVIDROME_MUSIC_ROOT):
        nas_m3u = os.path.join(NAVIDROME_MUSIC_ROOT, m3u_name)
        with open(nas_m3u, "w", encoding="utf-8", newline="\n") as f:
            f.write(m3u_content)
        out_paths["navidrome"] = nas_m3u

    return {"folder_name": folder_name, "track_count": len(mp3_files), "paths": out_paths}


def main():
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "Sous-commande requise (analyze | download | sync_navidrome | list_playlists | rebuild_m3u8)"})
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == "analyze":
            if len(sys.argv) < 3:
                raise RuntimeError("URL manquante")
            data = analyze_url_data(sys.argv[2])
            emit({"type": "analysis", "data": data})
        elif cmd == "download":
            if len(sys.argv) < 3:
                raise RuntimeError("URL manquante")
            url = sys.argv[2]
            folder = sys.argv[3] if len(sys.argv) > 3 else ""
            auto_nav = (sys.argv[4] == "1") if len(sys.argv) > 4 else False
            run_download(url, folder, auto_nav)
        elif cmd == "sync_navidrome":
            if len(sys.argv) < 3:
                raise RuntimeError("Nom de dossier manquant")
            res = run_navidrome_sync(sys.argv[2])
            emit({"type": "sync_complete", "data": res})
        elif cmd == "rebuild_m3u8":
            if len(sys.argv) < 3:
                raise RuntimeError("Nom de dossier manquant")
            sync_nav = (sys.argv[3] == "1") if len(sys.argv) > 3 else False
            res = rebuild_m3u8_for_playlist(sys.argv[2], sync_nav)
            emit({"type": "m3u8_rebuilt", "data": res})
        elif cmd == "list_playlists":
            data = list_local_playlists()
            emit({"type": "playlists", "data": data})
        else:
            raise RuntimeError(f"Commande inconnue: {cmd}")
    except Exception as exc:
        emit({"type": "error", "phase": "error", "message": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
