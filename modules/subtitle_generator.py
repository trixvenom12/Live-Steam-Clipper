import os
from typing import List, Dict, Any

class SubtitleGenerator:
    def __init__(self, font_name: str = "Arial", font_size: int = 22, primary_color: str = "&H00FFFFFF", highlight_color: str = "&H0000FFFF"):
        self.font_name = font_name
        self.font_size = font_size
        self.primary_color = primary_color      # White in ASS &HAABBGGRR
        self.highlight_color = highlight_color  # Bright Yellow &H0000FFFF

    def generate_ass(self, segments: List[Dict[str, Any]], clip_start_offset: float, output_ass_path: str) -> bool:
        """
        Creates ASS subtitle file with punchy, high-contrast, Shorts-safe captions.
        """
        header = f"""[Script Info]
Title: GTA 6 Shorts Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Shorts,Arial,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,5,3,2,60,60,650,1
Style: ShortsHighlight,Arial,68,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,105,105,2,0,1,6,4,2,60,60,650,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
        events = []

        # Process words into short 2-4 word punchy phrases
        all_words = []
        for seg in segments:
            words = seg.get("words", [])
            if words:
                all_words.extend(words)
            else:
                # If word-level is missing, use segment
                all_words.append({
                    "word": seg.get("text", ""),
                    "start": seg.get("start", 0),
                    "end": seg.get("end", 0)
                })

        # Group words into chunks of 3-4 words for dynamic reading
        chunk_size = 3
        for i in range(0, len(all_words), chunk_size):
            chunk = all_words[i : i + chunk_size]
            if not chunk:
                continue

            start_t = max(0.0, chunk[0]["start"] - clip_start_offset)
            end_t = max(0.0, chunk[-1]["end"] - clip_start_offset)

            if end_t <= start_t:
                end_t = start_t + 1.2

            start_ass = self._format_ass_time(start_t)
            end_ass = self._format_ass_time(end_t)

            words_text = [w["word"].strip() for w in chunk]
            combined_text = " ".join(words_text).upper()

            # Clean and escape ASS characters
            combined_text = combined_text.replace("{", "").replace("}", "")

            events.append(f"Dialogue: 0,{start_ass},{end_ass},Shorts,,0,0,0,,{combined_text}")

        content = header + "\n".join(events) + "\n"

        with open(output_ass_path, "w", encoding="utf-8") as f:
            f.write(content)

        return os.path.exists(output_ass_path)

    @staticmethod
    def _format_ass_time(seconds: float) -> str:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = int(seconds % 60)
        cs = int(round((seconds - int(seconds)) * 100))
        if cs >= 100:
            cs = 99
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

