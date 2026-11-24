#!/usr/bin/env python3
"""Render accurately shaped Arabic/English Quran overlays using Pillow + RAQM."""
from __future__ import annotations
import json
import math
import os
import sys
from pathlib import Path
from typing import Any
from PIL import Image, ImageDraw, ImageFont, features


def require_raqm() -> None:
    if not features.check("raqm"):
        raise RuntimeError(
            "Pillow was installed without libraqm/HarfBuzz support. Install a Pillow wheel "
            "with RAQM enabled; the Quran Arabic font must be shaped before rendering."
        )


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont,
               direction: str, language: str) -> float:
    return float(draw.textlength(text, font=font, direction=direction, language=language))


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont,
              max_width: int, direction: str, language: str) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = current + " " + word
        if text_width(draw, candidate, font, direction, language) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def measure_lines(draw: ImageDraw.ImageDraw, lines: list[str], font: ImageFont.FreeTypeFont,
                  direction: str, language: str, line_height: float) -> tuple[int, list[int]]:
    heights: list[int] = []
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font, direction=direction, language=language, stroke_width=1)
        heights.append(max(1, box[3] - box[1]))
    return int(math.ceil(len(lines) * line_height)), heights


def make_frame(req: dict[str, Any], segment: dict[str, Any], out_path: Path) -> dict[str, Any]:
    width = int(req["width"])
    height = int(req["height"])
    arabic_path = str(req["arabicFont"])
    english_path = str(req["englishFont"])
    arabic_text = str(segment["arabic"]).strip()
    # This font supplies the ornamental Quranic end marker and renders Arabic-Indic numerals inside it.
    ayah_num = str(segment["ayah"]).translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
    display_arabic = f"{arabic_text} ۝{ayah_num}"
    english_text = str(segment["english"]).strip()

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    max_text_width = int(width * 0.82)
    base_arabic_size = max(23, int(min(width * 0.070, height * 0.080)))
    base_english_size = max(17, int(min(width * 0.036, height * 0.040)))
    min_arabic_size = max(18, int(min(width * 0.026, height * 0.031)))
    min_english_size = max(14, int(min(width * 0.016, height * 0.020)))
    max_group_height = int(height * 0.78)

    chosen: tuple[Any, ...] | None = None
    ar_size, en_size = base_arabic_size, base_english_size
    while True:
        ar_font = ImageFont.truetype(arabic_path, ar_size, layout_engine=ImageFont.Layout.RAQM)
        en_font = ImageFont.truetype(english_path, en_size, layout_engine=ImageFont.Layout.RAQM)
        ar_lines = wrap_text(draw, display_arabic, ar_font, max_text_width, "rtl", "ar")
        en_lines = wrap_text(draw, english_text, en_font, max_text_width, "ltr", "en")
        ar_line_step = max(int(ar_size * 1.58), ar_size + 10)
        en_line_step = max(int(en_size * 1.38), en_size + 6)
        ar_height, ar_heights = measure_lines(draw, ar_lines, ar_font, "rtl", "ar", ar_line_step)
        en_height, en_heights = measure_lines(draw, en_lines, en_font, "ltr", "en", en_line_step)
        gap = max(20, int(ar_size * 0.48))
        group_height = ar_height + gap + en_height
        chosen = (ar_font, en_font, ar_lines, en_lines, ar_line_step, en_line_step, ar_heights, en_heights, group_height, gap, ar_size, en_size)
        if group_height <= max_group_height or (ar_size <= min_arabic_size and en_size <= min_english_size):
            break
        ar_size = max(min_arabic_size, ar_size - max(1, int(base_arabic_size * 0.035)))
        en_size = max(min_english_size, en_size - max(1, int(base_english_size * 0.035)))
        if ar_size == min_arabic_size and en_size == min_english_size and group_height > max_group_height:
            break

    assert chosen is not None
    ar_font, en_font, ar_lines, en_lines, ar_step, en_step, ar_heights, en_heights, group_height, gap, ar_size, en_size = chosen
    top = max(int(height * 0.045), int((height - group_height) / 2))
    center_x = width // 2
    # Gentle dark edge is useful on moving footage but leaves the reference's clean white text style intact.
    ar_stroke = max(1, int(min(width, height) * 0.0012))
    en_stroke = max(1, int(min(width, height) * 0.0010))

    y = top
    for line, line_h in zip(ar_lines, ar_heights):
        center_y = y + ar_step / 2
        draw.text((center_x, center_y), line, font=ar_font, fill=(255, 255, 255, 255),
                  anchor="mm", direction="rtl", language="ar", stroke_width=ar_stroke,
                  stroke_fill=(0, 0, 0, 190))
        y += ar_step
    y += gap
    for line, line_h in zip(en_lines, en_heights):
        center_y = y + en_step / 2
        draw.text((center_x, center_y), line, font=en_font, fill=(255, 255, 255, 255),
                  anchor="mm", direction="ltr", language="en", stroke_width=en_stroke,
                  stroke_fill=(0, 0, 0, 180))
        y += en_step

    canvas.save(out_path, format="PNG", optimize=True)
    return {
        "arabicFontSize": ar_size,
        "englishFontSize": en_size,
        "arabicLines": len(ar_lines),
        "englishLines": len(en_lines),
        "groupHeight": group_height,
        "fitsScreen": group_height <= max_group_height,
    }


def ffconcat_quote(value: str) -> str:
    # ffconcat uses single-quoted paths; escape backslashes and apostrophes.
    return value.replace("\\", "\\\\").replace("'", "'\\''")


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: render-quran-overlay.py request.json", file=sys.stderr)
        return 2
    require_raqm()
    request_path = Path(sys.argv[1]).resolve()
    req = json.loads(request_path.read_text(encoding="utf-8"))
    width, height = int(req["width"]), int(req["height"])
    duration = float(req["duration"])
    output_dir = Path(req["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    blank_path = output_dir / "blank.png"
    Image.new("RGBA", (width, height), (0, 0, 0, 0)).save(blank_path, format="PNG", optimize=True)

    segments = sorted(req.get("segments", []), key=lambda item: (float(item["start"]), float(item["end"])))
    timeline: list[tuple[Path, float]] = []
    cursor = 0.0
    layout_info: list[dict[str, Any]] = []
    for index, segment in enumerate(segments):
        start = max(0.0, min(duration, float(segment["start"])))
        end = max(start, min(duration, float(segment["end"])))
        if end - start < 0.12:
            continue
        if start > cursor + 0.02:
            timeline.append((blank_path, start - cursor))
        start = max(start, cursor)
        span = end - start
        if span < 0.12:
            continue
        frame_path = output_dir / f"ayah-{index:04d}.png"
        metrics = make_frame(req, segment, frame_path)
        timeline.append((frame_path, span))
        layout_info.append({"surah": segment.get("surah"), "ayah": segment.get("ayah"), **metrics})
        cursor = end
    if not timeline:
        raise RuntimeError("No usable Ayah segments were available to render.")
    # A transparent frame at the exact end prevents the last verse from lingering.
    # The duplicated blank also gives the concat demuxer a timestamp sentinel.
    timeline.append((blank_path, max(0.04, duration - cursor)))
    timeline.append((blank_path, 0.04))

    concat_path = output_dir / "overlay.ffconcat"
    lines = ["ffconcat version 1.0"]
    for image_path, span in timeline:
        lines.append(f"file '{ffconcat_quote(str(image_path))}'")
        # Use a 1 kHz image-demuxer clock so word-level verse times are not
        # rounded to the concat demuxer's default 25 fps (40 ms) grid.
        lines.append("option framerate 1000")
        lines.append(f"duration {max(0.001, span):.6f}")
    concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (output_dir / "layout-report.json").write_text(json.dumps(layout_info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"timeline": str(concat_path), "frames": len(layout_info), "segments": len(layout_info), "layout": layout_info}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Arabic overlay renderer failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
