# -*- coding: utf-8 -*-
"""
語音橋接 v3 — JSON Lines 協定。純音訊與程序工作者：收音/VAD/live ASR、單句 TTS、
Player queue 無縫播放、8081 伺服器生命週期與模型管理。沒有大腦、沒有 session、沒有 API key。

stdin 指令（每行一個 JSON 物件，UTF-8）：
  {"cmd":"ready"}                          → {"event":"ready"}
  {"cmd":"config","config":{...}}          → {"event":"config-ok",...}
      config.tts   : model/language/speaker/voicePath/referenceText/ttsFamilies[]
      config.asr   : model/language
      config.audio : input_device/output_device/sample_rate/max_record_seconds/
                     min_record_seconds/silence_seconds/silence_threshold
      config.server: exe/cfgPath/port/logPath/errLogPath/binDir
  {"cmd":"record","jobId":"r1"}            → 錄音+ASR
  {"cmd":"stop-record"}                    → 中止錄音/ASR
  {"cmd":"speak","roundId","sentenceId","text"}
  {"cmd":"stop-playback","roundId"}
  {"cmd":"health"}                         → {"event":"health","alive":bool}
  {"cmd":"start-server","req":"q1"}        → {"event":"server-started","req":"q1","ok":bool}
  {"cmd":"stop-server","req":"q2"}         → {"event":"server-stopped","req":"q2","ok":bool}
  {"cmd":"models"}                         → {"event":"models","ids":[...]}
  {"cmd":"ensure-single","model":"..."}    → 卸載其他現役 TTS 家族 → {"event":"single-ok"}
  {"cmd":"unload","ids":[...]}             → {"event":"unload-ok"}
  {"cmd":"quit"}

設計要點：
- DSH Host 不再直接 spawn curl/powershell：HTTP 與 8081 管理全在本行程式內完成，
  避開宿主環境下 console 子程序 DLL 初始化失敗（0xc0000142）的問題。
- audiocpp_server 以 DETACHED_PROCESS 啟動並記錄 pid；停止時優先用已知 pid，
  否則解析 netstat -ano 找 LISTENING :8081 的 pid，再以 taskkill /T /F 結束。
"""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave

import numpy as np
import requests
import sounddevice as sd

for _s in (sys.stdout, sys.stderr, sys.stdin):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = os.path.dirname(os.path.abspath(__file__))
# 副本目錄不可位於含非 ASCII 字元的路徑下（例如工作區中文目錄），
# 否則 audio.cpp 轉換 voice_ref 路徑時回 500「No mapping for the Unicode character...」。
# 實際目錄由 _ensure_ascii_dir() 惰性決定。
ASCII_DIR = ""
SERVER_URL = "http://127.0.0.1:8081"
CREATE_NO_WINDOW = 0x08000000

LOCK = threading.Lock()
CFG = {
    "tts": {"model": "qwen3-tts-06b-base", "language": "chinese",
            "speaker": "", "voice_path": "", "reference_text": "",
            "tts_families": ["qwen3-tts", "voxcpm", "omnivoice"]},
    "asr": {"model": "sense-asr", "language": "zh"},
    "audio": {"input_device": None, "output_device": None, "sample_rate": 16000,
              "max_record_seconds": 30.0, "min_record_seconds": 0.6,
              "silence_seconds": 1.0, "silence_threshold": 0.01},
    "server": {"exe": "", "cfg_path": "", "port": 8081, "bin_dir": "",
               "log_path": "", "err_log_path": ""},
}
SERVER_PROC = None   # 我們啟動的 server 的 Popen；外部啟動的為 None


LAST_EVENT = {"event": ""}


def emit(obj):
    LAST_EVENT["event"] = obj.get("event", "")
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def pick_device(kind, wanted):
    if wanted is not None:
        return int(wanted)
    idx = 0 if kind == "input" else 1
    return sd.default.device[idx] if sd.default.device[idx] is not None else 0


def _ensure_ascii_dir():
    """挑選並建立『整條路徑皆為 ASCII』的副本目錄，回傳其路徑；全敗則回空字串。

    優先 <server exe 根目錄>/output/ascii-refs（audiocpp 樹本身為純 ASCII），
    退回系統暫存目錄。"""
    global ASCII_DIR
    if ASCII_DIR:
        return ASCII_DIR
    cands = []
    exe = ((CFG.get("server") or {}).get("exe")) or ""
    if exe:
        cands.append(os.path.join(os.path.dirname(os.path.dirname(exe)), "output", "ascii-refs"))
    cands.append(tempfile.gettempdir())
    for cand in cands:
        if not cand or any(ord(ch) > 127 for ch in os.path.abspath(cand)):
            continue
        try:
            os.makedirs(cand, exist_ok=True)
            ASCII_DIR = cand
            return ASCII_DIR
        except Exception:
            continue
    return ""


def resolve_voice_path(path):
    """audio.cpp 不吃含非 ASCII 字元的路徑：需要時複製一份到純 ASCII 目錄。"""
    if not path:
        return ""
    if all(ord(ch) < 128 for ch in path):
        return path
    dst_dir = _ensure_ascii_dir()
    if not dst_dir:
        return path
    dst = os.path.join(dst_dir, "voice_ref_%d.wav" % int(time.time() * 1000))
    shutil.copy2(path, dst)
    return dst


def build_tts_body(text):
    """依目前 CFG 組 /v1/audio/speech 請求本體（克隆音色優先，其次內建 speaker）。"""
    tts = CFG["tts"]
    body = {"model": tts["model"], "input": text, "language": tts["language"]}
    vp = resolve_voice_path(tts.get("voice_path", ""))
    if vp:
        body["voice_ref"] = vp
        if tts.get("reference_text"):
            body["reference_text"] = tts["reference_text"]
    elif tts.get("speaker"):
        body["options"] = {"speaker": tts["speaker"]}
    return body


def port_alive():
    s = socket.socket()
    s.settimeout(0.6)
    try:
        s.connect(("127.0.0.1", int(CFG["server"].get("port") or 8081)))
        return True
    except Exception:
        return False
    finally:
        s.close()


# ---------------------------------------------------------------- 錄音 + ASR
REC = {"thread": None, "stop": threading.Event(), "epoch": 0}


def record_worker(job_id, audio, epoch):
    stop = REC["stop"]
    try:
        sr = int(audio.get("sample_rate", 16000))
        dev_in = pick_device("input", audio.get("input_device"))
        max_sec = float(audio.get("max_record_seconds", 30))
        min_sec = float(audio.get("min_record_seconds", 0.6))
        silence_sec = float(audio.get("silence_seconds", 1.0))
        thr = float(audio.get("silence_threshold", 0.01))
        block = int(sr * 0.02)
        frames = []
        quiet = 0.0
        started = time.time()
        emit({"event": "recording", "jobId": job_id})
        with sd.InputStream(device=dev_in, samplerate=sr, channels=1,
                            dtype="int16", blocksize=block) as stream:
            while time.time() - started < max_sec:
                if stop.is_set():
                    emit({"event": "asr-cancelled", "jobId": job_id})
                    return
                data, _ = stream.read(block)
                frames.append(data.copy())
                rms = float(np.sqrt(np.mean(data.astype(np.float32) ** 2)) / 32768.0)
                quiet = quiet + 0.02 if rms < thr else 0.0
                if quiet >= silence_sec and (time.time() - started) >= min_sec:
                    break
            if stop.is_set():
                emit({"event": "asr-cancelled", "jobId": job_id})
                return
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.concatenate(frames) if frames else np.zeros(1, dtype=np.int16)).tobytes())
        wav_bytes = wav_buf.getvalue()
        if len(wav_bytes) < 2000:
            with LOCK:
                alive = epoch == REC["epoch"]
            if alive and not stop.is_set():
                emit({"event": "asr-final", "jobId": job_id, "text": ""})
            return
        files = {"file": ("mic.wav", wav_bytes, "audio/wav")}
        data = {"model": CFG["asr"]["model"], "language": CFG["asr"]["language"]}
        r = requests.post(SERVER_URL + "/v1/audio/transcriptions",
                          files=files, data=data, timeout=180)
        r.raise_for_status()
        text = (r.json().get("text") or "").strip()
        with LOCK:
            alive = epoch == REC["epoch"]
        if alive and not stop.is_set():
            emit({"event": "asr-final", "jobId": job_id, "text": text})
    except Exception as e:
        with LOCK:
            alive = epoch == REC["epoch"]
        if alive and not stop.is_set():
            emit({"event": "error", "stage": "asr", "jobId": job_id, "message": str(e)})


def start_record(job_id):
    with LOCK:
        REC["epoch"] += 1
        epoch = REC["epoch"]
    REC["stop"] = threading.Event()
    t = threading.Thread(target=record_worker, args=(job_id, dict(CFG["audio"]), epoch), daemon=True)
    REC["thread"] = t
    t.start()


# ------------------------------------------------------- TTS 合成 + Player queue
class Player:
    """單一 OutputStream + frame queue。合成與播放重疊；queue 排空回報 drained。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.stream = None
        self.sr = 0
        self.q = []                 # list[np.ndarray int16]
        self.expected = 0           # 尚未合成完成的句子數
        self.gen = 0                # 世代計數：stop() 後在途合成結果整批作廢
        self.round_id = ""
        self.active = False         # 有播放工作
        self.stop_flag = False
        self.ready = {}             # seq -> (pcm, rate)；None=該句合成失敗（哨兵，跳過）
        self.next_seq = 0           # 下一個允許入隊的句子索引（嚴格順序鎖）

    def _open(self, sr):
        if self.stream is not None and self.sr == sr:
            return
        self._close_stream()
        dev_out = pick_device("output", CFG["audio"].get("output_device"))
        self.stream = sd.OutputStream(
            samplerate=sr, channels=1, dtype="int16", blocksize=2048,
            callback=self._callback, device=dev_out)
        self.sr = sr
        self.stream.start()

    def _close_stream(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
            self.sr = 0

    def _callback(self, outdata, frames, time_info, status):
        with self.lock:
            need = frames
            out = []
            while need > 0 and self.q:
                chunk = self.q[0]
                take = min(need, len(chunk))
                out.append(chunk[:take])
                self.q[0] = chunk[take:]
                if len(self.q[0]) == 0:
                    self.q.pop(0)
                need -= take
            if out:
                data = np.concatenate(out)
                buf = np.zeros((frames,), dtype=np.int16)
                buf[:len(data)] = data
                outdata[:] = buf.reshape(-1, 1)
            else:
                outdata.fill(0)
                if self.active and self.expected == 0 and not self.q and not self.ready and not self.stop_flag:
                    self.active = False
                    drain_round = self.round_id
                    # 在 callback 執行緒外回報，避免阻塞音訊
                    threading.Thread(target=self._report_drained, args=(drain_round,), daemon=True).start()

    def _report_drained(self, round_id):
        with self.lock:
            self._close_stream()
        emit({"event": "playback-drained", "roundId": round_id})

    def _flush_ready_locked(self):
        """只允許 next_seq 依序入隊；合成先後不影響播放順序。"""
        while self.next_seq in self.ready:
            item = self.ready.pop(self.next_seq)
            self.next_seq += 1
            if item is None:
                continue
            pcm, rate = item
            for i in range(0, len(pcm), 2048):
                self.q.append(pcm[i:i + 2048])
            self._open(rate)
            self.active = True

    def speak(self, round_id, sentence_id, text, seq=0):
        with self.lock:
            if round_id != self.round_id:
                self.round_id = round_id
                self.ready = {}
                self.next_seq = 0
            self.expected += 1
            gen = self.gen

        def synth():
            try:
                body = build_tts_body(text)
                r = requests.post(SERVER_URL + "/v1/audio/speech", json=body, timeout=300)
                r.raise_for_status()
                pcm, rate = decode_wav(r.content)
                with self.lock:
                    self.expected -= 1
                    if gen != self.gen:
                        return
                    self.ready[seq] = (pcm, rate)
                    self._flush_ready_locked()
                emit({"event": "tts-queued", "roundId": round_id,
                      "sentenceId": sentence_id, "seq": seq})
            except Exception as e:
                msg = str(e)
                if isinstance(e, requests.HTTPError) and e.response is not None:
                    try:
                        msg = "HTTP %s: %s" % (e.response.status_code, e.response.text[:300])
                    except Exception:
                        pass
                with self.lock:
                    self.expected -= 1
                    if gen != self.gen:
                        emit({"event": "error", "stage": "tts", "roundId": round_id,
                              "sentenceId": sentence_id, "message": msg})
                        return
                    self.ready[seq] = None  # 哨兵：此句跳過，不阻塞後續句
                    self._flush_ready_locked()
                    idle_dead = (not self.active) and self.expected == 0 and not self.q and not self.ready
                    dead_round = self.round_id or round_id
                if idle_dead:
                    emit({"event": "playback-drained", "roundId": dead_round})
                emit({"event": "error", "stage": "tts", "roundId": round_id,
                      "sentenceId": sentence_id, "message": msg})
        threading.Thread(target=synth, daemon=True).start()

    def stop(self, round_id):
        with self.lock:
            self.gen += 1
            self.stop_flag = True
            had_work = self.active or self.expected > 0 or bool(self.q) or bool(self.ready)
            self.q.clear()
            self.ready = {}
            self.next_seq = 0
            self.expected = 0
            self.active = False
            self._close_stream()
            self.stop_flag = False
        if had_work:
            emit({"event": "playback-stopped", "roundId": round_id})


PLAYER = Player()


def decode_wav(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width == 2:
        data = np.frombuffer(raw, dtype=np.int16)
    elif width == 4:
        data = (np.frombuffer(raw, dtype=np.float32) * 32767).astype(np.int16)
    else:
        data = np.frombuffer(raw, dtype=np.int16)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return data, sr


# ------------------------------------------------------- 8081 伺服器生命週期
def find_server_pid():
    """從 netstat -ano 解析監聽 8081 的 pid（找不到回 None）。"""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True,
                             timeout=10, creationflags=CREATE_NO_WINDOW).stdout or ""
    except Exception:
        return None
    want = ":%d" % int(CFG["server"].get("port") or 8081)
    for line in out.splitlines():
        if want in line and "LISTENING" in line.upper():
            parts = line.split()
            if parts:
                try:
                    return int(parts[-1])
                except ValueError:
                    return None
    return None


def kill_tree(pid):
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=15, creationflags=CREATE_NO_WINDOW)
        return True
    except Exception:
        return False


def start_server(req):
    global SERVER_PROC
    srv = CFG["server"]
    if port_alive():
        emit({"event": "server-started", "req": req, "ok": True, "already": True})
        return
    try:
        os.makedirs(os.path.dirname(srv.get("log_path") or "."), exist_ok=True)
        logf = open(srv["log_path"], "ab")
        errf = open(srv["err_log_path"], "ab")
        SERVER_PROC = subprocess.Popen(
            [srv["exe"], "--config", srv["cfg_path"], "--port", str(srv.get("port") or 8081)],
            cwd=srv.get("bin_dir") or os.path.dirname(srv["exe"]),
            stdout=logf, stderr=errf,
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    except Exception as e:
        emit({"event": "server-started", "req": req, "ok": False, "message": str(e)})
        return
    deadline = time.time() + 25
    while time.time() < deadline:
        time.sleep(1.0)
        if port_alive():
            emit({"event": "server-started", "req": req, "ok": True, "pid": SERVER_PROC.pid})
            return
    emit({"event": "server-started", "req": req, "ok": False,
          "message": "start timeout; see err log", "pid": SERVER_PROC.pid})


def stop_server(req):
    global SERVER_PROC
    pid = SERVER_PROC.pid if SERVER_PROC is not None else find_server_pid()
    was = port_alive()
    if pid is not None:
        kill_tree(pid)
    elif not was:
        emit({"event": "server-stopped", "req": req, "ok": True, "already": True})
        return
    deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.5)
        if not port_alive():
            SERVER_PROC = None
            emit({"event": "server-stopped", "req": req, "ok": True})
            return
    emit({"event": "server-stopped", "req": req, "ok": False, "message": "port still listening"})


# ------------------------------------------------------- 模型管理
def api_models():
    r = requests.get(SERVER_URL + "/v1/models", timeout=8)
    r.raise_for_status()
    j = r.json()
    return [m.get("id") for m in (j.get("data") or []) if m.get("id")]


def unload_ids(ids):
    if not ids:
        return
    requests.post(SERVER_URL + "/v1/tasks/unload_models", json={"model_ids": ids}, timeout=60)


WARM = {"model": "", "ts": 0.0}


def ensure_single(model, warm=False):
    """卸載其他現役 TTS 家族；warm=True 時以極短合成觸發懶載入（預熱，結果丟棄），
    把模型載入時間藏在收音階段。"""
    loaded = []
    data = []
    try:
        j = requests.get(SERVER_URL + "/v1/models", timeout=8).json()
        data = j.get("data") or []
        loaded = [m.get("id") for m in data
                  if m.get("id") and m.get("loaded") is True]
    except Exception:
        loaded = []
    fams = CFG["tts"].get("tts_families") or []

    def is_tts(mid):
        return any(f.lower() in str(mid).lower() for f in fams)

    stale = [m for m in loaded if m != model and is_tts(m)]
    unload_ids(stale)

    if not warm or not model:
        return
    target_loaded = any(m.get("id") == model and m.get("loaded") is True for m in data)
    fresh = (time.time() - WARM["ts"]) < 600
    if target_loaded and fresh and WARM["model"] == model:
        return  # 已預熱過且仍載入中
    try:
        body = build_tts_body("好。")
        body["model"] = model if model in [m.get("id") for m in data] else CFG["tts"]["model"]
        requests.post(SERVER_URL + "/v1/audio/speech", json=body, timeout=180)
    except Exception:
        pass  # 預熱失敗不影響主流程；正式合成時會再報錯
    WARM["model"] = model
    WARM["ts"] = time.time()


# ------------------------------------------------------------------ 主迴圈
SERVER_KEY_ALIAS = {"cfgPath": "cfg_path", "binDir": "bin_dir",
                    "logPath": "log_path", "errLogPath": "err_log_path"}
TTS_KEY_ALIAS = {"voicePath": "voice_path", "referenceText": "reference_text"}


def apply_config(cfg):
    with LOCK:
        if "tts" in cfg:
            norm = {TTS_KEY_ALIAS.get(k, k): v for k, v in cfg["tts"].items()}
            CFG["tts"].update({k: v for k, v in norm.items() if k in CFG["tts"]})
        if "asr" in cfg:
            CFG["asr"].update({k: v for k, v in cfg["asr"].items() if k in CFG["asr"]})
        if "audio" in cfg:
            CFG["audio"].update({k: v for k, v in cfg["audio"].items() if k in CFG["audio"]})
        if "server" in cfg:
            norm = {SERVER_KEY_ALIAS.get(k, k): v for k, v in cfg["server"].items()}
            CFG["server"].update({k: v for k, v in norm.items() if k in CFG["server"]})
        snapshot = {
            "ttsModel": CFG["tts"]["model"],
            "asrModel": CFG["asr"]["model"],
            "voiceRef": CFG["tts"].get("voice_path", ""),
        }
    emit({"event": "config-ok", **snapshot})


def dispatch(msg):
    cmd = msg.get("cmd")
    if cmd == "quit":
        return False
    if cmd == "ready":
        emit({"event": "ready"})
    elif cmd == "config":
        apply_config(msg.get("config") or {})
    elif cmd == "record":
        start_record(str(msg.get("jobId") or ("r-%d" % int(time.time()))))
    elif cmd == "stop-record":
        REC["stop"].set()
    elif cmd == "speak":
        PLAYER.speak(str(msg.get("roundId") or ""), str(msg.get("sentenceId") or ""),
                     str(msg.get("text") or ""), int(msg.get("seq") or 0))
    elif cmd == "stop-playback":
        PLAYER.stop(str(msg.get("roundId") or ""))
    elif cmd == "health":
        emit({"event": "health", "alive": port_alive()})
    elif cmd == "start-server":
        threading.Thread(target=start_server, args=(str(msg.get("req") or ""),), daemon=True).start()
    elif cmd == "stop-server":
        threading.Thread(target=stop_server, args=(str(msg.get("req") or ""),), daemon=True).start()
    elif cmd == "models":
        try:
            emit({"event": "models", "ids": api_models()})
        except Exception as e:
            emit({"event": "error", "stage": "models", "message": str(e)})
    elif cmd == "ensure-single":
        try:
            ensure_single(str(msg.get("model") or ""), warm=bool(msg.get("warm")))
            emit({"event": "single-ok"})
        except Exception as e:
            emit({"event": "error", "stage": "ensure-single", "message": str(e)})
    elif cmd == "unload":
        try:
            unload_ids(list(msg.get("ids") or []))
            emit({"event": "unload-ok"})
        except Exception as e:
            emit({"event": "error", "stage": "unload", "message": str(e)})
    else:
        emit({"event": "error", "stage": "protocol", "message": "unknown cmd: %s" % cmd})
    return True


def selftest():
    """--selftest 模式：不經 stdin 迴圈，直接依序驗證 config→port→models→speak 播放。"""
    print("== selftest start", flush=True)
    apply_config({
        "tts": {"model": "qwen3-tts", "language": "chinese", "speaker": "Vivian"},
        "asr": {"model": "sense-asr", "language": "zh"},
        "audio": {},
        "server": {"exe": r"D:\.Apps\audiocpp\bin\audiocpp_server.exe",
                   "cfgPath": r"D:\.Apps\audiocpp\server.json", "port": 8081,
                   "binDir": r"D:\.Apps\audiocpp\bin",
                   "logPath": r"D:\.Apps\audiocpp\output\api_server.log",
                   "errLogPath": r"D:\.Apps\audiocpp\output\api_server.err.log",
                   "tts_families": ["qwen3-tts", "voxcpm", "omnivoice"]},
    })
    print("port_alive:", port_alive(), flush=True)
    try:
        print("models:", api_models(), flush=True)
    except Exception as e:
        print("models ERROR:", e, flush=True)
    PLAYER.speak("selftest-round", "s0", "你好，橋接測試完成。", 0)
    deadline = time.time() + 45
    while time.time() < deadline:
        ev = LAST_EVENT["event"]
        if ev in ("playback-drained", "playback-stopped"):
            break
        with PLAYER.lock:
            busy = PLAYER.active or PLAYER.expected > 0
        time.sleep(0.5)
    with PLAYER.lock:
        still = PLAYER.active or PLAYER.expected > 0 or bool(PLAYER.q)
    print("final event:", LAST_EVENT["event"], "| still-busy:", still, flush=True)
    print("== selftest done", flush=True)


def main():
    emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            emit({"event": "error", "stage": "protocol", "message": "bad json line: %s" % e})
            continue
        try:
            if not dispatch(msg):
                break
        except Exception as e:
            emit({"event": "error", "stage": "dispatch", "message": str(e)})


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        try:
            main()
        finally:
            try:
                PLAYER.stop("")
            except Exception:
                pass
