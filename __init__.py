"""Hermes 插件入口：把 skills/ 下的技能注册给 Hermes。"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKILLS_DIR = ROOT / "skills"


def register(ctx) -> None:
    for child in sorted(SKILLS_DIR.iterdir() if SKILLS_DIR.exists() else []):
        skill_md = child / "SKILL.md"
        if child.is_dir() and skill_md.exists():
            ctx.register_skill(child.name, skill_md)
