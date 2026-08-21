# -*- coding: utf-8 -*-
"""
流式语音助手原型 voice_stream.py
麦克风(16k PCM 边讲边传) → Voxtral live ASR (SSE 增量转写) → 大脑(DeepSeek/DSH Agent)
→ OmniVoice/VoxCPM2 SSE 流式 TTS → 边收边播
模型共存策略（8GB 卡）：
  - omnivoice + voxtral-realtime 常驻 ≈ 6.2GB（推荐，无换载）
  - voxcpm2 真流式但 2.8GB → 与 Voxtral 不能共存，需每轮换载（慢）
用法：
  Enter 开始说话；静音 1 秒自动送出；Ctrl+C 中断本轮；/quit 退出
"""
import json
import os
import queue
import sys
import threading
import time

import numpy as np
import requests
import sounddevice as sd

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG = json.load(open(os.path.join(BASE, "assistant_config.json"), encoding="utf-8"))

# ---- .env 密钥：不放在配置文件里 ----
def _load_env(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass

_load_env(os.path.join(BASE, ".env"))

LLM = CONFIG["llm"]
if os.environ.get("DEEPSEEK_API_KEY"):
    LLM["api_key"] = os.environ["DEEPSEEK_API_KEY"]   # .env 优先于配置文件
AC = CONFIG["audio_cpp"]
# reference_text 支持 "@文件路径" 语法（如 "@reference/voicetext.txt"）
_rt = (AC.get("reference_text") or "").strip()
if _rt.startswith("@"):
    _rfp = os.path.join(BASE, _rt[1:])
    try:
        with open(_rfp, "r", encoding="utf-8") as f:
            AC["reference_text"] = f.read().strip()
    except FileNotFoundError:
        AC["reference_text"] = ""
        print("[警告] reference_text 文件不存在: %s" % _rfp)
AU = CONFIG["audio"]
MEM = CONFIG.get("memory", {"max_turns": 10})
SRV = AC["server_url"]
CLOUD = CONFIG.get("cloud_tts", {})   # 云端 TTS（目前停用，框架保留）

STREAM = {
    "asr_model": "voxtral-realtime",   # 流式 ASR（live 端点）
    "tts_model": "omnivoice",          # omnivoice=共存；voxcpm2=真流式(换载)
    "sample_rate": 16000,
    "silence_seconds": float(AU.get("silence_seconds", 1.0)),
    "min_seconds": float(AU.get("min_record_seconds", 0.6)),
    "max_seconds": float(AU.get("max_record_seconds", 30)),
    "silence_threshold": float(AU.get("silence_threshold", 0.01)),
    "keep_tags": False,                # SenseVoice 情绪/事件标签（走 CLI，非流式）
    "sentence_tts": False,             # 路B：流式大脑+逐句（长回复才划算，短回复整段更好；/stream on 开）
    "max_sentence_len": 80,            # 无标点超长句的硬切上限（字符）
    "sense_asr_gguf": "D:/.Apps/audiocpp/bin/models/SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf",
    "cli": "D:/.Apps/audiocpp/bin/audiocpp_cli.exe",
}
# 运行时锁定：优先读 assistant_config.json 的 runtime 段（定版不可调，除非改配置）
RT = CONFIG.get("runtime", {})
if RT:
    STREAM["asr_model"] = RT.get("asr_model", STREAM["asr_model"])
    STREAM["tts_model"] = RT.get("tts_model", STREAM["tts_model"])
    STREAM["sentence_tts"] = RT.get("sentence_tts", STREAM["sentence_tts"])
    STREAM["max_sentence_len"] = RT.get("max_sentence_len", STREAM["max_sentence_len"])
    STREAM["keep_tags"] = RT.get("keep_tags", STREAM["keep_tags"])
history = []
stop_flag = threading.Event()   # 用户 Enter 提前结束
mic_queue = queue.Queue()       # 录音块 → 上传线程

# ---------------- 带标签的 ASR（CLI 路径，SenseVoice keep_tags） ----------------
def cli_asr(wav_path):
    import subprocess
    p = subprocess.run(
        [STREAM["cli"], "--task", "asr", "--family", "sense_asr", "--model", STREAM["sense_asr_gguf"],
         "--backend", "cuda", "--audio", wav_path, "--audio-chunk-mode", "none",
         "--request-option", "keep_tags=true"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    if p.returncode != 0:
        raise RuntimeError("sense_asr CLI exit %s: %s" % (p.returncode, p.stderr[-300:]))
    for line in p.stdout.splitlines():
        if line.startswith("text_output="):
            return line[len("text_output="):].strip()
    return p.stdout.strip()

def save_wav(chunks, rate):
    import wave
    path = os.path.join(BASE, "output", "stream_capture_%d.wav" % int(time.time()))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(chunks))
    return path

# ---------------- 音频播放器（队列 + OutputStream 无缝） ----------------
class Player:
    def __init__(self):
        self.q = queue.Queue()
        self.rate = None
        self.stream = None
        self.lock = threading.Lock()
        self.failed = False
        self.warned = False

    def start(self, rate):
        with self.lock:
            if self.stream is not None and self.rate == rate:
                return
            # 内联关旧流（不能调 self.stop()，那会重复抢锁死锁）
            old = self.stream
            self.stream = None
            self.rate = rate
            if old is not None:
                def close_old():
                    try:
                        old.stop()
                        old.close()
                    except Exception:
                        pass
                threading.Thread(target=close_old, daemon=True).start()
            def cb(outdata, frames, t, status):
                try:
                    chunk = self.q.get(timeout=0.05)
                    if len(chunk) == len(outdata):
                        outdata[:] = chunk.reshape(-1, 1)
                    elif chunk.ndim == 1 and len(chunk) >= frames:
                        outdata[:] = chunk[:frames].reshape(-1, 1)
                    else:
                        outdata.fill(0)
                except queue.Empty:
                    outdata.fill(0)
                except Exception:
                    try:
                        outdata.fill(0)
                    except Exception:
                        pass
            # 看门狗：3 秒内打不开音频设备 → 视为无输出设备，优雅降级为纯文字
            result = {}

            def worker():
                try:
                    s = sd.OutputStream(samplerate=rate, channels=1, dtype="int16", callback=cb, blocksize=2048)
                    s.start()
                    result["s"] = s
                except Exception as e:
                    result["err"] = repr(e)

            th = threading.Thread(target=worker, daemon=True)
            th.start()
            th.join(3.0)
            if th.is_alive():
                self.stream = None
                self.failed = True
                if not self.warned:
                    self.warned = True
                    print("\n[警告] 音频输出设备无响应（3秒超时）——本轮只显示文字，不出声", flush=True)
                return
            if "err" in result:
                self.stream = None
                self.failed = True
                if not self.warned:
                    self.warned = True
                    print("\n[警告] 音频播放失败（%s）——本轮只显示文字，不出声" % result["err"], flush=True)
                return
            self.stream = result["s"]
            self.failed = False

    def feed(self, pcm: bytes, rate: int):
        if self.failed:
            return  # 无可用输出设备：静默丢弃，避免堆积
        arr = np.frombuffer(pcm, dtype=np.int16)
        if self.stream is None or self.rate != rate:
            self.start(rate)
            if self.failed:
                return
        # 大块切成 2048 帧小块（回调固定帧数，最后一块不足则补零）
        chunk = 2048
        for i in range(0, len(arr), chunk):
            seg = arr[i:i + chunk]
            if len(seg) < chunk:
                seg = np.pad(seg, (0, chunk - len(seg)))
            self.q.put(seg)

    def stop(self):
        with self.lock:
            s = self.stream
            self.stream = None
            self.rate = None
        if s is not None:
            # 等队列播完（不限时长，避免长音频被截断）；
            # 仅当 5 秒毫无进展（设备卡死/无输出）才放弃等待
            if not self.failed:
                last_size = None
                stall = 0.0
                while not self.q.empty():
                    sz = self.q.qsize()
                    if sz != last_size:
                        last_size = sz
                        stall = 0.0
                    else:
                        stall += 0.1
                    if stall >= 5.0:
                        break
                    time.sleep(0.1)
            while not self.q.empty():
                try:
                    self.q.get_nowait()
                except queue.Empty:
                    break

            def closer():
                try:
                    s.stop()
                    s.close()
                except Exception:
                    pass

            threading.Thread(target=closer, daemon=True).start()

player = Player()

# ---------------- 大脑（与 voice_assistant.py 相同逻辑） ----------------
def deepseek_chat(text):
    """DeepSeek 请求，放守护线程 + 45s 硬看门狗：永不无限卡。"""
    result = {}

    def work():
        try:
            msgs = [{"role": "system", "content": LLM["system_prompt"]}]
            msgs += history[-MEM["max_turns"] * 2:]
            msgs.append({"role": "user", "content": text})
            r = requests.post(LLM["base_url"].rstrip("/") + "/chat/completions",
                              headers={"Authorization": "Bearer " + LLM["api_key"]},
                              json={"model": LLM["model"], "messages": msgs,
                                    "temperature": LLM["temperature"], "max_tokens": LLM["max_tokens"]},
                              timeout=40)
            if r.status_code == 401:
                result["ok"] = "DeepSeek API Key 無效或未填。"
                return
            if r.status_code == 429:
                result["ok"] = "大脑响应被限流（429），请稍后再试。"
                return
            r.raise_for_status()
            result["ok"] = r.json()["choices"][0]["message"]["content"].strip()
        except Exception as e:
            result["err"] = e

    th = threading.Thread(target=work, daemon=True)
    th.start()
    th.join(45)
    if th.is_alive():
        return None  # 超时信号
    if "err" in result:
        raise result["err"]
    return result["ok"]

def agent_chat(text):
    import subprocess
    hist = "\n".join(("%s: %s" % ("用户" if t["role"] == "user" else "小音", t["content"]))
                     for t in history[-MEM["max_turns"] * 2:])
    task = (LLM["system_prompt"] + "\n\n以下是最近对话历史：\n" + (hist or "（无）")
            + "\n\n【新的语音输入】\n" + text + "\n\n请直接输出简短口语化的回答，不要 markdown。")
    p = subprocess.run(["node", LLM["dsh_cli"], "--profile", LLM["dsh_profile"], task],
                       cwd=LLM.get("dsh_workspace") or BASE, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=LLM.get("dsh_timeout_sec", 600))
    if p.returncode != 0:
        raise RuntimeError("agent exit %s" % p.returncode)
    lines = [l for l in p.stdout.splitlines() if l.strip()]
    if not lines:
        raise RuntimeError("agent 无输出")
    return lines[-1].strip()

def think(text):
    mode = LLM.get("mode", "dsh")
    if mode == "dsh":
        try:
            return agent_chat(text)
        except Exception as e:
            print("[Agent失败 %s] %s" % (type(e).__name__, e))
            if LLM.get("fallback_to_deepseek", True):
                print("[回退 DeepSeek...]")
                return deepseek_chat(text)
            return "抱歉，大脑调用失败。"
    reply = deepseek_chat(text)
    if reply is None:
        print("[大脑超时（45秒无响应），已放弃本次思考]", flush=True)
        return "我这边大脑有点卡，没来得及想好。你可以再说一次吗？"
    return reply

# ---------------- 流式大脑：DeepSeek SSE + 逐句切分 ----------------
SENT_SPLIT = __import__("re").compile(r"[^。！？!?；;\n]+[。！？!?；;\n]+")

def deepseek_stream(text, sink):
    """DeepSeek 流式输出：每个完整句子回调 sink(句子)。"""
    msgs = [{"role": "system", "content": LLM["system_prompt"]}]
    msgs += history[-MEM["max_turns"] * 2:]
    msgs.append({"role": "user", "content": text})
    r = requests.post(LLM["base_url"].rstrip("/") + "/chat/completions",
                      headers={"Authorization": "Bearer " + LLM["api_key"]},
                      json={"model": LLM["model"], "messages": msgs,
                            "temperature": LLM["temperature"], "max_tokens": LLM["max_tokens"],
                            "stream": True},
                      stream=True, timeout=90)
    if r.status_code != 200:
        raise RuntimeError("流式大脑 HTTP %s: %s" % (r.status_code, r.text[:150]))
    buf = ""
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        d = line[6:]
        if d == "[DONE]":
            break
        try:
            delta = json.loads(d)["choices"][0]["delta"].get("content") or ""
        except Exception:
            continue
        buf += delta
        # 按句子切分：完整句子立即吐出；不完整的留在 buf
        consumed = 0
        for m in SENT_SPLIT.finditer(buf):
            sent = m.group(0).strip()
            if sent:
                sink(sent)
            consumed = m.end()
        buf = buf[consumed:]
        # 硬切：无标点且超过上限 → 强制成句（防止超长句一直缓冲）
        if len(buf) > STREAM.get("max_sentence_len", 80):
            sink(buf.strip())
            buf = ""
    if buf.strip():
        sink(buf.strip())  # 尾巴（无标点收尾）

def sentence_turn(text):
    """路B真·流式：大脑边想边吐 → 合成线程预取下一句 → 播放循环连续播。
    合成与播放重叠（播第 N 句时第 N+1 句已在合成），句间无缝。"""
    full = []
    sent_q = queue.Queue()
    audio_q = queue.Queue()

    def brain():
        try:
            deepseek_stream(text, lambda s: sent_q.put(("S", s)))
            sent_q.put(("END", None))
        except Exception as e:
            sent_q.put(("ERR", e))

    def synth_worker():
        while True:
            kind, payload = sent_q.get()
            if kind == "END":
                audio_q.put(("END", None))
                return
            if kind == "ERR":
                audio_q.put(("ERR", payload))
                return
            sent = (payload or "").strip()
            if not sent:
                continue
            full.append(sent)
            print("小音: %s" % sent, flush=True)
            try:
                pcm, rate = synth_audio(sent)
                audio_q.put(("A", (pcm, rate)))
            except Exception as e:
                audio_q.put(("ERR", e))
                return

    threading.Thread(target=brain, daemon=True).start()
    threading.Thread(target=synth_worker, daemon=True).start()

    # 播放循环：一个持续输出流，句与句之间不关流（无缝）
    while True:
        kind, payload = audio_q.get()
        if kind == "END":
            break
        if kind == "ERR":
            print("\n[合成失败: %s] 中断播放" % payload, flush=True)
            break
        pcm, rate = payload
        player.feed(pcm, rate)
        # 播放线程已在流内排队，主循环继续取下一句 → 预取生效
    player.stop()
    return "".join(full)

# ---------------- 流式 ASR（live 端点） ----------------
def stream_asr(record_gen, finalize_event):
    """record_gen: 迭代器产出 16k s16le 块；finalize_event 置位后发送终止块。
    返回 (完整转录, 增量回调) 由调用方用迭代器消费 SSE。"""
    url = ("%s/v1/audio/transcriptions/live?model=%s&sample_rate=%d&channels=1&sample_format=s16le"
           % (SRV, STREAM["asr_model"], STREAM["sample_rate"]))
    r = requests.post(url, data=record_gen, stream=True, timeout=300)
    r.raise_for_status()
    full = []
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        d = line[6:]
        if d == "[DONE]":
            break
        try:
            j = json.loads(d)
            t = j.get("type")
            if t == "transcript.text.delta" and j.get("delta"):
                full.append(j["delta"])
                print("\r[转写] " + "".join(full)[-60:], end="", flush=True)
            elif t == "transcript.text.done" and j.get("text"):
                return j["text"].strip()
        except Exception:
            pass
    return "".join(full).strip()

# ---------------- TTS（流式 SSE / 离线整段 / 云端 三模式） ----------------
OFFLINE_TTS_MODELS = ("qwen3-tts", "qwen3-tts-base", "qwen3-tts-06b-base",
                      "qwen3-tts-06b-base-bf16", "qwen3-tts-voicedesign")

def _ref_mime(path):
    """按文件内容识别参考音 MIME（不能只看扩展名）。"""
    try:
        with open(path, "rb") as f:
            head = f.read(12)
    except Exception:
        return "audio/wav"
    if head[:4] == b"RIFF":
        return "audio/wav"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xe3"):
        return "audio/mpeg"
    ext = os.path.splitext(path)[1].lower()
    return {"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
            "m4a": "audio/mp4", "flac": "audio/flac"}.get(ext, "audio/wav")

def _decode_audio(audio):
    """把云端返回的音频字节解码成 (int16 PCM, rate, channels)。支持 WAV / MP3 / 原始 PCM。"""
    if audio[:4] == b"RIFF":
        import wave
        import io
        with wave.open(io.BytesIO(audio), "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            frames = w.readframes(w.getnframes())
        arr = np.frombuffer(frames, dtype=np.int16)
        return arr, rate, ch
    is_mp3 = audio[:3] == b"ID3" or audio[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xe3")
    if is_mp3:
        # 用 ffmpeg 解码成 24k mono PCM（机器上已有 ffmpeg）
        import subprocess
        p = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "24000", "pipe:1"],
            input=audio, capture_output=True, timeout=60)
        if p.returncode != 0 or not p.stdout:
            raise RuntimeError("ffmpeg 解码 mp3 失败: %s" % p.stderr[-200:])
        return np.frombuffer(p.stdout, dtype=np.int16), 24000, 1
    # 原始 PCM
    return np.frombuffer(audio, dtype=np.int16), 24000, 1

def cloud_tts(text):
    if CLOUD.get("provider", "openrouter") == "fish":
        return fish_tts(text)
    return openrouter_tts(text)

def fish_tts(text):
    """Fish Audio 原生 API：latency=balanced（~300ms 首音）+ reference_id（上传一次，最快）或 references（即时克隆）。"""
    key = CLOUD.get("api_key") or ""
    if not key:
        raise RuntimeError("Fish API key 未配置（assistant_config.json cloud_tts.api_key）——去 https://fish.audio/app/api-keys 拿")
    body = {"text": text,
            "format": CLOUD.get("response_format", "mp3"),
            "latency": CLOUD.get("latency", "balanced"),
            "chunk_length": 150}
    vid = CLOUD.get("voice_id") or ""
    if vid:
        body["reference_id"] = vid          # 已上传音色：最快路径
    elif AC.get("voice_ref"):
        # 即时克隆：带参考音频 base64 + 转录
        import base64 as b64
        with open(AC["voice_ref"], "rb") as f:
            data = b64.b64encode(f.read()).decode()
        refs = [{"audio": data, "text": AC.get("reference_text") or ""}]
        body["references"] = refs
    headers = {"Authorization": "Bearer " + key,
               "Content-Type": "application/json",
               "model": CLOUD.get("model", "s2.1-pro")}
    r = requests.post(CLOUD.get("base_url", "https://api.fish.audio").rstrip("/") + "/v1/tts",
                      json=body, headers=headers, timeout=90)
    if r.status_code != 200:
        raise RuntimeError("Fish TTS HTTP %s: %s" % (r.status_code, r.text[:200]))
    audio = r.content
    if not audio:
        raise RuntimeError("Fish TTS 返回空音频")
    arr, rate, ch = _decode_audio(audio)
    if ch > 1:
        arr = arr.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return arr.tobytes(), rate

def openrouter_tts(text):
    """OpenRouter 云端 TTS（OpenAI 兼容），支持 input_references 无状态克隆（Fish Audio）。"""
    key = CLOUD.get("openrouter_api_key") or ""
    if not key:
        raise RuntimeError("OpenRouter key 未配置（assistant_config.json cloud_tts.openrouter_api_key）")
    body = {"model": CLOUD.get("model", "fish-audio/s2.1-pro:free"),
            "input": text,
            "response_format": CLOUD.get("response_format", "mp3")}
    if AC.get("voice_ref"):
        # 无状态克隆：参考音频 base64（按内容识别 MIME）+ 可选转录
        import base64 as b64
        try:
            with open(AC["voice_ref"], "rb") as f:
                data = b64.b64encode(f.read()).decode()
            mime = _ref_mime(AC["voice_ref"])
        except Exception as e:
            print("[云TTS] 读取参考音失败: %s，改用预设音色" % e)
            data = None
        if data:
            refs = [{"type": "input_audio", "input_audio": {"data": "data:%s;base64,%s" % (mime, data)}}]
            if AC.get("reference_text"):
                refs.append({"type": "text", "text": AC["reference_text"]})
            body["input_references"] = refs
    r = requests.post(CLOUD.get("base_url", "https://openrouter.ai/api/v1").rstrip("/") + "/audio/speech", json=body,
                      headers={"Authorization": "Bearer " + key}, timeout=90)
    if r.status_code != 200:
        raise RuntimeError("云端TTS HTTP %s: %s" % (r.status_code, r.text[:200]))
    audio = r.content
    if not audio:
        raise RuntimeError("云端TTS返回空音频")
    arr, rate, ch = _decode_audio(audio)
    if ch > 1:
        arr = arr.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return arr.tobytes(), rate

def synth_audio(text):
    """合成一句 → (int16 PCM bytes, rate)。不播放（由调用方播放/排队）。"""
    model = STREAM["tts_model"]
    if CLOUD.get("enabled"):
        try:
            return cloud_tts(text)
        except Exception as e:
            print("[云TTS失败: %s] 回退本地TTS..." % e, flush=True)
    body = {"model": model, "input": text, "language": AC["tts_language"]}
    if AC.get("voice_ref"):
        body["voice_ref"] = AC["voice_ref"]
        if AC.get("reference_text"):
            body["reference_text"] = AC["reference_text"]
    if model in OFFLINE_TTS_MODELS:
        r = requests.post(SRV + "/v1/audio/speech", json=body, timeout=300)
        r.raise_for_status()
        wav = r.content
        if not wav:
            raise RuntimeError("TTS 未返回音频")
        import wave
        import io
        with wave.open(io.BytesIO(wav), "rb") as w:
            rate = w.getframerate()
            ch = w.getnchannels()
            frames = w.readframes(w.getnframes())
        arr = np.frombuffer(frames, dtype=np.int16)
        if ch > 1:
            arr = arr.reshape(-1, ch).mean(axis=1).astype(np.int16)
        return arr.tobytes(), rate
    # 流式 SSE 路径：收集所有增量 → 返回整段 PCM
    body["response_format"] = "pcm"
    body["stream_format"] = "sse"
    if model == "voxcpm2":
        body["options"] = {"retry_badcase": False}
    r = requests.post(SRV + "/v1/audio/speech", json=body,
                      headers={"Accept": "text/event-stream"}, stream=True, timeout=300)
    r.raise_for_status()
    chunks = []
    got_audio = False
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        d = line[6:]
        if d == "[DONE]":
            break
        try:
            j = json.loads(d)
            if j.get("type") == "speech.audio.delta":
                payload = j.get("data") or j.get("audio")
                if payload:
                    import base64
                    chunks.append(base64.b64decode(payload))
                    got_audio = True
        except Exception:
            pass
    if not got_audio:
        raise RuntimeError("TTS 未返回音频")
    return b"".join(chunks), 24000

def stream_tts(text):
    """整段：合成 → 播完（非流式路径用）。"""
    pcm, rate = synth_audio(text)
    player.feed(pcm, rate)
    player.stop()

# ---------------- 录音（块生成器 + 本地 VAD） ----------------
def mic_record():
    """生成 16k s16le 块；本地 VAD 静音判句尾；finalize 后结束上传。"""
    sr = STREAM["sample_rate"]
    dev_in = AU.get("input_device")
    block = int(sr * 0.1)
    quiet = 0.0
    started = time.time()
    total_spoken = 0.0
    stop_flag.clear()
    print("[录音中，静音 %.0fs 自动送出，最长 %.0fs] (Ctrl+C 中断本轮)" % (STREAM["silence_seconds"], STREAM["max_seconds"]), flush=True)

    def cb(indata, frames, t, status):
        mic_queue.put(indata.copy())

    with sd.InputStream(device=dev_in, samplerate=sr, channels=1, dtype="int16", blocksize=block, callback=cb):
        while True:
            try:
                data = mic_queue.get(timeout=0.1)
            except queue.Empty:
                data = None
            if data is None:
                if stop_flag.is_set() or time.time() - started > STREAM["max_seconds"]:
                    break
                continue
            rms = float(np.sqrt(np.mean(data.astype(np.float32) ** 2)) / 32768.0)
            if rms < STREAM["silence_threshold"]:
                quiet += 0.1
            else:
                quiet = 0.0
                total_spoken += 0.1
            if quiet >= STREAM["silence_seconds"] and total_spoken >= STREAM["min_seconds"]:
                break
            if stop_flag.is_set() or time.time() - started > STREAM["max_seconds"]:
                break
            yield data.tobytes()

def file_record(path):
    """测试模式：把 wav 重采样成 16k s16le 逐块喂给 live ASR（不等待、无 VAD）。"""
    import wave
    w = wave.open(path, "rb")
    sr = w.getframerate()
    data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    w.close()
    tgt = STREAM["sample_rate"]
    idx = np.linspace(0, len(data) - 1, int(len(data) * tgt / sr)).astype(int)
    data16 = data[idx].astype(np.int16)
    bs = int(tgt * 0.1)
    for i in range(0, len(data16), bs):
        yield data16[i:i + bs].tobytes()

# ---------------- 主循环 ----------------
def main():
    file_mode = None
    if "--file" in sys.argv:
        i = sys.argv.index("--file")
        if i + 1 < len(sys.argv):
            file_mode = sys.argv[i + 1]
    print("=" * 56)
    print("  流式語音助手原型  |  ASR: %s + TTS: %s + 大腦: %s" % (
        STREAM["asr_model"], "云端" + CLOUD.get("model", "") if CLOUD.get("enabled") else STREAM["tts_model"],
        LLM.get("mode", "deepseek")))
    if AC.get("voice_ref"):
        print("  克隆音色: %s" % AC["voice_ref"])
    if STREAM["keep_tags"]:
        print("  情绪/事件标签: ON（SenseVoice keep_tags）")
    if file_mode:
        print("  文件测试模式: %s" % file_mode)
    else:
        # 按当前启用的功能动态提示（隐藏未启用的命令）
        hints = ["Enter 開始說話"]
        if AC.get("voice_ref"):
            hints.append("/voice <wav> 換參考音")
        if STREAM.get("sentence_tts", True):
            hints.append("/stream off 改整段")
        if CLOUD.get("enabled"):
            hints.append("/cloudtts off 停云端")
        if STREAM.get("keep_tags"):
            hints.append("/tags off 停标签")
        print("  " + "；".join(hints))
    print("=" * 56)
    try:
        while True:
            cmd = input("\n>>> 按 Enter 開始說話 (/quit 退出): ").strip()
            if cmd.startswith("/"):
                c = cmd.split(maxsplit=1)
                if c[0] == "/quit":
                    break
                elif c[0] == "/new":
                    history.clear()
                    print("[記憶已清空]")
                elif c[0] == "/voice" and len(c) > 1:
                    src = c[1]
                    if not os.path.isfile(src):
                        print("[错误] 找不到文件: %s" % src)
                        continue
                    if any(ord(ch) > 127 for ch in src):
                        import shutil
                        outdir = os.path.join(BASE, "output")
                        os.makedirs(outdir, exist_ok=True)
                        dst = os.path.join(outdir, "stream_voice_%d.wav" % int(time.time()))
                        shutil.copy2(src, dst)
                        print("[中文路径已自动复制为: %s]" % dst)
                        src = dst
                    AC["voice_ref"] = src
                    print("[克隆音色 = %s]（流式TTS将用此参考音）" % src)
                elif c[0] == "/voicetext" and len(c) > 1:
                    AC["reference_text"] = c[1]
                    print("[参考转录已设置]")
                elif c[0] == "/novoice":
                    AC["voice_ref"] = ""
                    AC["reference_text"] = ""
                    print("[已清除克隆，回到模型默认声音]")
                elif c[0] == "/stream" and len(c) > 1 and c[1] in ("on", "off"):
                    STREAM["sentence_tts"] = (c[1] == "on")
                    print("[逐句流式 = %s]（on: 大脑边想边播，首音更快）" % c[1])
                elif c[0] == "/cloudtts" and len(c) > 1 and c[1] in ("on", "off"):
                    CLOUD["enabled"] = (c[1] == "on")
                    print("[云端TTS = %s]（%s；需 assistant_config.json 填 cloud_tts.api_key）" % (
                        c[1], CLOUD.get("model", "")))
                elif c[0] == "/tags" and len(c) > 1 and c[1] in ("on", "off"):
                    STREAM["keep_tags"] = (c[1] == "on")
                    print("[情绪/事件标签 = %s]（开标签时 ASR 走 CLI，SenseVoice 输出 <|HAPPY|> 等）" % c[1])
                elif c[0] == "/tts" and len(c) > 1:
                    STREAM["tts_model"] = c[1]
                    print("[TTS模型 = %s]（流式: omnivoice/voxcpm2；离线稳定: qwen3-tts-06b-base / qwen3-tts-base）" % c[1])
                elif c[0] == "/asr" and len(c) > 1:
                    STREAM["asr_model"] = c[1]
                    print("[流式ASR模型 = %s]" % c[1])
                continue
            # 一轮：流式 ASR（边讲边出字）
            try:
                print("[流式识别中...]", flush=True)
                t0 = time.time()
                if STREAM["keep_tags"]:
                    # 标签模式：录完整句 → CLI 转写（SenseVoice keep_tags）
                    print("[标签模式录音中...]", flush=True)
                    t0 = time.time()
                    chunks = []
                    if file_mode:
                        for ch in file_record(file_mode):
                            chunks.append(ch)
                    else:
                        for ch in mic_record():
                            chunks.append(ch)
                    wav_path = save_wav(chunks, STREAM["sample_rate"])
                    text = cli_asr(wav_path)
                    print("\n[识别完成 %.1fs] 你 说: %s" % (time.time() - t0, text))
                else:
                    source = file_record(file_mode) if file_mode else mic_record()
                    text = stream_asr(source, stop_flag)
                    print("\n[识别完成 %.1fs] 你 说: %s" % (time.time() - t0, text))
                if not text:
                    print("[没识别到内容]")
                    continue
                if STREAM.get("sentence_tts") and LLM.get("mode", "deepseek") == "deepseek":
                    # 路B：流式大脑，每句立刻合成播放（首音更快）
                    print("[流式大脑思考中...]", flush=True)
                    reply = sentence_turn(text)
                else:
                    print("[大脑思考中...]", flush=True)
                    reply = think(text)
                    print("小音说: %s" % reply, flush=True)
                    stream_tts(reply)
                if reply:
                    history.append({"role": "user", "content": text})
                    history.append({"role": "assistant", "content": reply})
            except KeyboardInterrupt:
                stop_flag.set()
                print("\n[本轮取消]")
                continue
            except Exception as e:
                stop_flag.set()
                print("\n[错误] %s" % e)
    except KeyboardInterrupt:
        stop_flag.set()
        print("\n再见！")

if __name__ == "__main__":
    main()
