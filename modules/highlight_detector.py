import os
import bisect
from typing import List, Dict, Any, Tuple
from modules.audio_analyser import AudioAnalyser
from modules.speech_analyser import SpeechAnalyser
from modules.visual_analyser import VisualAnalyser
from modules.chat_analyser import ChatAnalyser

class HighlightDetector:
    def __init__(self,
                 audio_analyser: AudioAnalyser = None,
                 speech_analyser: SpeechAnalyser = None,
                 visual_analyser: VisualAnalyser = None,
                 chat_analyser: ChatAnalyser = None,
                 min_clip_duration: float = 42.0,
                 max_clip_duration: float = 48.0,
                 target_clip_duration: float = 45.0):
        self.audio_analyser = audio_analyser or AudioAnalyser()
        self.speech_analyser = speech_analyser or SpeechAnalyser()
        self.visual_analyser = visual_analyser or VisualAnalyser()
        self.chat_analyser = chat_analyser or ChatAnalyser()
        self.min_clip_duration = min_clip_duration
        self.max_clip_duration = max_clip_duration
        self.target_clip_duration = target_clip_duration

    def detect_highlights(
        self,
        video_path: str,
        vod_id: str = "",
        total_duration: float = 0.0,
        max_highlights: int = 5,
        min_score: float = 0.45
    ) -> List[Dict[str, Any]]:
        # 1. Audio analysis
        audio_results = self.audio_analyser.analyse_audio(video_path)

        # 2. Speech transcription & analysis
        speech_results = self.speech_analyser.transcribe(video_path)
        speech_segments = speech_results.get("segments", [])

        # 3. Visual analysis
        visual_results = self.visual_analyser.analyse_video(video_path)

        # 4. Chat analysis (if vod_id provided)
        chat_results = []
        if vod_id and total_duration > 0:
            chat_msgs = self.chat_analyser.fetch_vod_chat(vod_id)
            if chat_msgs:
                chat_results = self.chat_analyser.analyse_chat(chat_msgs, total_duration)

        # Determine effective duration
        if total_duration <= 0:
            if audio_results:
                total_duration = audio_results[-1]["timestamp"] + 1.0
            else:
                total_duration = speech_results.get("duration", 60.0)

        # 5. Composite scoring per second
        time_step = 1.0
        num_steps = int(total_duration / time_step) + 1
        timeline = []

        audio_ts = [a["timestamp"] for a in audio_results]
        visual_ts = [v["timestamp"] for v in visual_results]
        chat_ts = [c["timestamp"] for c in chat_results]

        for i in range(num_steps):
            t = i * time_step

            # Audio score
            a_idx = bisect.bisect_left(audio_ts, t)
            a_score = 0.0
            is_silent = False
            if a_idx < len(audio_results):
                a_score = audio_results[a_idx]["audio_score"]
                is_silent = audio_results[a_idx].get("is_silent", False)

            # Speech score
            s_score = 0.0
            current_sentence = None
            for seg in speech_segments:
                if seg["start"] <= t <= seg["end"]:
                    s_score = max(s_score, seg.get("speech_score", 0.0))
                    current_sentence = seg
                    break

            # Visual score
            v_idx = bisect.bisect_left(visual_ts, t)
            v_score = 0.0
            if v_idx < len(visual_results):
                v_score = visual_results[v_idx]["visual_score"]

            # Chat score
            c_score = 0.0
            if chat_results:
                c_idx = bisect.bisect_left(chat_ts, t)
                if c_idx < len(chat_results):
                    c_score = chat_results[c_idx]["chat_score"]

            # Weights
            # If chat is available: audio 0.30, speech 0.30, visual 0.25, chat 0.15
            # If chat not available: audio 0.35, speech 0.35, visual 0.30
            if chat_results:
                composite = 0.30 * a_score + 0.30 * s_score + 0.25 * v_score + 0.15 * c_score
            else:
                composite = 0.35 * a_score + 0.35 * s_score + 0.30 * v_score

            if is_silent:
                composite *= 0.2

            timeline.append({
                "timestamp": t,
                "composite_score": composite,
                "audio_score": a_score,
                "speech_score": s_score,
                "visual_score": v_score,
                "chat_score": c_score,
                "sentence": current_sentence
            })

        # 6. Find peaks & construct smart clip windows
        candidates = []
        for i in range(1, len(timeline) - 1):
            curr = timeline[i]
            if curr["composite_score"] > timeline[i-1]["composite_score"] and \
               curr["composite_score"] >= timeline[i+1]["composite_score"]:
                if curr["composite_score"] >= min_score:
                    # Strict excitement verification: reject calm/flat audio & visual
                    has_excitement = (
                        curr["audio_score"] >= 0.38 or
                        curr["visual_score"] >= 0.38 or
                        curr["speech_score"] >= 0.45
                    )
                    if has_excitement:
                        candidates.append((curr["composite_score"], curr["timestamp"]))

        # Sort candidate peaks by score descending
        candidates.sort(key=lambda x: x[0], reverse=True)

        selected_clips = []
        sentence_starts = [seg["start"] for seg in speech_segments]
        sentence_ends = [seg["end"] for seg in speech_segments]

        for peak_score, peak_time in candidates:
            # Desired window around peak targeting 45 seconds
            target_dur = self.target_clip_duration
            half_dur = target_dur / 2.0
            raw_start = max(0.0, peak_time - half_dur)
            raw_end = min(total_duration, peak_time + half_dur)

            # Ensure we take full target duration if total length allows
            if total_duration >= target_dur:
                if raw_start == 0.0:
                    raw_end = target_dur
                elif raw_end == total_duration:
                    raw_start = max(0.0, total_duration - target_dur)

            best_start = raw_start
            best_end = raw_end

            # Fine tune with sentence boundaries if within 2.5s without shortening below 42s
            for s_start in reversed(sentence_starts):
                if abs(s_start - raw_start) <= 2.5 and (best_end - s_start) >= self.min_clip_duration:
                    best_start = s_start
                    break

            for s_end in sentence_ends:
                if abs(s_end - raw_end) <= 2.5 and (s_end - best_start) <= self.max_clip_duration:
                    best_end = s_end
                    break

            # Strictly enforce 42-48s range (targeting 45 seconds)
            clip_dur = best_end - best_start
            if clip_dur < self.min_clip_duration and total_duration >= self.min_clip_duration:
                deficit = self.min_clip_duration - clip_dur
                if best_start >= deficit:
                    best_start -= deficit
                else:
                    best_end = min(total_duration, best_end + deficit)
                clip_dur = best_end - best_start
            elif clip_dur > self.max_clip_duration:
                best_end = best_start + self.max_clip_duration
                clip_dur = self.max_clip_duration

            # Check overlap with already selected clips
            is_overlap = False
            for sc in selected_clips:
                # if intersection > 5 seconds
                overlap_start = max(best_start, sc["start"])
                overlap_end = min(best_end, sc["end"])
                if overlap_end - overlap_start > 5.0:
                    is_overlap = True
                    break

            if not is_overlap:
                # Gather words and segments in this clip
                clip_segments = [seg for seg in speech_segments if seg["start"] >= best_start and seg["end"] <= best_end]
                clip_text = " ".join([seg["text"] for seg in clip_segments])

                selected_clips.append({
                    "start": round(best_start, 2),
                    "end": round(best_end, 2),
                    "duration": round(clip_dur, 2),
                    "peak_time": round(peak_time, 2),
                    "highlight_score": round(peak_score, 3),
                    "text": clip_text,
                    "segments": clip_segments,
                    "score_breakdown": {
                        "peak_score": round(peak_score, 3),
                        "audio_weight": 0.35,
                        "speech_weight": 0.35,
                        "visual_weight": 0.30
                    }
                })

            if len(selected_clips) >= max_highlights:
                break

        return selected_clips

