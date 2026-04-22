use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[cfg(debug_assertions)]
use std::fs::OpenOptions;
#[cfg(debug_assertions)]
use std::time::{SystemTime, UNIX_EPOCH};

/// Target one render frame at 60fps. Reader chunks that arrive within this
/// window of each other are coalesced into a single emit, so multi-sequence
/// redraws (Claude's cursor-up / CUF / repaint) land in xterm as one write()
/// and can't be interleaved with a render tick mid-sequence.
const FRAME_COALESCE_MS: u64 = 16;
/// Hard cap on a single emit payload — guards against unbounded accumulation
/// during bulk dumps (e.g. `cat largefile`).
const MAX_EMIT_BYTES: usize = 128 * 1024;

/// PTY-side filter: strips two classes of sequences that trip xterm.js and
/// cause the visible corruption seen with Claude Code.
///
///  (1) OSC 777 — Claude's remote-control "warp://cli-agent;{JSON}" notifies.
///      xterm's OSC parser mishandles the nested payload and bleeds it into
///      the visible buffer.
///  (2) Synchronized-update-mode markers (DECSET/DECRST 2026, i.e.
///      ESC[?2026h and ESC[?2026l) — aggressive mode only. xterm 5.5 batches
///      writes inside these regions and its flush timing races Claude's
///      diff-redraws.
///
/// Both classes are handled across PTY read boundaries via `carry`.
/// Returns `(filtered_bytes, osc_777_count)`. `osc_777_count` is the number
/// of OSC 777 `warp://cli-agent;{JSON}` payloads seen in this chunk — the
/// PTY loop uses it to emit a `pty-notify-{sid}` event for permission /
/// attention signals coming from Claude Code.
pub fn filter_pty_output(carry: &mut Vec<u8>, chunk: &[u8], aggressive: bool) -> (Vec<u8>, u32) {
    carry.extend_from_slice(chunk);
    let bytes = std::mem::take(carry);
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut osc_777: u32 = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        // At ESC — need enough lookahead to classify.
        if i + 1 >= bytes.len() {
            carry.extend_from_slice(&bytes[i..]);
            return (out, osc_777);
        }

        // CSI sequences: ESC [ ... final-byte. Drop ESC[?2026h / ESC[?2026l.
        if bytes[i + 1] == b'[' {
            // A CSI final byte is 0x40..=0x7E. Scan forward to find it.
            let mut j = i + 2;
            while j < bytes.len() {
                let b = bytes[j];
                if (0x40..=0x7e).contains(&b) {
                    break;
                }
                j += 1;
            }
            if j >= bytes.len() {
                // Incomplete CSI at end of chunk — carry it.
                carry.extend_from_slice(&bytes[i..]);
                return (out, osc_777);
            }
            let e = j + 1;
            let seq = &bytes[i..e];
            // Match ESC [ ? 2 0 2 6 h   or   ESC [ ? 2 0 2 6 l
            // ESC [ ? 2 0 2 6 (h|l) — synchronized update mode markers.
            // Only drop in aggressive mode; some TUIs use sync mode without
            // the xterm.js race that bites Claude Code.
            if aggressive
                && seq.len() == 8
                && seq[2] == b'?'
                && &seq[3..7] == b"2026"
                && (seq[7] == b'h' || seq[7] == b'l')
            {
                i = e;
                continue;
            }
            out.extend_from_slice(seq);
            i = e;
            continue;
        }

        // OSC sequences: ESC ] ... (BEL | ESC\). Drop OSC 777.
        if bytes[i + 1] == b']' {
            let mut j = i + 2;
            let mut end: Option<usize> = None;
            while j < bytes.len() {
                if bytes[j] == 0x07 {
                    end = Some(j + 1);
                    break;
                }
                if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    end = Some(j + 2);
                    break;
                }
                j += 1;
            }
            match end {
                None => {
                    carry.extend_from_slice(&bytes[i..]);
                    return (out, osc_777);
                }
                Some(e) => {
                    let is_777 = e > i + 6
                        && bytes[i + 2] == b'7'
                        && bytes[i + 3] == b'7'
                        && bytes[i + 4] == b'7'
                        && bytes[i + 5] == b';';
                    // OSC 9 = iTerm notification. Claude Code emits this for
                    // permission prompts and attention waits when we advertise
                    // TERM_PROGRAM=iTerm.app. Do NOT count OSC 9;4 — that's
                    // iTerm's progress-bar indicator, not an attention signal.
                    let is_osc9_notify = e > i + 4
                        && bytes[i + 2] == b'9'
                        && bytes[i + 3] == b';'
                        && bytes[i + 4] != b'4';
                    if is_777 || is_osc9_notify {
                        osc_777 += 1; // reused counter: "notify events in chunk"
                    } else {
                        out.extend_from_slice(&bytes[i..e]);
                    }
                    i = e;
                    continue;
                }
            }
        }

        // Any other ESC ... sequence: pass through untouched.
        out.push(bytes[i]);
        i += 1;
    }
    (out, osc_777)
}


#[cfg(debug_assertions)]
fn trace_pty(session_id: &str, bytes: &[u8]) {
    let path = std::env::var("VECTOR_PTY_TRACE")
        .unwrap_or_else(|_| "/tmp/vector-pty.log".into());
    let mut f = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let s = String::from_utf8_lossy(bytes);
    let _ = writeln!(f, "[{ms}][{session_id}] {:?}", s);
}
#[cfg(not(debug_assertions))]
fn trace_pty(_: &str, _: &[u8]) {}

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl PtyRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        program: &[String],
        env: &[(String, String)],
        cwd: Option<std::path::PathBuf>,
        cols: u16,
        rows: u16,
        aggressive_filter: bool,
    ) -> anyhow::Result<()> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let (cmd_name, rest) = program.split_first().ok_or_else(|| anyhow::anyhow!("empty command"))?;
        let mut cmd = CommandBuilder::new(cmd_name);
        for a in rest { cmd.arg(a); }
        if let Some(cwd) = cwd { cmd.cwd(cwd); }
        if let Ok(home) = std::env::var("HOME") { cmd.env("HOME", home); }
        if let Ok(user) = std::env::var("USER") { cmd.env("USER", user); }
        if let Ok(lang) = std::env::var("LANG") { cmd.env("LANG", lang); }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // caller-supplied env wins (includes augmented PATH)
        for (k, v) in env { cmd.env(k, v); }

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let killer = child.clone_killer();

        let session = Session { master: pair.master, writer, killer };
        let arc = Arc::new(Mutex::new(session));
        self.sessions.lock().insert(id.clone(), arc.clone());

        // Reader → emitter channel. Reader thread filters and queues bytes;
        // emitter thread coalesces chunks within a 16ms window and emits a
        // single payload per frame. This avoids xterm applying a partial
        // redraw between two related VT sequences.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        // Reader thread — blocks on PTY read, owns the carry buffer across
        // PTY reads so escape sequences split at chunk boundaries are
        // reassembled before being filtered.
        let id_r = id.clone();
        let app_r = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        trace_pty(&id_r, &buf[..n]);
                        let (filtered, notify_count) = filter_pty_output(&mut carry, &buf[..n], aggressive_filter);
                        if notify_count > 0 {
                            // Claude Code emits OSC 777 when it wants user
                            // attention (permission prompt, idle waiting).
                            // Forward as a structured event — the frontend
                            // lights up the tab + dock badge.
                            let _ = app_r.emit(&format!("pty-notify-{id_r}"), notify_count);
                        }
                        if filtered.is_empty() { continue; }
                        if tx.send(filtered).is_err() { break; }
                    }
                    Err(_) => break,
                }
            }
        });

        // Emitter thread — drains the channel with a per-frame coalescing
        // deadline and emits one combined string per frame.
        let app_em = app.clone();
        let id_em = id.clone();
        std::thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let flush = |buf: &mut Vec<u8>| {
                if buf.is_empty() { return; }
                let s = String::from_utf8_lossy(buf).to_string();
                let _ = app_em.emit(&format!("pty-data-{id_em}"), s);
                buf.clear();
            };
            loop {
                // Block until the next chunk arrives.
                let first = match rx.recv() {
                    Ok(v) => v,
                    Err(_) => { flush(&mut pending); return; }
                };
                pending.extend_from_slice(&first);
                let deadline = Instant::now() + Duration::from_millis(FRAME_COALESCE_MS);
                // Accumulate anything that arrives in the same frame window.
                loop {
                    if pending.len() >= MAX_EMIT_BYTES { break; }
                    let now = Instant::now();
                    let remaining = match deadline.checked_duration_since(now) {
                        Some(d) => d,
                        None => break,
                    };
                    match rx.recv_timeout(remaining) {
                        Ok(more) => pending.extend_from_slice(&more),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            flush(&mut pending);
                            return;
                        }
                    }
                }
                flush(&mut pending);
            }
        });

        // wait thread — owns the child outright; no shared lock.
        let app_w = app.clone();
        let id_w = id.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|st| st.exit_code() as i32).unwrap_or(-1);
            let _ = app_w.emit(&format!("pty-exit-{id_w}"), code);
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().get(id).cloned() {
            trace_pty(&format!("IN:{id}"), data.as_bytes());
            s.lock().writer.write_all(data.as_bytes())?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().get(id).cloned() {
            s.lock().master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> anyhow::Result<()> {
        if let Some(s) = self.sessions.lock().remove(id) {
            let _ = s.lock().killer.kill();
        }
        Ok(())
    }
}
