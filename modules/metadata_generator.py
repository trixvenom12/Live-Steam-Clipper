import re
import random
from typing import Dict, Any, List, Optional, Tuple

MANDATORY_HASHTAGS = "#shorts #gtavi #gta6"

class MetadataGenerator:
    def __init__(self, target_region: str = "UK"):
        self.target_region = target_region
        self.used_titles = set()

    def generate_metadata(
        self,
        transcript_text: str,
        streamer_name: str,
        vod_title: str,
        highlight_score: float = 0.8
    ) -> Dict[str, Any]:
        """
        Generates unique, context-rich YouTube Shorts metadata (Title, Description, Tags)
        including streamer name, event context, and tags.
        """
        title = self._generate_title(transcript_text, streamer_name, vod_title)
        title = self.enforce_title_rules(title)

        description = self._generate_description(transcript_text, streamer_name, vod_title)
        tags = self._generate_tags(transcript_text, streamer_name, vod_title)

        return {
            "title": title,
            "description": description,
            "tags": tags
        }

    def _generate_title(self, text: str, streamer_name: str, vod_title: str) -> str:
        text_lower = text.strip().lower()
        clean_speech = re.sub(r"[^a-zA-Z0-9\s]", "", text).strip()
        speech_words = clean_speech.split()

        title_candidates = []

        # Quote / speech based with streamer
        if 2 <= len(speech_words) <= 7:
            quote = " ".join(speech_words[:6]).capitalize()
            title_candidates.append(f'{streamer_name}: "{quote}" 😭')
            title_candidates.append(f'{streamer_name} Screamed At This GTA 6 Moment 😭')

        # Context: Police / Chase
        if any(w in text_lower for w in ["cop", "police", "arrest", "siren", "wanted", "chase"]):
            title_candidates.extend([
                f"{streamer_name} vs The Most INSANE GTA 6 Police Chase 😭",
                f"{streamer_name} Trying To Escape The GTA 6 Cops 💀",
                f"The GTA 6 Police Are Too Aggressive ({streamer_name}) 🚨",
                f"{streamer_name} Got A 5-Star Wanted Level in GTA 6 😭"
            ])
        # Context: NPCs / AI behavior
        elif any(w in text_lower for w in ["npc", "pedestrian", "guy", "person", "walk", "glitch", "bug", "ai"]):
            title_candidates.extend([
                f"{streamer_name} Found The Funniest GTA 6 NPC 😭",
                f"This GTA 6 NPC Had Beef With {streamer_name} 💀",
                f"GTA 6 NPCs Are Actually Terrifying ({streamer_name}) 💀",
                f"{streamer_name} Witnessed The Wildest GTA 6 AI Moment 😭"
            ])
        # Context: Car crash / physics / driving
        elif any(w in text_lower for w in ["crash", "car", "drive", "physics", "flying", "flip", "speed"]):
            title_candidates.extend([
                f"{streamer_name} Did NOT See That GTA 6 Crash Coming 💀",
                f"GTA 6 Car Physics Caught {streamer_name} Off Guard 🤯",
                f"{streamer_name} Trying To Drive in GTA 6 Vice City 😭",
                f"The Vehicle Damage In GTA 6 Broke {streamer_name} 🤯"
            ])
        # Context: Combat / deaths / explosions
        elif any(w in text_lower for w in ["die", "dead", "kill", "shot", "shoot", "explosion", "explode", "gun"]):
            title_candidates.extend([
                f"Instant Regret in GTA 6 For {streamer_name} 💀",
                f"This Escalated WAY Too Fast for {streamer_name} 😭",
                f"{streamer_name} Did NOT Expect That In GTA 6 🤯",
                f"{streamer_name}'s Funniest Death in GTA 6 😭"
            ])
        else:
            # Genuine relatable streamer reactions
            title_candidates.extend([
                f"POV: {streamer_name} Playing GTA 6 For The First Time 😭",
                f"{streamer_name} Lost His Mind At This GTA 6 Moment 😭",
                f"Average Day In GTA 6 Vice City For {streamer_name} 💀",
                f"Rockstar Cooked With This Detail ({streamer_name}) 🤯",
                f"{streamer_name} Was NOT Ready For GTA 6 Realism 💀",
                f"{streamer_name} Reacts To Insane GTA 6 Chaos 🤯"
            ])

        # Filter out titles recently used to guarantee variety
        fresh = [t for t in title_candidates if t not in self.used_titles]
        chosen = random.choice(fresh if fresh else title_candidates)
        self.used_titles.add(chosen)

        return f"{chosen} {MANDATORY_HASHTAGS}"

    def enforce_title_rules(self, title: str) -> str:
        """
        Guarantees that the title strictly ends with the exact three hashtags: #shorts #gtavi #gta6
        """
        clean_title = re.sub(r"#\w+", "", title).strip()
        max_base_len = 100 - len(MANDATORY_HASHTAGS) - 2
        if len(clean_title) > max_base_len:
            clean_title = clean_title[:max_base_len].rstrip()

        return f"{clean_title} {MANDATORY_HASHTAGS}"

    def _generate_description(self, text: str, streamer_name: str, vod_title: str) -> str:
        uk_hooks = [
            f"Absolute madness in Vice City with {streamer_name}! Watch this moment unfold.",
            f"Total scenes in GTA 6 with {streamer_name}! You genuinely couldn't make this up.",
            f"Rockstar have outdone themselves with GTA VI. {streamer_name} was not ready.",
            f"Things got completely out of hand in Vice City. Brilliant gameplay moment from {streamer_name}."
        ]
        hook = random.choice(uk_hooks)

        desc_lines = [
            hook,
            "",
            f"🎮 Creator: {streamer_name}",
            f"📺 Stream: {vod_title}",
            "",
            f"Subscribe for daily {streamer_name} GTA 6 gameplay clips, funny moments, and viral highlights!",
            "",
            "#gta6 #gtavi #gaming #shorts #twitchclips #rockstargames #ukgaming"
        ]
        return "\n".join(desc_lines)

    def _generate_tags(self, text: str, streamer_name: str, vod_title: str) -> List[str]:
        # Comprehensive tags including streamer, game, and context
        raw_tags = [
            streamer_name,
            f"{streamer_name} GTA 6",
            f"{streamer_name} funny moments",
            f"{streamer_name} clips",
            f"{streamer_name} live",
            f"{streamer_name} reaction",
            f"{streamer_name} rage",
            "GTA 6",
            "GTA VI",
            "Grand Theft Auto 6",
            "GTA 6 gameplay",
            "GTA 6 clips",
            "GTA 6 funny moments",
            "GTA 6 highlights",
            "GTA 6 Vice City",
            "GTA 6 reactions",
            "Rockstar Games",
            "Gaming Shorts",
            "YouTube Shorts",
            "Twitch clips",
            "GTA 6 UK"
        ]

        text_lower = text.lower()
        if any(w in text_lower for w in ["cop", "police", "arrest", "chase"]):
            raw_tags.extend([f"{streamer_name} police chase", "GTA 6 police chase", "GTA 6 cops", "GTA 6 5 stars"])
        if any(w in text_lower for w in ["npc", "pedestrian", "guy", "ai"]):
            raw_tags.extend([f"{streamer_name} NPC", "GTA 6 NPC interaction", "GTA 6 AI", "GTA 6 NPC glitch"])
        if any(w in text_lower for w in ["crash", "car", "drive", "physics"]):
            raw_tags.extend([f"{streamer_name} car crash", "GTA 6 car crash", "GTA 6 driving", "GTA 6 physics"])

        # Deduplicate and respect YouTube 500-char limit
        seen = set()
        deduped = []
        char_count = 0
        for tag in raw_tags:
            t = tag.strip()
            if t and t.lower() not in seen:
                if char_count + len(t) + 1 > 480:
                    break
                seen.add(t.lower())
                deduped.append(t)
                char_count += len(t) + 1

        return deduped

    def validate_metadata(self, metadata: Dict[str, Any]) -> Tuple[bool, List[str]]:
        errors = []
        title = metadata.get("title", "")
        if not title:
            errors.append("Title is empty")
        elif not title.endswith(MANDATORY_HASHTAGS):
            errors.append(f"Title must end with '{MANDATORY_HASHTAGS}'")

        desc = metadata.get("description", "")
        if not desc:
            errors.append("Description is empty")

        tags = metadata.get("tags", [])
        if not tags or not isinstance(tags, list):
            errors.append("Tags must be a non-empty list")

        return len(errors) == 0, errors
